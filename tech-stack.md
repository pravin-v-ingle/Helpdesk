# Tech stack

Technology decisions for the AI-powered ticket management system. See `project-scope.md` for scope.

## Summary

| Layer      | Choice                                         |
| ---------- | ---------------------------------------------- |
| Frontend   | React + TypeScript on Vite, React Router, shadcn/ui + Tailwind CSS |
| Backend    | Node.js + Express + TypeScript                 |
| Database   | PostgreSQL                                     |
| ORM        | Prisma                                         |
| AI         | Claude API (Anthropic)                         |Create
| Email      | SendGrid or Mailgun (inbound + outbound)       |
| Auth       | Database-backed sessions                       |
| Deployment | Docker containers on a cloud provider          |

## Frontend

- **React 19 + TypeScript**, built and served by **Vite 8**.
- **React Router v7** for routing, with protected routes gated on the current
  session. `ProtectedRoute` reads the auth context and redirects anonymous
  visitors to `/login`.
- **shadcn/ui on Tailwind CSS v4** for styling. Tailwind runs through the
  first-party `@tailwindcss/vite` plugin with no `tailwind.config`. shadcn was
  initialised with its defaults - the `radix-nova` style (Radix primitives,
  Lucide icons, Geist font), `neutral` base colour, CSS variables for theming -
  recorded in `client/components.json`. `client/src/index.css` is the
  generated theme: the `@theme inline` token map, the light `:root` and `.dark`
  palettes, and a small base layer. Components are copied into
  `client/src/components/ui/` by the CLI and owned by the repo, so they can be
  edited. Layout and spacing use Tailwind utilities directly; colours go
  through the theme tokens so dark mode needs no per-element `dark:` variants.
  Dark mode is the `.dark` class, set on `<html>` by an inline script in
  `index.html` from `prefers-color-scheme`. This replaced the Vite starter's
  custom-property stylesheet once the shell, login page and form controls were
  all restyling the same handful of tokens.
- Key routes: `/login`, `/` (home), `/tickets` (list, filter, sort),
  `/tickets/:id` (detail), `/admin/users` (admin only).
- The **Better Auth browser client** (`client/src/lib/auth-client.ts`) handles
  sign-in and sign-out. The current user comes from `GET /api/me` rather than
  its `useSession()` hook, so the client has one user shape - see the comment on
  that route.

## Backend

- **Node.js 22 LTS + Express 5 + TypeScript**.
- Request validation at every route boundary - no unvalidated input reaches a service.
- Layered structure - routes to services to data access. Business logic lives in services, not in route handlers.
- Suggested layout:

```
server/
  src/
    routes/        # Express routers, thin
    services/      # ticket, user, ai, email logic
    middleware/    # auth, error handling, request logging
    jobs/          # background workers
    lib/           # prisma client, claude client, config
    types/         # shared request and response types
  prisma/
    schema.prisma
    migrations/
    seed.ts
```

- **Error handling**: a single Express error middleware. Services throw typed errors and the middleware maps them to status codes.
- **Config**: all secrets and endpoints come from environment variables, validated once at boot. The app fails fast on a missing variable rather than at first use.

## Database

- **PostgreSQL 17**.
- **Prisma** as ORM, with Prisma Migrate for schema changes. Migrations are committed to the repo and applied on deploy.
- Full-text search over tickets via Postgres `tsvector` - no separate search engine.
- One database holds tickets, users, sessions, the knowledge base, and the audit log.

## Authentication

**Better Auth** (`better-auth`, email and password only) over **database-backed
sessions** - no JWTs.

Better Auth was adopted after this document was first written. It replaces the
hand-rolled hashing, token generation and login/logout handlers this document
originally specified; what it does not replace is the choice of database sessions over JWTs, which
still holds and is why the configuration deliberately turns off the features
that would move session state out of Postgres.

How it works:

1. User posts credentials to `POST /api/auth/sign-in/email`.
2. Better Auth verifies the password against the hash on the `Account` row
   (credentials live on `Account`, not `User`).
3. A `Session` row is written and the token returned in an `httpOnly` cookie.
4. `requireAuth()` calls `auth.api.getSession()` on each request, which reads
   the session from Postgres, and attaches the user and role to the request.
5. `POST /api/auth/sign-out` deletes the session row. The session is immediately
   dead server-side, which is the main reason for choosing sessions over JWTs.

Configuration that matters (`server/src/lib/auth.ts`):

- **No `secondaryStorage`, no `session.cookieCache`.** Both would serve sessions
  from somewhere other than the database and make revocation lazy. Every request
  pays a query; that is the trade being bought.
- **Sliding expiry**: sessions last 7 days, refreshed on activity (the default).
- **No self-registration.** `emailAndPassword.disableSignUp` is on, so Better
  Auth refuses sign-up however the request arrives. That is absolute:
  `auth.api.signUpEmail()` runs through the same handler and is refused too, so
  the seed script and `POST /api/users` create accounts through
  `lib/auth-accounts.ts`, which uses the internal adapter - the same path Better
  Auth's own admin plugin takes. `blockPublicSignUp` in `app.ts` additionally
  404s the route in front of the handler, so a disabled endpoint does not
  advertise itself; neither layer depends on the other.
- **Roles**: `ADMIN` and `AGENT`, a Prisma enum on `User`, declared to Better
  Auth as an additional field with `input: false` so no request body can set it.
  `requireAuth()` and `requireRole('ADMIN')` enforce access.
- **Deactivation**: `active` on `User`. Deactivating deletes the user's sessions
  in the same transaction, and a `session.create.before` hook refuses to issue a
  new one, so the credentials stop working rather than just the current session.
- **Lockout guards**: a user cannot deactivate or demote themselves, and the last
  active admin cannot be removed.
- **Seeding**: `prisma/seed.ts` creates the initial admin from
  `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (`SEED_ADMIN_NAME` optional).
  Idempotent - an existing active admin is left alone, and a plain run never
  changes a password, so it is safe against a live database. An email taken by
  a non-admin or deactivated row is reported rather than skipped;
  `--repair` promotes that row, resets its password and clears its sessions.
  Forcing a password change on first login is not implemented yet.

Better Auth owns the shape of `User`, `Session`, `Account` and `Verification`;
the live definitions are in `server/prisma/schema.prisma`. The sketch that used
to sit here (`passwordHash` on `User`, a hashed `tokenHash` column) no longer
matches and has been removed rather than left to mislead.

Still outstanding: a scheduled task to delete expired sessions.

**Cookie and CORS note**: the React app and the Express API are separate origins in development. Either serve both behind one domain in production (reverse proxy `/api` to Express) and use `sameSite: 'lax'`, or configure CORS with `credentials: true` and `sameSite: 'none'` plus `secure`. Serving from one domain is simpler and more secure - prefer it.

## AI

- **Claude API** via the official `@anthropic-ai/sdk`.
- Default model: **`claude-opus-5`**.
- **Classification** uses structured outputs (`output_config.format`) with a schema whose category field is an enum of the three categories. The model cannot return an invalid category and there is no response parsing.
- **Summaries and suggested replies** use standard messages with adaptive thinking.
- **Prompt caching** on the stable prefix (system prompt, category definitions, tone guide) - the largest cost lever, since that prefix is identical on every ticket.
- **All calls are logged** to an `llm_calls` table: model, prompt version, input, output, tokens, cost, latency, ticket ID. Required for the audit trail (was a reply written by AI or a human) and for debugging classification.
- API keys never reach the frontend. All Claude calls originate from the backend.

## Email

**SendGrid or Mailgun** - decision pending (see Open decisions). Both provide the two pieces needed:

- **Inbound**: existing support mailboxes forward to a single provider address. The provider parses the MIME and POSTs JSON to a backend webhook. This works regardless of what platform the original mailboxes run on.
- **Outbound**: transactional send for replies and notifications.

Requirements either way:

- Webhook signature verification on every inbound request.
- **Idempotency** on the provider's message ID - webhooks are retried, and without this you get duplicate tickets.
- The webhook handler only validates, stores the raw email, queues the work, and returns 200. All parsing and AI work happens in the background.
- **Threading**: store `Message-ID`, and set `In-Reply-To` and `References` on outbound mail so student replies attach to the existing ticket rather than opening a new one.
- Strip quoted text and signatures before sending content to Claude - unstripped threads noticeably degrade classification and summaries.
- SPF, DKIM and DMARC configured for the sending domain.

## Background processing

Inbound email processing cannot happen inside the webhook request - AI calls take seconds and must be retried on failure. The system needs a durable work queue with retries; the specific library is an open decision.

- Queued work: parse email, classify, summarise, draft reply, send outbound, expire sessions, nightly cleanup.
- Every unit of work is idempotent and has bounded retries with backoff. Permanently failed work is retained for inspection rather than silently dropped.

## Deployment

- **Docker**, multi-stage builds. Two images: `client` (static build) and `server`.
- **Docker Compose** for local development: server, client, and Postgres.
- **Cloud provider** - deliberately not fixed. The container runs on Azure Container Apps, AWS ECS or App Runner, or Google Cloud Run without modification. This choice is deferred until the data-residency question is answered.
- **Managed PostgreSQL** in the chosen provider, with automated backups and point-in-time recovery.
- Migrations run as a release step before the new container takes traffic.
- `GET /health` endpoint for container health checks.
- Secrets from the provider's secret manager, never baked into images.

## Open decisions

- **SendGrid vs Mailgun** - compare inbound parse behaviour, deliverability, and pricing at expected volume.
- **Cloud provider and region** - blocked on the data-residency and PII policy question.
- **Whether student personal data may be sent to a third-party LLM API** - must be answered before build starts, as it may require a redaction layer between email parsing and the Claude calls.
- **Password hashing algorithm** - required by the login flow above.
- **Job queue library** - required by background processing above.
- **Validation library** - required at the API boundary.
- **Testing framework and CI** - not yet chosen.
