# Deployment

Vercel for the application, managed Postgres for data, Vercel Cron for scheduled work.
The reasoning is in [ADR 0009](./adr/0009-deployment.md); this is the procedure.

## Prerequisites

- A Vercel project connected to the repository
- A managed Postgres with **both** a pooled and a direct connection string
  (Neon, Supabase, and Vercel Postgres all provide these)
- A Google Cloud project with the Gmail API enabled and an OAuth 2.0 Web client
- An Anthropic API key

## 1. Google OAuth

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

1. **APIs & Services → Library** — enable **Gmail API**.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Add the production redirect URI:
   `https://your-domain.com/api/auth/callback/google`
   (add the localhost one too if the same client is used for development).
4. **OAuth consent screen** — add the scopes `openid`, `email`, `profile`, and
   `https://www.googleapis.com/auth/gmail.readonly`.

While the consent screen is in _Testing_, only listed test users can sign in, and refresh
tokens expire after seven days. Publishing is required for real use, and Google reviews
apps requesting Gmail scopes — budget time for that.

## 2. Environment variables

Set these in **Vercel → Settings → Environment Variables**. Every one is validated at
startup by `src/lib/env.ts`, so a missing value fails the build with a message naming it
rather than surfacing later as a confusing runtime error.

| Variable               | Notes                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `APP_URL`              | `https://your-domain.com`                                     |
| `DATABASE_URL`         | **Pooled** connection string                                  |
| `DIRECT_DATABASE_URL`  | **Direct** connection string — migrations need a real session |
| `GOOGLE_CLIENT_ID`     | From step 1                                                   |
| `GOOGLE_CLIENT_SECRET` | From step 1                                                   |
| `GOOGLE_REDIRECT_URI`  | `https://your-domain.com/api/auth/callback/google`            |
| `ENCRYPTION_KEY`       | `openssl rand -base64 32`                                     |
| `ANTHROPIC_API_KEY`    | From the Anthropic Console                                    |
| `ANTHROPIC_MODEL`      | Defaults to `claude-sonnet-5`                                 |
| `CRON_SECRET`          | `openssl rand -hex 24`                                        |
| `LOG_LEVEL`            | `info`                                                        |

The pooled/direct split is the single most important detail here. Serverless scales by
adding instances; without a pooler, connections exhaust under concurrency. The
application pool is capped at one connection per instance to match
(`src/server/db/client.ts`).

**`ENCRYPTION_KEY` is not rotatable in place.** It decrypts stored Google refresh tokens;
changing it makes existing ones unreadable and every user must reconnect Gmail. That path
is handled gracefully — the account is marked `NEEDS_RECONNECT` rather than erroring — but
it is a user-visible event, so rotate deliberately.

## 3. Deploy

`vercel.json` runs `prisma migrate deploy` as part of the build, against
`DIRECT_DATABASE_URL`. A failed migration fails the deployment, which is the behaviour we
want.

```bash
git push origin main
```

Every pull request gets a preview deployment. Point previews at a separate database
branch if your provider supports it — a preview writing to production data is a bad
afternoon.

## 4. Scheduled work

`vercel.json` registers two crons:

| Path                | Schedule         | What it does                                  |
| ------------------- | ---------------- | --------------------------------------------- |
| `/api/jobs/sync`    | every 10 minutes | Incremental sync for connected mailboxes      |
| `/api/jobs/analyze` | every 5 minutes  | One analysis batch per user with work waiting |

Both authenticate against `CRON_SECRET` with a constant-time comparison. Both are
idempotent — sync resumes from its checkpoint, analysis claims whatever is currently
claimable — so an at-least-once scheduler is safe.

To drive them from another scheduler:

```bash
curl -X POST https://your-domain.com/api/jobs/sync \
  -H "Authorization: Bearer $CRON_SECRET"
```

Each invocation visits at most five users and works to a wall-clock budget, so throughput
scales with cron frequency rather than with any single run's length. Raise the frequency
before raising the per-run limits.

## 5. Verify

```bash
curl https://your-domain.com/api/health
```

Expect `{"status":"ok","checks":{"database":{"status":"ok",...}}}`. A `503` means the
deployment cannot reach Postgres — check `DATABASE_URL` and the database's IP allow-list.

Then sign in, connect Gmail, and press **Sync now**. The widgets should show a rising
processed count within a minute or two.

## Operating notes

**Watching synchronization.** Every run writes a `sync_runs` row with counts, duration,
and API call count:

```sql
SELECT status, count(*), avg(extract(epoch from ("finishedAt" - "startedAt")))
FROM sync_runs WHERE "startedAt" > now() - interval '1 day' GROUP BY status;
```

**Watching AI quality.** Validation failure rate is a direct signal of prompt or model
drift:

```sql
SELECT outcome, count(*) FROM analysis_attempts
WHERE "createdAt" > now() - interval '1 day' GROUP BY outcome;
```

A rising `INVALID_OUTPUT` share means the schema and the model have drifted apart.

**Stuck emails.** Emails are self-healing — an expired lease is reclaimed by the next run
— so intervention is rarely needed. To requeue permanent failures after fixing the cause,
use `resetFailed` from `features/processing`.

**Logs.** Structured JSON on stdout, captured by Vercel. Email subjects, bodies, and
addresses are redacted before serialization (`src/server/logger`), so logs can be shared
with support without leaking mail contents.

## Self-hosting

The application is a standard Next.js app; nothing outside `vercel.json` is
Vercel-specific.

```bash
npm ci && npm run build && npm start
```

Provide the same environment variables, run `prisma migrate deploy` before starting, and
call the two `/api/jobs/*` endpoints from any scheduler with the `CRON_SECRET` header.
