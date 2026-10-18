# Engineering Decisions

## Assumptions (would confirm with a PM)
Roles are per team (viewer < member < lead < admin). Workflow: open → in_progress → awaiting_approval → resolved → closed; only Leads (or Admins) of the item's team approve or send back from `awaiting_approval`; resolved can be reopened; closed is terminal. Anyone who is a member+ can claim an unassigned item; only Leads reassign. Users outside a team get 404 (existence is not leaked), insufficient role gets 403.

## 1. Data model and history
**Context:** History must never disagree with the item. **Options:** app-level audit after update; DB triggers; same-transaction insert. **Choice:** every mutation writes an `activity_events` row in the *same transaction* as the change (and outbox row if needed). **Trade-off:** slightly more code per endpoint vs. triggers' hidden logic; gains atomicity and actor context. Comments reuse the same table to keep one timeline.

## 2. Concurrency control
**Context:** double claims, stale edits, racing transitions. **Options:** pessimistic locks everywhere; optimistic versioning; conditional updates. **Choice:** claim = `UPDATE … WHERE assignee_id IS NULL`; edits = `WHERE version = $client` (409 returns the latest item); transitions take `SELECT … FOR UPDATE` since validity depends on current status. **Trade-off:** clients must handle 409, but no long-held locks and no lost updates.

## 3. Authorization model
**Context:** hidden buttons are not security. **Choice:** one `authorize(user, teamId, minRole)` function called by every endpoint after loading the item; list queries are filtered by the user's team ids in SQL; per-transition minimum roles live in the workflow map. **Trade-off:** memberships are loaded per request (one indexed query) rather than cached in the token, so role changes apply immediately.

## 4. Idempotency and async work
**Context:** retries/double-clicks, and notifications must not be lost or duplicated. **Choice:** `Idempotency-Key` row is inserted inside the create transaction (`ON CONFLICT DO NOTHING`; a concurrent duplicate blocks until the first commits, then replays the stored response). Notifications use a transactional outbox; the worker claims jobs with `FOR UPDATE SKIP LOCKED`, retries with exponential backoff up to 5 attempts, and the handler is idempotent via a unique `outbox_id`. **Trade-off:** polling latency (~2s) and at-least-once semantics versus the complexity of a broker.

## 5. Search and pagination at scale
**Context:** tens of thousands of items, growing history. **Choice:** server-side filters, keyset pagination on `id DESC` (stable under inserts, no OFFSET cost), composite/partial indexes matching dashboard views, a generated `tsvector` column with GIN for search. **Trade-off:** ordering is by id, not by custom sort; at 10× I would add read replicas, partition `activity_events`, and consider a search engine.

## Not built
Email, attachments, SSO, websockets, optimistic UI, user management screens.
