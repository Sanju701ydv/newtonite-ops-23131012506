const { pool, migrate } = require('./db');
const { hashPassword } = require('./auth');
(async () => {
  await migrate();
  if ((await pool.query('SELECT 1 FROM users LIMIT 1')).rows[0]) { console.log('Already seeded'); return pool.end(); }
  for (const t of ['Payments', 'Support', 'Compliance']) await pool.query('INSERT INTO teams(name) VALUES($1)', [t]);
  const users = [ // [email, name, [[teamId, role]...]]
    ['admin@ops.test', 'Alice Admin', [[1, 'admin'], [2, 'admin'], [3, 'admin']]],
    ['lead.pay@ops.test', 'Priya Lead (Payments)', [[1, 'lead']]],
    ['lead.sup@ops.test', 'Sam Lead (Support)', [[2, 'lead'], [3, 'member']]],
    ['member1@ops.test', 'Mia Member', [[1, 'member'], [2, 'member']]],
    ['member2@ops.test', 'Max Member', [[1, 'member']]],
    ['member3@ops.test', 'Nia Member', [[2, 'member']]],
    ['member4@ops.test', 'Omar Member', [[3, 'member']]],
    ['viewer@ops.test', 'Vik Viewer', [[1, 'viewer'], [2, 'viewer']]],
    ['lead.comp@ops.test', 'Cara Lead (Compliance)', [[3, 'lead']]],
    ['outsider@ops.test', 'Olive Outsider', [[3, 'viewer']]],
  ];
  const pw = hashPassword('password123');
  for (const [email, name, ms] of users) {
    const { rows } = await pool.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id', [email, name, pw]);
    for (const [t, r] of ms) await pool.query('INSERT INTO memberships VALUES($1,$2,$3)', [rows[0].id, t, r]);
  }
  // assignee ids 4..7 are member1..member4; they may not belong to the item's team in sample data (fine for pagination demo)
  await pool.query(`
    INSERT INTO work_items(title,description,type,priority,status,team_id,assignee_id,created_by,due_date,created_at)
    SELECT 'Sample item #'||g || CASE WHEN g%7=0 THEN ' payment gateway timeout' ELSE ' routine follow-up' END,
      'Auto-generated operational work item '||g,
      (ARRAY['incident','customer_issue','payment','compliance','task'])[1+g%5],
      (ARRAY['low','medium','high','urgent'])[1+(g*7)%4],
      (ARRAY['open','in_progress','awaiting_approval','resolved','closed'])[1+(g*3)%5],
      1+g%3, CASE WHEN g%3=0 THEN NULL ELSE 4+(g%4) END, 4, CURRENT_DATE + (g%30), now() - (g||' minutes')::interval
    FROM generate_series(1,20000) g`);
  await pool.query("INSERT INTO activity_events(item_id,actor_id,kind,data) SELECT id,created_by,'created','{}' FROM work_items");
  console.log('Seeded 3 teams, 10 users, 20000 items'); await pool.end();
})();
