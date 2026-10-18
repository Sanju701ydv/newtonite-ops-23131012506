const crypto = require('crypto');
const { pool } = require('./db');
const SECRET = () => process.env.TOKEN_SECRET || 'dev-secret';
class HttpError extends Error { constructor(status, msg, extra = {}) { super(msg); this.status = status; this.extra = extra; } }
const hashPassword = (pw, salt = crypto.randomBytes(8).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const checkPassword = (pw, h) => { const [s] = h.split(':'); const a = Buffer.from(hashPassword(pw, s)), b = Buffer.from(h); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sign = (p) => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET()).update(b).digest('base64url'); };
function verify(t) {
  const [b, s] = (t || '').split('.');
  if (!b || !s || crypto.createHmac('sha256', SECRET()).update(b).digest('base64url') !== s) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p : null;
}
async function authenticate(req, _res, next) {
  try {
    const p = verify((req.headers.authorization || '').replace('Bearer ', ''));
    if (!p) throw new HttpError(401, 'Not authenticated');
    const { rows } = await pool.query('SELECT team_id, role FROM memberships WHERE user_id=$1', [p.uid]);
    req.user = { id: p.uid, roles: Object.fromEntries(rows.map(r => [r.team_id, r.role])) };
    next();
  } catch (e) { next(e); }
}
// Single permission function used by every endpoint. Outsider -> 404 (don't leak existence); weak role -> 403.
const RANK = { viewer: 1, member: 2, lead: 3, admin: 4 };
function authorize(user, teamId, minRole) {
  const role = user.roles[teamId];
  if (!role) throw new HttpError(404, 'Not found');
  if (RANK[role] < RANK[minRole]) throw new HttpError(403, `Requires ${minRole} role`);
  return role;
}
module.exports = { HttpError, hashPassword, checkPassword, sign, authenticate, authorize, RANK };
