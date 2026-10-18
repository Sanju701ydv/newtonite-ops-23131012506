const express = require('express');
const path = require('path');
const { pool, tx } = require('./db');
const { HttpError, checkPassword, sign, authenticate, authorize } = require('./auth');
const { TRANSITIONS, TYPES, PRIORITIES } = require('./workflow');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const log = (c, itemId, actor, kind, data = {}) =>
  c.query('INSERT INTO activity_events(item_id,actor_id,kind,data) VALUES($1,$2,$3,$4)', [itemId, actor, kind, data]);
const enqueueNotify = (c, item, actor) => item.assignee_id && item.assignee_id !== actor &&
  c.query('INSERT INTO outbox(topic,payload) VALUES($1,$2)', ['notify_assignee', { item_id: item.id, user_id: item.assignee_id, title: item.title }]);
const conflict = async (c, id) => new HttpError(409, 'Item changed, reload', { current: (await c.query('SELECT * FROM work_items WHERE id=$1', [id])).rows[0] });
const getItem = async (c, id, lock = false) => {
  const { rows } = await c.query(`SELECT * FROM work_items WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Not found');
  return rows[0];
};

app.post('/login', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [req.body.email]);
  if (!rows[0] || !checkPassword(req.body.password || '', rows[0].password_hash)) throw new HttpError(401, 'Bad credentials');
  res.json({ token: sign({ uid: rows[0].id, exp: Date.now() + 12 * 3600e3 }), name: rows[0].name });
}));

app.use(authenticate);

app.get('/me', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT u.id,u.name,u.email FROM users u WHERE id=$1', [req.user.id]);
  const teams = await pool.query('SELECT t.id,t.name,m.role FROM memberships m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1', [req.user.id]);
  res.json({ ...rows[0], teams: teams.rows });
}));

app.get('/teams/:id/members', wrap(async (req, res) => {
  authorize(req.user, +req.params.id, 'viewer');
  const { rows } = await pool.query('SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1', [+req.params.id]);
  res.json(rows);
}));

// Server-side filtering, full-text search and keyset (cursor) pagination, always scoped to the user's teams.
app.get('/items', wrap(async (req, res) => {
  const q = req.query, teamIds = Object.keys(req.user.roles).map(Number);
  const leadTeams = teamIds.filter(t => ['lead', 'admin'].includes(req.user.roles[t]));
  const p = [teamIds], w = ['team_id = ANY($1)'];
  const add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + p.length)); };
  if (q.view === 'assigned') add('assignee_id = ?', req.user.id);
  if (q.view === 'unassigned_urgent') w.push("assignee_id IS NULL AND priority='urgent' AND status NOT IN ('resolved','closed')");
  if (q.view === 'awaiting_approval') { add('team_id = ANY(?)', leadTeams); w.push("status='awaiting_approval'"); }
  if (q.status) add('status = ?', q.status);
  if (q.priority) add('priority = ?', q.priority);
  if (q.type) add('type = ?', q.type);
  if (q.team) add('team_id = ?', +q.team);
  if (q.assignee) add('assignee_id = ?', +q.assignee);
  if (q.q) add("tsv @@ plainto_tsquery('english', ?)", q.q);
  if (q.cursor) add('id < ?', +q.cursor);
  const limit = Math.min(+q.limit || 25, 100);
  const { rows } = await pool.query(`SELECT * FROM work_items WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ${limit + 1}`, p);
  const more = rows.length > limit; if (more) rows.pop();
  res.json({ items: rows, nextCursor: more ? rows[rows.length - 1].id : null });
}));

// Create — idempotent via Idempotency-Key; key claim, item, event share one transaction.
app.post('/items', wrap(async (req, res) => {
  const b = req.body, key = req.headers['idempotency-key'];
  authorize(req.user, +b.team_id, 'member');
  if (!b.title?.trim() || !TYPES.includes(b.type) || !PRIORITIES.includes(b.priority)) throw new HttpError(400, 'Invalid title/type/priority');
  const out = await tx(async (c) => {
    if (key) {
      const ins = await c.query('INSERT INTO idempotency_keys(key,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING key', [key, req.user.id]);
      if (!ins.rows[0]) { // key already committed by another request (the conflicting insert waits for it)
        const prev = await c.query('SELECT status_code,response FROM idempotency_keys WHERE key=$1 AND user_id=$2', [key, req.user.id]);
        return { status: prev.rows[0].status_code, body: prev.rows[0].response, replay: true };
      }
    }
    const { rows } = await c.query(
      'INSERT INTO work_items(title,description,type,priority,team_id,created_by,due_date) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [b.title.trim(), b.description || '', b.type, b.priority, b.team_id, req.user.id, b.due_date || null]);
    await log(c, rows[0].id, req.user.id, 'created', { priority: b.priority, status: 'open' });
    if (key) await c.query('UPDATE idempotency_keys SET status_code=201, response=$3 WHERE key=$1 AND user_id=$2', [key, req.user.id, rows[0]]);
    return { status: 201, body: rows[0] };
  });
  if (out.replay) res.set('Idempotent-Replay', 'true');
  res.status(out.status).json(out.body);
}));

app.get('/items/:id', wrap(async (req, res) => {
  const item = await getItem(pool, +req.params.id);
  authorize(req.user, item.team_id, 'viewer');
  res.json(item);
}));

// Optimistic locking: UPDATE ... WHERE version = client's version.
app.patch('/items/:id', wrap(async (req, res) => {
  const b = req.body, id = +req.params.id;
  if (!Number.isInteger(b.version)) throw new HttpError(400, 'version is required');
  const item = await tx(async (c) => {
    const cur = await getItem(c, id);
    authorize(req.user, cur.team_id, 'member');
    if (b.assignee_id !== undefined && b.assignee_id !== cur.assignee_id) {
      authorize(req.user, cur.team_id, 'lead'); // reassigning needs Lead
      if (b.assignee_id !== null) {
        const m = await c.query('SELECT 1 FROM memberships WHERE user_id=$1 AND team_id=$2 AND role<>$3', [b.assignee_id, cur.team_id, 'viewer']);
        if (!m.rows[0]) throw new HttpError(400, 'Assignee must be a non-viewer member of the team');
      }
    }
    if (b.priority && !PRIORITIES.includes(b.priority)) throw new HttpError(400, 'Invalid priority');
    const next = { title: b.title ?? cur.title, description: b.description ?? cur.description, priority: b.priority ?? cur.priority,
      due_date: b.due_date === undefined ? cur.due_date : b.due_date, assignee_id: b.assignee_id === undefined ? cur.assignee_id : b.assignee_id };
    const { rows } = await c.query(
      `UPDATE work_items SET title=$1,description=$2,priority=$3,due_date=$4,assignee_id=$5,version=version+1,updated_at=now()
       WHERE id=$6 AND version=$7 RETURNING *`,
      [next.title, next.description, next.priority, next.due_date, next.assignee_id, id, b.version]);
    if (!rows[0]) throw await conflict(c, id);
    if (cur.priority !== next.priority) await log(c, id, req.user.id, 'priority_changed', { from: cur.priority, to: next.priority });
    if (cur.assignee_id !== next.assignee_id) { await log(c, id, req.user.id, 'assignee_changed', { from: cur.assignee_id, to: next.assignee_id }); await enqueueNotify(c, rows[0], req.user.id); }
    if (cur.title !== next.title || cur.description !== next.description) await log(c, id, req.user.id, 'edited');
    return rows[0];
  });
  res.json(item);
}));

// Atomic claim: only one concurrent caller can flip assignee from NULL.
app.post('/items/:id/claim', wrap(async (req, res) => {
  const id = +req.params.id;
  const item = await tx(async (c) => {
    const cur = await getItem(c, id);
    authorize(req.user, cur.team_id, 'member');
    const { rows } = await c.query('UPDATE work_items SET assignee_id=$1,version=version+1,updated_at=now() WHERE id=$2 AND assignee_id IS NULL RETURNING *', [req.user.id, id]);
    if (!rows[0]) throw await conflict(c, id);
    await log(c, id, req.user.id, 'assignee_changed', { from: null, to: req.user.id, via: 'claim' });
    return rows[0];
  });
  res.json(item);
}));

app.post('/items/:id/transition', wrap(async (req, res) => {
  const id = +req.params.id, to = req.body.to;
  const item = await tx(async (c) => {
    const cur = await getItem(c, id, true); // row lock serialises concurrent transitions
    authorize(req.user, cur.team_id, 'member');
    if (req.body.version !== undefined && req.body.version !== cur.version) throw await conflict(c, id);
    const minRole = TRANSITIONS[cur.status]?.[to];
    if (!minRole) throw new HttpError(422, `Transition ${cur.status} -> ${to} is not allowed`);
    authorize(req.user, cur.team_id, minRole);
    const { rows } = await c.query('UPDATE work_items SET status=$1,version=version+1,updated_at=now() WHERE id=$2 RETURNING *', [to, id]);
    await log(c, id, req.user.id, 'status_changed', { from: cur.status, to });
    return rows[0];
  });
  res.json(item);
}));

app.post('/items/:id/comments', wrap(async (req, res) => {
  const cur = await getItem(pool, +req.params.id);
  authorize(req.user, cur.team_id, 'member');
  if (!req.body.text?.trim()) throw new HttpError(400, 'Empty comment');
  await log(pool, cur.id, req.user.id, 'comment', { text: req.body.text.trim() });
  res.status(201).json({ ok: true });
}));

app.get('/items/:id/activity', wrap(async (req, res) => {
  const cur = await getItem(pool, +req.params.id);
  authorize(req.user, cur.team_id, 'viewer');
  const { rows } = await pool.query('SELECT a.*,u.name AS actor FROM activity_events a JOIN users u ON u.id=a.actor_id WHERE item_id=$1 ORDER BY a.id', [cur.id]);
  res.json(rows);
}));

app.use((err, _req, res, _next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error', ...(err.extra || {}) });
});
module.exports = app;
