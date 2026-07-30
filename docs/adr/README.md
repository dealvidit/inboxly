# Architecture Decision Records

Each record captures one decision, the situation that forced it, what else was
considered, and what we gave up by choosing it. Records are immutable in intent: when a
decision changes, the record is updated with a `Status` of `Superseded by NNNN` rather
than being rewritten as if the original reasoning never happened.

| ID | Title | Status |
| --- | --- | --- |
| [0001](./0001-overall-architecture.md) | Overall architecture: modular monolith in Next.js | Accepted |
| [0002](./0002-database-schema.md) | Database schema and Prisma as the data access layer | Accepted |
| [0003](./0003-authentication.md) | Hand-rolled Google OAuth with opaque database sessions | Accepted |
| [0004](./0004-gmail-synchronization.md) | Gmail synchronization strategy | Accepted |
| [0005](./0005-ai-provider-abstraction.md) | Provider-agnostic AI abstraction | Accepted |
| [0006](./0006-background-processing.md) | Database-backed processing lifecycle instead of a queue service | Accepted |
| [0007](./0007-typed-ai-pipeline.md) | Typed AI pipeline with corrective retry | Accepted |
| [0008](./0008-api-design.md) | tRPC as the API layer | Accepted |
| [0009](./0009-deployment.md) | Deployment on Vercel with managed Postgres | Accepted |
| [0010](./0010-caching.md) | Caching strategy | Accepted |

## Template

```markdown
# NNNN. Title

- **Status:** Proposed | Accepted | Superseded by NNNN
- **Date:** YYYY-MM-DD

## Context
## Problem
## Alternatives considered
## Decision
## Trade-offs
## Consequences
```
