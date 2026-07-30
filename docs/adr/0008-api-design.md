# 0008. tRPC as the API layer

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

The only consumer of the API is our own React dashboard, in the same repository and the
same deployment. There is no third-party integration and no mobile client. PROJECT.md
specifies tRPC over Next.js Route Handlers.

## Problem

How is the API structured so that authorization, CSRF, rate limiting, validation, and
error mapping are applied uniformly rather than remembered per endpoint?

## Alternatives considered

**REST route handlers.** Familiar and cacheable at the HTTP layer, but types would have to
be maintained by hand or generated, and there is no consumer that needs REST's
interoperability. Every endpoint would re-implement session lookup and error mapping.

**Next.js Server Actions only.** Excellent for mutations and progressive enhancement, and
we would reach for them for a form-heavy app. But the dashboard is read-heavy with
client-driven filtering, polling, and pagination — exactly what TanStack Query is for — and
Server Actions have no story for cached, keyed, deduplicated client reads.

**GraphQL.** Solves over-fetching for diverse clients we do not have, at the cost of a
schema, resolvers, and query-complexity concerns. Overengineering here.

**tRPC v11** (chosen), with Server Components calling the service layer directly for
initial payloads so the first render costs no HTTP round trip.

## Decision

One route handler at `app/api/trpc/[trpc]/route.ts`, and a procedure hierarchy that makes
the safe thing the default:

- **`publicProcedure`** — base. Structured error mapping and request logging only.
- **`protectedProcedure`** — resolves the session cookie, loads the user, injects
  `ctx.user`. Throws `UNAUTHORIZED` when absent, so no procedure body ever checks
  authentication.
- **`mutationProcedure`** — `protectedProcedure` plus CSRF header verification plus rate
  limiting. Every mutation uses this; a mutation on `protectedProcedure` is a lint-visible
  mistake.

Routers mirror feature slices — `auth`, `emails`, `sync`, `analytics` — and each lives in
its feature directory as `router.ts`, composed by `server/trpc/root.ts`. Procedures stay
thin: validate input, authorize, delegate to a service, shape the response. Business logic
does not live in routers, so it remains callable from Server Components and job handlers.

**Authorization is enforced in the data layer, not just the procedure.** Every repository
function that reads or writes user-scoped data takes a `userId` and includes it in the
`where` clause. There is no `getEmailById(id)` — only
`getEmailForUser({ userId, emailId })`. This makes it structurally impossible for a
missing check in a router to expose another user's mail.

**Errors** are typed application errors (`AppError` subclasses carrying a code, an
HTTP-ish status, and a user-safe message). An `errorFormatter` maps them to tRPC codes and
returns only the safe message; unrecognised errors become a generic
`INTERNAL_SERVER_ERROR` with the detail logged server-side and a correlation id returned
to the client. Stack traces and provider messages never reach the browser.

**Every input and output is a Zod schema.** Client types are inferred from the router type,
never declared twice. Pagination is cursor-based (`receivedAt`, `id`) for the email list —
stable under concurrent inserts, which offset pagination is not — with offset pagination
only where the UI genuinely needs numbered pages.

**Rate limiting** is a fixed-window counter keyed on `userId` plus procedure path, applied
to mutations and to the expensive AI endpoints. The implementation sits behind a
`RateLimiter` interface with an in-memory default, so a Redis-backed limiter can replace it
without touching procedures. The in-memory limiter is per-instance and therefore
approximate on serverless — documented, and the correct trade-off until it isn't.

## Trade-offs

tRPC couples client and server types, which is the benefit and also means the API is not
consumable by anything outside this repository; exposing a public API later would mean
adding REST handlers over the same services, which the service layer already permits.
HTTP-level caching is limited compared with REST, mitigated per ADR 0010. Cursor pagination
costs the UI the ability to jump to page N on the email list, which is a reasonable
exchange for stable paging.

## Consequences

- Authentication, CSRF, and rate limiting cannot be forgotten on a mutation.
- Cross-user data access is prevented at the query level, not by convention.
- Renaming a field surfaces as a compile error in the UI.
- Services are reusable from Server Components, cron handlers, and tests.
