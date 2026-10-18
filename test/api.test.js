process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://ops:ops@localhost:5432/ops_test';
process.env.TOKEN_SECRET = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { pool, migrate } = require('../src/db');
const { sign, hashPassword } = require('../src/auth');
const { processOnce, MAX_ATTEMPTS } = require('../src/worker');
const app = require('../src/app');

const U = {}, T = {};
const as = (name) => ({ Authorization: 'Bearer ' + sign({ uid: U[name], exp: Date.now() + 1e6 }) });
const mk = (headers, extra = {}) => request(app).post('/items').set(headers).send({ title: 'T', type: 'task', priority: 'urgent', team_id: T.a, ...extra });

before(async () => {
  await migrate();
  await pool.query('TRUNCATE users,teams,memberships,work_items,activity_events,idempotency_keys,outbox,notifications RESTART IDENTITY CASCADE');
  for (const t of ['a', 'b']) T[t] = (await pool.query('INSERT INTO teams(name) VALUES($1) RETURNING id', [t])).rows[0].id;
  const users = { m1: [T.a, 'member'], m2: [T.a, 'member'], lead: [T.a, 'lead'], viewer: [T.a, 'viewer'], other: [T.b, 'member'] };
  for (const [n, [t, r]] of Object.entries(users)) {
    U[n] = (await pool.query('INSERT INTO users(email,name,password_hash) VALUES($1,$1,$2) RETURNING id', [n, hashPassword('x')])).rows[0].id;
    await pool.query('INSERT INTO memberships VALUES($1,$2,$3)', [U[n], t, r]);
  }
});
after(() => pool.end());

test('concurrent claim: exactly one wins', async () => {
  const item = (await mk(as('m1'))).body;
  const rs = await Promise.all(['m1', 'm2', 'lead', 'm1', 'm2'].map(u => request(app).post(`/items/${item.id}/claim`).set(as(u))));
  assert.strictEqual(rs.filter(r => r.status === 200).length, 1);
  assert.strictEqual(rs.filter(r => r.status === 409).length, 4);
});

test('stale version update rejected, data unchanged', async () => {
  const item = (await mk(as('m1'))).body;
  const ok = await request(app).patch(`/items/${item.id}`).set(as('m1')).send({ version: 1, priority: 'low' });
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.version, 2);
  const stale = await request(app).patch(`/items/${item.id}`).set(as('m2')).send({ version: 1, priority: 'high' });
  assert.strictEqual(stale.status, 409); assert.strictEqual(stale.body.current.priority, 'low');
});

test('same Idempotency-Key creates one item and replays response', async () => {
  const h = { ...as('m1'), 'Idempotency-Key': 'k1' };
  const rs = await Promise.all([mk(h, { title: 'idem' }), mk(h, { title: 'idem' }), mk(h, { title: 'idem' })]);
  assert.ok(rs.every(r => r.status === 201 && r.body.id === rs[0].body.id));
  assert.strictEqual((await pool.query("SELECT count(*) FROM work_items WHERE title='idem'")).rows[0].count, '1');
});

test('workflow: invalid jump rejected; approval only by Lead', async () => {
  const item = (await mk(as('m1'))).body;
  assert.strictEqual((await request(app).post(`/items/${item.id}/transition`).set(as('m1')).send({ to: 'closed' })).status, 422);
  await request(app).post(`/items/${item.id}/transition`).set(as('m1')).send({ to: 'in_progress' });
  await request(app).post(`/items/${item.id}/transition`).set(as('m1')).send({ to: 'awaiting_approval' });
  assert.strictEqual((await request(app).post(`/items/${item.id}/transition`).set(as('m1')).send({ to: 'resolved' })).status, 403);
  assert.strictEqual((await request(app).post(`/items/${item.id}/transition`).set(as('lead')).send({ to: 'resolved' })).status, 200);
});

test('authorization: other team blocked, viewer cannot write, list is scoped', async () => {
  const item = (await mk(as('m1'))).body;
  assert.strictEqual((await request(app).get(`/items/${item.id}`).set(as('other'))).status, 404);
  assert.strictEqual((await request(app).post(`/items/${item.id}/claim`).set(as('other'))).status, 404);
  assert.strictEqual((await request(app).post(`/items/${item.id}/claim`).set(as('viewer'))).status, 403);
  assert.strictEqual((await mk(as('other'))).status, 404);
  assert.strictEqual((await request(app).get('/items?limit=100').set(as('other'))).body.items.length, 0);
});

test('history recorded for every change, in order', async () => {
  const item = (await mk(as('m1'))).body;
  await request(app).post(`/items/${item.id}/claim`).set(as('m1'));
  await request(app).post(`/items/${item.id}/transition`).set(as('m1')).send({ to: 'in_progress' });
  await request(app).post(`/items/${item.id}/comments`).set(as('m1')).send({ text: 'hi' });
  const kinds = (await request(app).get(`/items/${item.id}/activity`).set(as('viewer'))).body.map(e => e.kind);
  assert.deepStrictEqual(kinds, ['created', 'assignee_changed', 'status_changed', 'comment']);
});

test('cursor pagination returns disjoint, descending pages', async () => {
  const p1 = (await request(app).get('/items?limit=3').set(as('m1'))).body;
  const p2 = (await request(app).get(`/items?limit=3&cursor=${p1.nextCursor}`).set(as('m1'))).body;
  assert.ok(p1.items.every(a => p2.items.every(b => a.id !== b.id)) && p1.items.at(-1).id > p2.items[0].id);
});

test('outbox: duplicate processing notifies once; failing job retries then fails', async () => {
  await pool.query('TRUNCATE outbox,notifications');
  const item = (await mk(as('m1'))).body;
  await request(app).patch(`/items/${item.id}`).set(as('lead')).send({ version: 1, assignee_id: U.m2 });
  await processOnce(pool);
  await pool.query("UPDATE outbox SET status='pending'"); await processOnce(pool); // duplicate delivery
  assert.strictEqual((await pool.query('SELECT count(*) FROM notifications')).rows[0].count, '1');
  await pool.query("INSERT INTO outbox(topic,payload) VALUES('boom','{}')");
  for (let i = 0; i < MAX_ATTEMPTS; i++) { await processOnce(pool); await pool.query("UPDATE outbox SET run_after=now() WHERE topic='boom'"); }
  const j = (await pool.query("SELECT status,attempts FROM outbox WHERE topic='boom'")).rows[0];
  assert.deepStrictEqual([j.status, j.attempts], ['failed', MAX_ATTEMPTS]);
});
