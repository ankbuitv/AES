# AES — Ank Ecosystem Social

A complete, production-ready mini social platform that runs **entirely on Cloudflare Workers** — no origin server, no VPS, no PHP, no traditional backend.

Posts (text, markdown, article, image, multi-image, link, code), threaded comments, reactions, follows, bookmarks, mentions, hashtags, notifications, full-text search, server-computed reputation, a moderation dashboard with an audit trail, and server-side rendering for every public page.

| Layer | Technology |
| --- | --- |
| Runtime | Cloudflare Workers (edge, V8 isolates) |
| Router | Hono 4 + TypeScript (strict) |
| Database | Cloudflare D1 (SQLite) — the only source of truth |
| Object storage | Backblaze B2 (native API) behind a `StorageProvider` interface — R2 and any S3-compatible service are drop-in alternatives |
| Cache / counters | Workers KV + Cache API |
| Background work | Cron Triggers + a durable D1 job queue (Queues optional) |
| Frontend | Server-rendered HTML + Tailwind CSS v4 + ~13 KB of progressive-enhancement TypeScript. No SPA, no React |

---

## Table of contents

1. [Quick start](#quick-start)
2. [17-step deployment guide](#17-step-deployment-guide)
3. [Project layout](#project-layout)
4. [Architecture](#architecture)
5. [Security model](#security-model)
6. [API reference](#api-reference)
7. [Database and migrations](#database-and-migrations)
8. [Storage gateway](#storage-gateway)
9. [Background jobs and cron](#background-jobs-and-cron)
10. [Testing](#testing)
11. [Known limitations and workarounds](#known-limitations-and-workarounds)

---

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars      # optional in dev; fill in SESSION_SECRET and IP_HASH_SALT
npm run db:migrate:local            # apply all 8 migrations to the local D1
npm run seed                        # optional: 5 members, 6 posts, comments
npm run build:assets                # compile Tailwind CSS + the client bundle
npm run dev                         # http://localhost:8787
```

`npm run dev` works even without `.dev.vars`: in the `development` environment a
fixed dev-only signing secret is used for CSRF tokens when `SESSION_SECRET` is
absent, so registering, logging in and uploading images work out of the box.
Copy the example file anyway if you want to exercise a real secret locally.
**Preview and production never fall back** — there a missing `SESSION_SECRET`
fails mutating requests with a clear CSRF error (never a 500).

Verify:

```bash
curl http://localhost:8787/health
# {"status":"ok","environment":"development","checks":{"database":"ok","storage":"ok"},...}
```

Local development uses the Wrangler-simulated R2 bucket for uploads (`STORAGE_PROVIDER=r2`), so you can build and test the entire media pipeline before you own a Backblaze account.

---

## 17-step deployment guide

Everything below is non-secret configuration except where noted. **No secret and no domain name is ever hard-coded in application code** — the Worker reads `SITE_URL` (or the incoming request origin) at runtime.

### 1. Install the toolchain

```bash
node --version     # must be >= 20
npm install
```

Wrangler is a project dependency; every command below can be prefixed with `npx`.

### 2. Sign in to Cloudflare

```bash
npx wrangler login          # opens a browser
npx wrangler whoami         # confirms the account
```

### 3. Create the Worker

The Worker is created on first deploy from `wrangler.toml` (`name = "anksocial"`, `main = "worker/index.ts"`). The top-level configuration is production because Cloudflare Workers Builds runs `npx wrangler deploy` without an environment flag. When using Workers Builds, name the connected dashboard Worker **`anksocial`** as well; the dashboard and Wrangler names must match.

```bash
npx wrangler deploy --dry-run --env=""  # validates production config without publishing
```

### 4. Create the D1 database

```bash
npx wrangler d1 create ank-social
```

Copy the printed `database_id` into `wrangler.toml`, replacing the
`00000000-0000-0000-0000-000000000000` production placeholder at the top level. The local environment intentionally has no ID because Wrangler simulates D1 locally. Create a separate database for preview and put its ID under `[env.preview]` if you want isolation:

```bash
npx wrangler d1 create ank-social-preview
```

### 5. Create the KV namespace

KV backs rate limiting and the storage auth-token cache.

```bash
npx wrangler kv namespace create KV
```

Copy the printed `id` into the top-level `[[kv_namespaces]]` block in `wrangler.toml` (and create a separate namespace for `[env.preview]` if used). The local namespace is simulated and needs no ID.

### 6. Run the migrations

```bash
npm run db:migrate:local        # local dev
npm run db:migrate:preview      # preview environment
npm run db:migrate:prod         # production
```

All eight migrations (`0001_initial` … `0008_search`) are idempotent and tracked by Wrangler's `d1_migrations` table. The Worker also applies the same bundled SQL on first request if the production D1 is empty (Workers Builds does not run `d1 migrations apply`). That bootstrap only executes the checked-in migration files.

### 7. Generate and set the secrets

```bash
openssl rand -hex 32     # -> SESSION_SECRET
openssl rand -hex 16     # -> IP_HASH_SALT

npx wrangler secret put SESSION_SECRET --env=""
npx wrangler secret put IP_HASH_SALT   --env=""
```

`SESSION_SECRET` signs CSRF tokens; `IP_HASH_SALT` keys the one-way hash applied to IP addresses before they are stored.

### 8. Create the Backblaze B2 bucket

In the Backblaze console:

1. **Buckets → Create a Bucket** — name it e.g. `ank-social-media`.
2. Set **Files in Bucket are: Private**. The Worker is the only reader; browsers never talk to B2.
3. Note the **Bucket ID** shown on the bucket's detail page.
4. **App Keys → Add a New Application Key**, scoped to that bucket, with `readFiles`, `writeFiles` and `deleteFiles`. Copy the **keyID** and **applicationKey** — the key is shown only once.

### 9. Set the B2 secrets

```bash
npx wrangler secret put B2_APPLICATION_KEY_ID --env=""
npx wrangler secret put B2_APPLICATION_KEY    --env=""
npx wrangler secret put B2_BUCKET_ID          --env=""
npx wrangler secret put B2_BUCKET_NAME        --env=""
```

The top-level production `[vars]` already sets `STORAGE_PROVIDER = "b2"`. Credentials exist only inside the Worker; they are never sent to a browser and never logged. Production has no R2 binding, so deploying does not require an R2 subscription; R2 is bound only in `[env.local]` and simulated by Wrangler.

### 10. Build the static assets

```bash
npm run build:assets     # Tailwind CSS -> public/assets/app.css, esbuild -> public/assets/app.js
```

`public/` is uploaded by the `[assets]` binding and served by Cloudflare's asset layer, so static files cost no Worker invocation. Both build outputs are git-ignored and regenerated by every `npm run deploy*`.

### 11. Deploy

```bash
npm run deploy           # builds assets, then `wrangler deploy --env=""`
# `npm run deploy:prod` is an alias for the same command
```

For Cloudflare Workers Builds, set the deploy command to `npx wrangler deploy --env=""`; the explicit empty environment selects this top-level production configuration and avoids Wrangler's multiple-environments warning. The default `*.workers.dev` URL is printed on success.

### 12. Attach the custom domain

Add the domain to Cloudflare (orange-clouded), then uncomment the top-level route directly below `workers_dev` in `wrangler.toml`:

```toml
routes = [{ pattern = "me.ankb.qzz.io", custom_domain = true }]
```

Keep `SITE_URL = "https://me.ankb.qzz.io"` under the top-level `[vars]` block (already the default) and redeploy. The API is then reachable at `https://me.ankb.qzz.io/api/*`, media at `https://me.ankb.qzz.io/media/*`, and the public status dashboard at `https://me.ankb.qzz.io/status`.

### 13. Confirm the production environment

```bash
npx wrangler deployments list --env=""
npx wrangler secret list --env=""      # names only, never values
```

Check that `ENVIRONMENT = "production"`, which enables HSTS, disables the development password-reset token in API responses, and switches `robots.txt` from "block everything" to the real policy.

### 14. Health check

```bash
curl https://me.ankb.qzz.io/health
# {"status":"ok","readiness":"ready","environment":"production","version":1,
#  "checks":{"database":"ok","storage":"ok","schema":"ok"},"timestamp":"..."}
```

`status` reports Worker liveness, while `readiness` reflects its dependencies. `checks.storage` performs a real `HEAD` against the bucket, so it fails loudly if the B2 credentials are wrong. The human-readable dashboard at [`/status`](https://me.ankb.qzz.io/status) refreshes live and builds honest 90-day availability/incident history from the 15-minute Cron samples stored in KV.

### 15. Create the administrator account

```bash
npm run create-admin -- --username yourname --email you@example.com --remote
```

The password is typed at a masked prompt, hashed locally with the same PBKDF2-HMAC-SHA256 parameters the Worker uses, and only the hash is written. Re-running promotes an existing account, resets its password and revokes its sessions.

### 16. Smoke-test the social loop

Sign in at `/login`, then:

| Test | Expected |
| --- | --- |
| `/settings` → upload an avatar | 201, avatar appears; the response contains a `media_id`, never a bucket URL |
| `/compose` → publish a post | Redirects to `/post/{slug}`, rendered server-side |
| Comment on the post from a second account | Comment appears; author's bell shows an unread badge |
| React and bookmark | Counters update in place; `/bookmarks` lists the post |
| `curl -I https://me.ankb.qzz.io/media/{media_id}` | `200`, `content-type: image/*`, `x-content-type-options: nosniff` |
| Report a post, then open `/admin` | Report is queued; resolving it writes an `audit_logs` row |

### 17. Verify the scheduled jobs

```bash
npx wrangler tail --env="" --format pretty
```

The `*/15 * * * *` trigger drains the job queue, purges expired sessions and flushes the storage cleanup queue; `27 3 * * *` additionally aggregates yesterday's statistics, collects orphaned media, verifies storage integrity and reconciles denormalised counters. Locally you can fire them by hand:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*"
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=27+3+*+*+*"
```

---

## Project layout

```
migrations/            0001_initial … 0008_search — the only way the schema changes
worker/index.ts        Worker entrypoint: middleware stack, routers, /health, scheduled()
src/
  config.ts            Runtime config from bindings; session/XP/limit policy
  types/               Bindings, Variables, row interfaces and DTOs
  utils/               errors, response envelope, ids, crypto, html escaping, markdown,
                       cursors, time, logger, mime sniffing, cookies, csrf
  validators/          Zod schemas for every body, query and path parameter
  db/
    client.ts          Parameterised-only D1 wrapper (no string concatenation possible)
    repositories/      One repository per aggregate; all SQL lives here
  services/            Business logic: auth, posts, users, media, notifications,
                       moderation, search, xp, jobs, rateLimit, context
                       storage.ts / b2.ts / s3.ts / r2.ts / storageFactory.ts
  middleware/          requestContext, security, session, auth, body, csrf, rateLimit, error
  routes/
    api/               /api/* JSON routers
    media.ts           GET /media/{id} streaming gateway
    pages/             Server-rendered HTML routes, robots.txt, sitemap.xml, feed.xml
  views/               Layout, page renderers and components (escaping templates)
  styles/app.css       Tailwind v4 entry + the design system
  client/app.ts        Progressive-enhancement bundle (no framework)
scripts/               build-client, seed, reset-local-db, create-admin
tests/                 103 tests against the real Worker over an in-memory D1
public/                Static assets (favicon, icons, manifest, built CSS/JS)
```

## Architecture

**Request flow.** `requestContext` (request id, CSP nonce, client IP, access log) → `securityHeaders` → `sessionMiddleware` (resolves the session cookie, mints the CSRF token) → router. `/api/*` additionally applies a body-size limit, CSRF verification and a per-tier rate limit before any handler runs.

**Layering.** Routes parse and authorise, services hold business rules, repositories own all SQL. A service receives a `ServiceContext` (`env`, `config`, `origin`, `repos`, `logger`, `storage()`, `defer()`), which is what makes every one of them testable without a Worker.

**Rendering.** `renderPage(c, …)` is the only way a route emits HTML. It owns the document shell, the CSP nonce, the unread badge and the caching posture: `private, no-store` whenever a user is signed in, a short `s-maxage` only for anonymous public pages.

**Pagination.** Every list endpoint returns `{items, nextCursor, hasMore}` and uses keyset (not `OFFSET`) pagination over `(sort_key, id)`, encoded into an opaque base64url cursor that is validated and length-bounded on the way back in.

## Security model

| Concern | Implementation |
| --- | --- |
| Passwords | PBKDF2-HMAC-SHA256, 100 000 Workers-compatible iterations, per-password random salt; parameters encoded in the hash so they can be raised later |
| Sessions | 32-byte random token in an `HttpOnly; Secure; SameSite=Lax` cookie; only its SHA-256 is stored; sliding 7-day idle expiry with a hard 30-day cap; rotated on login; revoked on logout and password change |
| CSRF | Origin/Referer validation **plus** a signed double-submit token scoped to the session, sent as `x-csrf-token` or a `_csrf` form field |
| XSS | Server-side escaping template (`html\`\``); Markdown is escaped first and then re-whitelisted; raw user HTML is never rendered; CSP is nonce-based with no `unsafe-inline` for scripts |
| SQL injection | The D1 wrapper accepts `(sql, params[])` only — interpolating a user value is structurally impossible |
| Authorisation | Enforced in services and middleware (`requireAuth`, `requireRole`, `requireStaff`, `requireAdmin`). The frontend only hides controls the server already refuses |
| Uploads | Size cap, magic-byte sniffing, rejection of PHP/HTML/SVG/executables/unknown binaries, declared-vs-actual MIME mismatch rejection, per-owner quota and hourly upload cap |
| Rate limiting | KV sliding window with distinct tiers (login 8/15 min, register 5/h, upload 20/h, createPost 10/5 min, publicRead 240/min …), answering `429` with `Retry-After` |
| Headers | CSP, HSTS (production only), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: DENY`, COOP/CORP |
| Privacy | IP addresses and user agents stored only as keyed hashes; the logger redacts password, token, cookie, secret and storage-key fields |
| Errors | `{success, data, error:{code, message}}`; stack traces, SQL text and storage errors never reach a client |

## API reference

All responses use the envelope `{success, data, error}`; `error` carries `code` and `message`.

```
POST   /api/auth/register|login|logout|logout-all|refresh
POST   /api/auth/password                     change password
POST   /api/auth/password/reset[/confirm]     reset flow
POST   /api/auth/delete-account
GET    /api/auth/me | /api/auth/sessions      DELETE /api/auth/sessions/:id

GET    /api/posts?sort=foryou|latest|trending|following&cursor=&limit=&tag=&category=
GET    /api/posts/bookmarks | /api/posts/:idOrSlug | /api/posts/:id/comments
POST   /api/posts | /api/posts/:id/{reactions,bookmark,share,comments}
PATCH  /api/posts/:id        DELETE /api/posts/:id
PATCH  /api/comments/:id     DELETE /api/comments/:id     POST /api/comments/:id/reactions

GET    /api/users/{suggested,leaderboard,:username[/posts|replies|followers|following]}
POST   /api/users/:username/{follow,unfollow,block,unblock}   DELETE .../{follow,block}
PATCH  /api/me/profile   GET /api/me/{bookmarks,media}   DELETE /api/me/avatar

POST   /api/media/upload     GET /api/media     DELETE /api/media/:id
GET    /media/{media_id}[?v=thumb|medium]      streaming gateway (Range, ETag)

GET    /api/notifications[/unread-count]     POST /api/notifications/{read,read-all}
GET    /api/search?q=&type=all|posts|users|tags
GET    /api/tags | /api/categories           POST /api/reports
GET    /api/admin/{dashboard,reports,users,posts,audit}   POST /api/admin/actions

GET    /health   /robots.txt   /sitemap.xml   /feed.xml
```

Pages: `/`, `/explore`, `/trending`, `/following`, `/bookmarks`, `/post/{slug}`, `/u/{username}[/media|/replies|/followers|/following]`, `/tag/{slug}`, `/category/{slug}`, `/search`, `/notifications`, `/settings`, `/compose`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/leaderboard`, `/admin`, `/about`, `/status`, `/terms`, `/privacy`.

## Database and migrations

| Migration | Tables |
| --- | --- |
| `0001_initial` | settings, categories, tags (+ seed rows) |
| `0002_users` | users, sessions, auth_tokens, user_badges, xp_events |
| `0003_posts` | posts, post_tags, post_media, comments |
| `0004_social` | reactions, follows, bookmarks, mentions, post_views |
| `0005_media` | media, storage_cleanup_queue |
| `0006_notifications` | notifications, jobs, stats_daily |
| `0007_moderation` | reports, audit_logs, blocks |
| `0008_search` | FTS5 `posts_fts` + sync triggers |

Timestamps are unix seconds (INTEGER). IDs are prefixed and time-sortable (`usr_`, `pst_`, `cmt_`, `med_`…), which makes `(created_at, id)` cursors stable. Indexes are partial where the query is partial — the feed index only covers `status='published' AND visibility='public'`.

Useful commands:

```bash
npm run db:reset:local -- --seed        # wipe local D1, re-migrate, re-seed
npm run db:studio -- "SELECT COUNT(*) FROM posts"
```

## Storage gateway

All object access goes through the `StorageProvider` interface in `src/services/storage.ts`:

```ts
uploadObject · downloadObject · deleteObject · headObject · objectExists · getObjectMetadata
generateObjectKey(usage, ownerId, mediaId, extension, variant?)
```

`src/services/b2.ts` implements it against the native B2 API (KV-cached auth token, 20 h; upload URL, 1 h; SHA-1 per upload). `s3.ts` is a hand-rolled SigV4 client for any S3-compatible endpoint, and `r2.ts` uses a native binding. The provider is selected in exactly one place — `storageFactory.getStorage(env)` — so switching backends is a `STORAGE_PROVIDER` change, not a code change.

D1 stores only metadata: `media_id, owner_id, storage_key, mime_type, size, width, height, checksum, created_at`. Reads are permission-checked and streamed by the Worker with ETag/304, Range/206, `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. Deletion is a soft delete plus a `storage_cleanup_queue` row drained by cron, and a storage 404 flips the row to `missing` instead of serving 500s forever.

## Background jobs and cron

Producers call `repos.jobs.enqueue(type, payload)`; `JobRunner.drain()` claims a batch, runs it, and retries failures with exponential backoff (five attempts, then parked as `failed`). Job types: `notification_fanout`, `media_variants`, `storage_cleanup`, `stats_rollup`.

| Schedule | Work |
| --- | --- |
| `*/15 * * * *` | record status/incident history, drain jobs, purge expired sessions, flush the storage cleanup queue |
| `27 3 * * *` | + stats rollup, orphan media collection, storage integrity sampling, counter reconciliation, purge finished jobs |

Cloudflare Queues are supported but commented out in `wrangler.toml`; the D1-backed queue exists so the platform is fully functional on the free plan.

## Testing

```bash
npm test          # 115 tests
npm run check     # typecheck (3 projects) + tests
```

Tests drive the **real Worker** — `worker/index.ts`, the real middleware chain, real services and real SQL — over an in-memory SQLite database created by `node:sqlite` with the actual migration files applied. There is no mocked backend and no fake API.

| Suite | Covers |
| --- | --- |
| `auth.test.ts` | registration, login, session rotation/expiry, password change, reset, deletion, enumeration resistance |
| `security.test.ts` | CSP/HSTS/headers, CSRF (missing, cross-origin, valid), rate limiting + `Retry-After`, body/cursor/limit validation, XSS escaping, error envelope, `/health` |
| `social.test.ts` | posts CRUD and permissions, visibility (private/followers), cursor pagination, comment nesting and depth cap, reactions, bookmarks, follows, notifications, search, server-side XP |
| `media.test.ts` | upload gate (size, PHP/HTML/SVG/ELF, MIME mismatch), dedupe, streaming/ETag/Range, permissions, soft delete + cleanup queue, `StorageProvider` contract, bucket-failure rollback |
| `pages.test.ts` | SSR markup and landmarks, OpenGraph/JSON-LD/canonical, caching posture, robots/sitemap/RSS, admin authorisation and audit logging |
| `jobs.test.ts` | job claim/retry/backoff, both cron schedules through `scheduled()`, counter reconciliation, resilience when one task fails |
| `status.test.ts` | daily uptime aggregation, outage/resolution transitions and 90-day KV retention |

## Known limitations and workarounds

These are platform constraints, stated explicitly with the production-compatible workaround that **is implemented** in this repository.

1. **No interactive transactions in D1.** `BEGIN/COMMIT` is unavailable over the D1 protocol. *Workaround:* every multi-statement write uses `db.batch()`, which D1 runs in one implicit transaction with rollback on failure; counters that could still drift are repaired nightly by `users.reconcileCounters`.
2. **KV rate limiting is eventually consistent across colos.** A determined attacker hitting many colos can exceed a tier briefly. *Workaround:* short windows, per-account keys for signed-in traffic, and the expensive operations (register, upload, password reset) carry the tightest tiers. Cloudflare's Rate Limiting rules can be layered in front for a hard guarantee.
3. **Cloudflare Queues is a paid add-on.** *Workaround:* a durable job queue in the D1 `jobs` table with claim/retry/backoff, drained by a Cron Trigger and opportunistically via `waitUntil()`. Producer code already goes through `repos.jobs.enqueue()`, so enabling the commented-out Queues binding is a one-file change.
4. **No image processing in the Workers runtime.** Resizing requires Cloudflare Images or a WASM codec. *Workaround:* `MediaService.generateVariants()` is written against an `IMAGES` binding and returns `[]` when it is absent; `?v=thumb` then transparently serves the original, and the `media_variants` job becomes a no-op. Binding Cloudflare Images enables real variants with no other change.
5. **Relevance-ranked search cannot be keyset-paginated.** BM25 scores are not monotonic keys. *Workaround:* FTS5 search uses a bounded rank window capped at `MAX_SEARCH_DEPTH = 200`, the standard trade-off; feeds and all other lists use true keyset pagination. `SearchProvider` is an interface, so an external engine can replace FTS5 without touching routes.
6. **No email delivery from Workers.** *Workaround:* password reset creates a real, hashed, 30-minute single-use token and returns `{requested, delivered:false}` identically for known and unknown addresses (no account enumeration). In non-production the token is echoed as `devToken` so the flow is testable; production omits it. Wiring MailChannels/Resend means implementing one function in `AuthService.requestPasswordReset`.
7. **No argon2/bcrypt in the runtime.** Native modules and large WASM are impractical at the edge, and Cloudflare Workers caps portable PBKDF2 derivations at 100 000 iterations. *Workaround:* PBKDF2-HMAC-SHA256 at that Workers-compatible ceiling, a 10-character minimum password policy and tight authentication rate limits. The iteration count is stored in each hash so it can be raised and hashes upgraded on a future compatible runtime.
8. **Backblaze B2 has no per-object ACL usable from a browser.** *Workaround:* the bucket is private and the Worker is the only reader — which is the desired design anyway, since it lets every read be permission-checked and keeps credentials server-side.
9. **`wrangler dev` does not fire Cron Triggers automatically.** *Workaround:* trigger them with `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=..."`; `tests/jobs.test.ts` calls `scheduled()` directly.

---

## License

MIT — see [LICENSE](LICENSE).
