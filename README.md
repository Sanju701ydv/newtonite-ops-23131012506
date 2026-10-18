# Operations Under Pressure — Newtonite Software Engineering Challenge

An internal web app to create, assign, track and resolve operational work items across teams. Team-scoped roles
(viewer / member / lead / admin), a server-enforced workflow with a Lead-only approval gate, an append-only activity
log, and a filtered dashboard backed by server-side search and cursor pagination.

**Stack:** Node.js 20 + Express, PostgreSQL 16, vanilla-JS frontend, `node:test` + Supertest. Docker Compose for setup.

## Run (one command)
Prerequisite: Docker with Compose.
```bash
docker compose up --build
# open http://localhost:3000
```
The app container migrates the schema, seeds 3 teams, 10 users and 20,000 items (first run only), starts the API and the outbox worker.

## Demo logins (password for all: `password123`)
| Email | Roles |
|---|---|
| admin@ops.test | admin on all teams |
| lead.pay@ops.test | lead — Payments |
| lead.sup@ops.test | lead — Support, member — Compliance |
| lead.comp@ops.test | lead — Compliance |
| member1@ops.test | member — Payments, Support |
| member2@ops.test | member — Payments |
| member3@ops.test | member — Support |
| member4@ops.test | member — Compliance |
| viewer@ops.test | viewer — Payments, Support |
| outsider@ops.test | viewer — Compliance only (try opening Payments items: 404) |

## Tests
```bash
docker compose up -d db
docker compose exec db psql -U ops -c "CREATE DATABASE ops_test"
npm install
TEST_DATABASE_URL=postgres://ops:ops@localhost:5432/ops_test npm test
```
Covers: concurrent claim (exactly one wins), stale-version update (409, data unchanged), idempotency key (parallel duplicates → one item),
invalid transition and non-Lead approval rejected, cross-team 404 / viewer 403, history ordering, pagination, outbox idempotency and retry-then-fail.

## API
`POST /login` · `GET /me` · `GET /items?view=&status=&priority=&type=&team=&assignee=&q=&cursor=&limit=` · `POST /items` (`Idempotency-Key` header) ·
`GET|PATCH /items/:id` (PATCH needs `version`) · `POST /items/:id/claim` · `POST /items/:id/transition {to, version?}` · `POST|GET /items/:id/comments|activity`

## Architecture
```mermaid
flowchart LR
  B[Browser] -->|REST + bearer token| API[Express API]
  API -->|tx: item + activity + outbox| PG[(PostgreSQL)]
  W[Outbox worker] -->|SKIP LOCKED poll, retries| PG
```
Permissions live in one function (`authorize` in `src/auth.js`); the workflow map lives in `src/workflow.js`.

## Known limitations
- Comments are stored as `comment` activity events (no edit/delete); there is no separate comments table.
- Token auth is a minimal HMAC-signed token (no refresh/revocation); passwords use scrypt. Use a real IdP in production.
- Frontend is deliberately plain: no optimistic UI (it refetches), and "create" uses a prompt with defaults.
- Seed items assign some sample assignees without regard to team membership (pagination demo only).
- Worker handler only writes a `notifications` row; no email/push delivery.
- Polling/refetch instead of websockets. Activity table is not partitioned.
- Rate limiting and token revocation are not implemented.

## Next week I would…
Optimistic UI with rollback tests, a real comments table, Playwright E2E, role-management screens, partition `activity_events` by month, rate limiting, OpenAPI docs.
