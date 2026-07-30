# API

Two surfaces: a tRPC API for the dashboard, and a handful of route handlers for things
that cannot be tRPC procedures — OAuth redirects, cron triggers, and health.

Design rationale: [ADR 0008](./adr/0008-api-design.md).

## tRPC

One endpoint, `POST|GET /api/trpc/[trpc]`, with `superjson` as the transformer — so
`Date` survives the wire and arrives as a `Date`, not a string the caller must remember
to parse.

### Procedure levels

| Level                | Guarantees                                        |
| -------------------- | ------------------------------------------------- |
| `publicProcedure`    | Error mapping and request logging                 |
| `protectedProcedure` | + a resolved session; injects non-null `ctx.user` |
| `mutationProcedure`  | + CSRF verification + rate limiting               |

Every mutation uses `mutationProcedure`. Because `protectedProcedure` injects a non-null
user, no procedure body checks authentication, and none can forget to.

### Routes

#### `me` — query, public

Returns `{ user: AuthenticatedUser | null }`. Used by the client to decide what to render
before any protected call is made.

#### `emails.list` — query

Input (all optional except where noted):

| Field         | Type                                                                                 | Default  | Notes                                                   |
| ------------- | ------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------- |
| `view`        | `inbox`, `needs-reply`, `important`, `meetings`, `finance`, `personal`, `promotions` | `inbox`  | A named preset over the same filters                    |
| `search`      | string ≤ 200                                                                         | —        | Full-text over subject, sender, snippet, and AI summary |
| `category`    | `EmailCategory`                                                                      | —        | Combines with the view rather than replacing it         |
| `urgency`     | `LOW`…`CRITICAL`                                                                     | —        |                                                         |
| `unreadOnly`  | boolean                                                                              | `false`  |                                                         |
| `from` / `to` | Date                                                                                 | —        | Inclusive bounds on `receivedAt`                        |
| `sort`        | `newest`, `oldest`, `urgency`                                                        | `newest` | `urgency` implies "has been analysed"                   |
| `limit`       | 1–100                                                                                | `25`     |                                                         |
| `cursor`      | string                                                                               | —        | Opaque; from the previous response                      |

Returns `{ items, nextCursor }`. `nextCursor` is `null` on the last page.

Pagination is keyset on `(receivedAt, id)`, not offset: new mail arrives at the top, so
offset paging would repeat rows as pages shift. The `id` tiebreaker matters — bulk mail
routinely shares a timestamp to the millisecond.

Search is the exception and uses offset paging, because its sort key is a computed
relevance rank with no stable column to page on.

#### `emails.byId` — query

`{ id: uuid }` → the email with its analysis. `NOT_FOUND` when it does not exist **or
belongs to another user** — the two are deliberately indistinguishable.

#### `emails.thread` — query

`{ gmailThreadId: string }` → every message in the conversation, oldest first.

#### `emails.markRead` — mutation

`{ id: uuid }` → `{ ok: true }`. Local only; Gmail remains the authority and the next
sync reconciles.

#### `sync.status` — query

Connection state, whether a run is in progress, the latest run, and the queue depth.

#### `sync.runNow` — mutation

Runs a synchronization. `CONFLICT` when one is already running — a second concurrent run
would duplicate API calls, since the first holds the checkpoint.

#### `sync.analyzeNow` — mutation

Runs one analysis batch. Returns `{ claimed, completed, failed, retrying, hasMoreWork }`.

#### `sync.disconnect` — mutation

Revokes the Google grant, clears stored credentials, and signs the user out everywhere —
a disconnected account should not stay browsable from another device.

#### `analytics.dashboard` — query

Every widget in one round trip: counts by processing status, needs-reply count, average
processing latency, category breakdown, sync state, and the latest run.

`isSyncing` is what the client uses to decide whether to poll at all.

### Errors

| tRPC code               | When                                                  |
| ----------------------- | ----------------------------------------------------- |
| `UNAUTHORIZED`          | No session                                            |
| `FORBIDDEN`             | CSRF token missing or mismatched                      |
| `NOT_FOUND`             | No such record, or it belongs to another user         |
| `CONFLICT`              | Conflicts with current state (a sync already running) |
| `TOO_MANY_REQUESTS`     | Rate limited                                          |
| `BAD_REQUEST`           | Input failed Zod validation                           |
| `INTERNAL_SERVER_ERROR` | Anything unrecognised                                 |

The response body carries only a user-safe message, plus:

```json
{
  "appCode": "CONFLICT",
  "requestId": "…",
  "validationIssues": [{ "path": "limit", "message": "…" }]
}
```

`requestId` correlates the client-visible error with its server log entry. Stack traces,
provider messages, and internal identifiers never cross the boundary.

### CSRF

Mutations require an `x-csrf-token` header matching the `inboxly_csrf` cookie
(double-submit). The browser client sends it on every request automatically, so no call
site has to remember. A missing token fails — it is not treated as "nothing to compare".

### Rate limiting

Fixed-window, 30 mutations per minute per user per procedure. The default implementation
is in-memory and therefore per-instance, which makes the effective limit approximate on a
scaled deployment; it sits behind a `RateLimiter` interface so a shared-state
implementation can replace it without touching procedures.

## Route handlers

| Route                       | Method    | Auth           | Purpose                                                                                   |
| --------------------------- | --------- | -------------- | ----------------------------------------------------------------------------------------- |
| `/api/auth/google/start`    | GET       | —              | Begins OAuth. `?reconnect=1` forces consent; `?return_to=` accepts same-origin paths only |
| `/api/auth/callback/google` | GET       | `state` cookie | Completes OAuth, issues the session                                                       |
| `/api/auth/logout`          | POST      | Session + CSRF | Revokes the session server-side                                                           |
| `/api/trpc/[trpc]`          | GET, POST | Per procedure  | The tRPC API                                                                              |
| `/api/jobs/sync`            | POST      | `CRON_SECRET`  | Scheduled synchronization                                                                 |
| `/api/jobs/analyze`         | POST      | `CRON_SECRET`  | Scheduled analysis                                                                        |
| `/api/health`               | GET       | —              | Liveness and readiness                                                                    |

### Job endpoints

Authenticate with `Authorization: Bearer $CRON_SECRET` or `x-cron-secret`, compared in
constant time. Both are idempotent, so an at-least-once scheduler is safe.

```bash
curl -X POST https://your-domain.com/api/jobs/analyze \
  -H "Authorization: Bearer $CRON_SECRET"
```

### Health

`200` with `{"status":"ok"}` when the database is reachable, `503` with
`{"status":"degraded"}` when it is not. Gmail and Anthropic are deliberately not checked:
they are per-user and credential-dependent, and their failure does not mean this
deployment is unhealthy. Their health is visible in `sync_runs` and `analysis_attempts`.
