# Tech stack

Technology decisions for the AI-powered ticket management system. See `project-scope.md` for scope.

## Summary

| Layer      | Choice                                         |
| ---------- | ---------------------------------------------- |
| Frontend   | React + TypeScript, Tailwind CSS, React Router |
| Backend    | Node.js + Express + TypeScript                 |
| Database   | PostgreSQL                                     |
| ORM        | Prisma                                         |
| AI         | Claude API (Anthropic)                         |Create
| Email      | SendGrid or Mailgun (inbound + outbound)       |
| Auth       | Database-backed sessions                       |
| Deployment | Docker containers on a cloud provider          |

## Frontend

- **React 19 + TypeScript**.
- **Tailwind CSS** for styling.
- **React Router v7** for routing, with protected routes gated on the current session.
- Key routes: `/login`, `/tickets` (list, filter, sort), `/tickets/:id` (detail), `/admin/users` (admin only).

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

**Database-backed sessions** - no JWTs.

How it works:

1. User posts credentials to `POST /api/auth/login`.
2. Password verified against a securely hashed stored value.
3. Server generates a cryptographically random opaque session token (32 bytes), stores its **hash** in the `Session` table, and returns the raw token in a cookie.
4. Cookie flags: `httpOnly`, `secure`, `sameSite`, and a matching `maxAge`.
5. Auth middleware looks up the session on each request, rejects expired sessions, and attaches the user and role to the request.
6. `POST /api/auth/logout` deletes the session row. The session is immediately dead server-side, which is the main reason for choosing sessions over JWTs.

Details:

- **Sliding expiry**: sessions last 7 days, refreshed on activity.
- **Cleanup**: a scheduled task deletes expired sessions daily.
- **No self-registration.** The database is seeded with the initial Admin account (`prisma/seed.ts`, credentials from environment variables, password change forced on first login). Admins create agent accounts from the UI.
- **Roles**: `ADMIN` and `AGENT` as an enum on the user record. Route middleware `requireAuth()` and `requireRole('ADMIN')` enforce access.
- **Deactivation**: deactivating a user deletes their sessions, logging them out everywhere.

Schema sketch:

```prisma
enum Role {
  ADMIN
  AGENT
}

model User {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String
  name         String
  role         Role      @default(AGENT)
  isActive     Boolean   @default(true)
  createdAt    DateTime  @default(now())
  sessions     Session[]
}

model Session {
  id        String   @id @default(uuid())
  tokenHash String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime @default(now())

  @@index([userId])
}
```

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
- **Frontend build tooling** - React needs a bundler and dev server.
- **Password hashing algorithm** - required by the login flow above.
- **Job queue library** - required by background processing above.
- **Validation library** - required at the API boundary.
- **Testing framework and CI** - not yet chosen.
