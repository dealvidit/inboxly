# 0010. Caching strategy

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

The dashboard is read-heavy. Stat widgets aggregate over a user's whole mailbox, the email
list is paged and filtered, and sync status is polled while a run is in progress. All data
is per-user and private, so nothing is shareable between users or cacheable in a CDN.

## Problem

Where should caching live, and what should deliberately *not* be cached?

## Alternatives considered

**Redis in front of every query.** Real gains for the aggregate widgets, but it adds
infrastructure, a second consistency model, and invalidation logic to a system whose
queries are already indexed and sub-100ms. Premature.

**Aggressive Next.js `unstable_cache` / route-segment caching on dashboard routes.**
Tempting, and wrong for authenticated per-user views: a cache key that omits the user is a
data-leak bug, and the correctness risk outweighs the saved milliseconds.

**Materialised view for the stat widgets.** Would help at a mailbox size we do not have,
and adds refresh scheduling.

**Layered client-side caching with correct database indexes and no server cache**
(chosen).

## Decision

Caching is applied at the layer closest to the consumer, and only where it changes the
experience.

**Client (TanStack Query)** is the primary cache:

- Email lists: `staleTime` 30s, keyed on the full filter/sort/cursor tuple, with
  `placeholderData` retained across pages so pagination does not flash empty.
- Stat widgets: `staleTime` 60s.
- Sync status: polled at 3s **only while a run is active**, and not polled at all
  otherwise — an interval that stops is as important as one that starts.
- Mutations invalidate precisely the affected query keys rather than resetting the cache.

**Server:**

- Dashboard Server Components fetch their initial payload directly from services and use
  React's per-request `cache()` for request-scoped deduplication. That is deduplication,
  not caching — nothing survives the request.
- All dynamic authenticated routes declare `dynamic = 'force-dynamic'`, making
  "not cached" explicit rather than dependent on framework defaults.
- No cross-request caching of user data. This is a deliberate constraint, not an omission.
- Google's JWKS for ID token verification *is* cached in memory with a TTL: it is public,
  slow-changing, and fetched on the login path.

**Database** is where read performance is actually bought: covering indexes for the list
query, a GIN index on the search vector, and a partial index for the processing-claim
predicate. Aggregate widgets use a single grouped query rather than one query per widget.

## Trade-offs

Aggregate widgets recompute per request; measured against realistic data volumes this is
cheap, and the tipping point (a mailbox where the grouped aggregate exceeds ~100ms) is the
signal to revisit. We give up CDN caching entirely, which is correct for private data. The
in-memory JWKS cache is per-instance, so cold instances pay one extra fetch.

## Consequences

- No cache-invalidation bugs and no risk of serving one user's data to another.
- No cache infrastructure to operate.
- Perceived performance comes from client-side caching and optimistic UI.
- If load ever justifies a server cache, the repository layer is the seam to add it at.
