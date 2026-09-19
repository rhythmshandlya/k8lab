# Production deployment

klab targets Vercel, Neon Postgres, Better Auth, and optionally Resend and Upstash. The
learning product remains free: accounts provide identity, cloud progress, saved work,
password recovery, and account deletion; there is no billing gate.

## 1. Hosting and GitHub delivery

The production project is `rhythm-shandlyas-projects/klab` and the source repository is
`rhythmshandlya/klab`. Link a fresh checkout when local Vercel access is needed:

```bash
pnpm exec vercel link
```

Production delivery runs in `.github/workflows/ci.yml` only after both quality and browser tests
pass on `main`. The GitHub `production` environment contains `VERCEL_TOKEN`; repository variables
contain `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`. Rotate the token in Vercel and GitHub together.
Pull-request jobs are secret-free.

Create `VERCEL_TOKEN` from **Vercel account settings → Tokens**, scope it to the owning team, and
give it an explicit expiry of no more than one year. Do not copy the short-lived token used by a
`vercel login` CLI session. Record token rotation as an operational task before its expiry.

The canonical domain is `https://klab-five.vercel.app`. Keep `BETTER_AUTH_URL` and the GitHub
OAuth callback aligned with that origin.

## 2. Provision Postgres

Create a Neon database and set:

- `DATABASE_URL`: pooled/serverless connection string used at runtime.
- `DATABASE_URL_UNPOOLED`: direct connection string used for migrations.

Vercel production builds apply checked-in migrations before building the application.
`vercel.json` selects `pnpm build`, which requires `DATABASE_URL_UNPOOLED` when
`VERCEL_ENV=production`. A PostgreSQL advisory lock serializes overlapping production
builds; a missing connection or failed migration stops deployment. Preview and local
builds never run this production migration step. Keep migrations additive and compatible
with the currently serving application, since a later build failure does not undo them.

For initial provisioning or an explicit manual recovery, pull the production values locally
and apply checked-in migrations. Never run `db:push` against production:

```bash
pnpm exec vercel env pull .env.production.local --environment=production
pnpm deploy:check
pnpm db:migrate
```

## 3. Configure authentication

Generate and store a signing secret:

```bash
openssl rand -base64 32
```

Set the result as `BETTER_AUTH_SECRET` and set `BETTER_AUTH_URL` to the canonical HTTPS origin.
Configure at least one provider:

- GitHub OAuth: set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The authorization callback is
  `<BETTER_AUTH_URL>/api/auth/callback/github`.
- Resend email: verify the sending domain, then set `RESEND_API_KEY` and `EMAIL_FROM`. This enables
  verified email/password accounts, password recovery, magic links, and deletion confirmation.

Email/password endpoints stay disabled if email delivery is incomplete. OAuth buttons are only
shown for configured providers.

## 4. Configure abuse protection

Create an Upstash Redis database and set `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` (the Vercel Marketplace's `KV_REST_API_URL` and
`KV_REST_API_TOKEN` aliases are also recognized). Upstash makes Better Auth's sign-in limits and the app's progress
sync, guest merge, and per-user community limits atomic across serverless instances.

## 5. Deploy and verify

Normal releases happen by reviewed pull request:

```bash
gh pr create --fill
gh pr checks --watch
gh pr merge --squash --delete-branch
```

After the merge, GitHub Actions runs CI, starts a remote Vercel build (so sensitive values remain
inside Vercel), applies migrations before building, creates a production deployment, and runs the smoke suite against the public
production alias. Monitor it with `gh run watch`.

For a deliberate local deployment or recovery operation:

```bash
pnpm verify
pnpm test:e2e
pnpm deploy:check
pnpm exec vercel deploy --prod
pnpm smoke:production
```

After deployment:

1. `GET /api/health` returns HTTP 200 with database reachable and auth configured.
2. Sign up or use OAuth, then verify the account appears in the user menu.
3. Complete one action as a guest, sign in, and confirm it merges into the account.
4. Open `/account`, update the display name, and test the recovery path.
5. Confirm unauthenticated requests to `/api/progress`, `/api/labs`, `/api/account/privacy`,
   `/api/merge`, and `/api/community/rank` return HTTP 401.
6. Save a guest lab, sign in, and confirm it appears on another signed-in device and no longer
   remains in the first browser's guest storage.
7. Confirm community activity remains hidden until the account opts in under `/account`.

If `/api/health` returns 503, do not promote the deployment. It intentionally reports degraded
until the database is reachable and the complete auth configuration is active.

If Vercel reports `TEAM_ACCESS_REQUIRED`, make sure the commit author email belongs to a verified
member of the Vercel team. For this repository, keep the repo-local Git identity aligned with the
Vercel account before creating the release commit.

## Rollback

For an urgent application rollback, open the Vercel deployment history and promote the last
known-good production deployment, then fix forward through a pull request. Database migrations
are not automatically rolled back. Schema changes must remain compatible with the previous app
until the new deployment is healthy; use a separately reviewed down migration only when one was
designed and tested in advance.
