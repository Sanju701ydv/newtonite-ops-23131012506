// Transactional-outbox worker: SKIP LOCKED claim, retry with backoff, max attempts, idempotent handler.
const MAX_ATTEMPTS = 5;
const handlers = {
  // unique(outbox_id) makes this idempotent: processing twice yields one notification
  notify_assignee: (c, job) => c.query(
    'INSERT INTO notifications(outbox_id,user_id,item_id,message) VALUES($1,$2,$3,$4) ON CONFLICT (outbox_id) DO NOTHING',
    [job.id, job.payload.user_id, job.payload.item_id, `You were assigned: ${job.payload.title}`]),
};
async function processOnce(pool) {
  const c = await pool.connect();
  let n = 0;
  try {
    for (;;) {
      await c.query('BEGIN');
      const { rows } = await c.query("SELECT * FROM outbox WHERE status='pending' AND run_after<=now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED");
      if (!rows[0]) { await c.query('COMMIT'); return n; }
      const job = rows[0];
      try {
        if (!handlers[job.topic]) throw new Error('No handler for ' + job.topic);
        await handlers[job.topic](c, job);
        await c.query("UPDATE outbox SET status='done',attempts=attempts+1 WHERE id=$1", [job.id]);
      } catch (e) {
        const attempts = job.attempts + 1;
        await c.query("UPDATE outbox SET attempts=$2,last_error=$3,status=$4,run_after=now()+($5||' seconds')::interval WHERE id=$1",
          [job.id, attempts, e.message, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', String(2 ** attempts)]);
      }
      await c.query('COMMIT'); n++;
    }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
module.exports = { processOnce, MAX_ATTEMPTS };
