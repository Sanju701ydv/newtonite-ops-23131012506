const { pool, migrate } = require('./db');
const app = require('./app');
const { processOnce } = require('./worker');
(async () => {
  await migrate();
  setInterval(() => processOnce(pool).catch(e => console.error('worker', e.message)), 2000);
  app.listen(process.env.PORT || 3000, () => console.log('Listening on :' + (process.env.PORT || 3000)));
})();
