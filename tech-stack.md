# Tech stack

Technology decisions for the AI-powered ticket management system. See `project-scope.md` for scope.

## Summary

| Layer      | Choice                                         |
| ---------- | ---------------------------------------------- |
| Frontend   | React + TypeScript on Vite, React Router, shadcn/ui + Tailwind CSS, Axios, TanStack Query |
| Backend    | Node.js + Express + TypeScript                 |
| Database   | PostgreSQL                                     |
| ORM        | Prisma                                         |
| AI         | Claude API (Anthropic); OpenAI `gpt-5-nano` via the Vercel AI SDK for everything built so far |
| Email      | Mailgun by default, SendGrid adapter alongside  |
| Auth       | Database-backed sessions                       |
| Deployment | Docker containers on a cloud provider          |
| Testing    | Vitest + React Testing Library (client), Playwright end-to-end |

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
- **No charting library.** The dashboard's one chart - tickets per day over the
  last thirty - is plain HTML and CSS in
  `client/src/components/TicketVolumeChart.tsx`: a flex row of bars with a
  percentage height each. Recharts (through shadcn's own `chart` component) was
  the obvious choice and is an order of magnitude larger than the feature it
  would serve here. Three things settled it beyond size. The data-viz mark specs
  the chart follows are exact - a 2px gap *in the surface colour* between bars, a
  4px radius on the data end only and square at the baseline, solid hairline
  gridlines - and stating them directly is less work than overriding a library's
  defaults to match. A `viewBox`'d SVG scales its own axis text with the card,
  which goes wrong at both ends of the responsive range, while CSS text does not.
  And bars as DOM nodes with real `aria-label`s are assertable in jsdom, where
  SVG path geometry is not - so the chart's behaviour is covered by the same kind
  of component test as everything else. **Revisit at the third or fourth chart**:
  axes, scales and tooltips are exactly the things that stop being worth
  hand-writing once they are repeated, and this file is where that trade was
  made.
- Key routes: `/login`, `/` (dashboard), `/tickets` (list, filter, sort),
  `/tickets/:id` (detail), `/admin/users` (admin only).
- **Axios** for HTTP, behind one `apiFetch()` helper in `client/src/lib/api.ts`
  that turns a non-2xx response into an `ApiError` and fires the 401 handler.
  Same-origin only, so no `baseURL` and no `withCredentials`; Vite proxies
  `/api` in development.
- **TanStack Query** for server data. Pages had started growing their own
  `useEffect` + `AbortController` + "last good response" state around
  `apiFetch()` (the users list was the first); the library owns that instead -
  caching by key, cancelling superseded requests, keeping the previous page's
  rows while the next loads (`keepPreviousData`), refetching on focus - and it
  is where the mutations and invalidation for the coming write paths (create
  user, ticket updates) will live. The auth session is deliberately not a
  query: `AuthProvider` is a small explicit state machine, and the cache is
  cleared on sign-in and sign-out so nothing crosses sessions.
- The **Better Auth browser client** (`client/src/lib/auth-client.ts`) handles
  sign-in and sign-out. The current user comes from `GET /api/me` rather than
  its `useSession()` hook, so the client has one user shape - see the comment on
  that route.

## Backend

- **Node.js 22 LTS + Express 5 + TypeScript**.
- Request validation at every route boundary - no unvalidated input reaches a service.
  Bodies that a client form also fills are validated by a Zod schema shared with that
  form, kept in the `core/` workspace (`@helpdesk/core`) and imported by both sides, so
  the form and the API cannot drift and the API's 400 carries the form's message. Plain
  TypeScript, no build: Bun runs it directly on the server and Vite serves it from source.
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

### The one exception: OpenAI for the AI that is built

Every AI call in the system so far goes to OpenAI's `gpt-5-nano` through the
**Vercel AI SDK** (`ai` + `@ai-sdk/openai`) rather than to Anthropic. Four of
them, and the fourth is a different kind of thing from the other three:

- **Polish** - rewrites an agent's draft reply. On demand, stores nothing.
- **Summarise** - summarises the ticket and its conversation. On demand, stores
  nothing.
- **Automatic classification** - sets a new ticket's category when it arrives.
  Nobody asks for it: `services/inbound-email.ts` enqueues a `ticket.classify`
  job inside the transaction that creates the ticket, and a pg-boss worker does
  the model call a second or two later, so the webhook never waits on a model.
- **Knowledge-base auto-resolution** - answers a new ticket from
  `knowledge-base.md` and marks it RESOLVED, when the knowledge base definitively
  covers what was asked. A second queued job alongside the classification, on the
  same terms.

**The fourth is the only one that writes a reply, and that makes it the only one
whose output a student would read.** The first two produce text an agent reads
and can discard; the third writes one enum column that an agent can correct on
the detail page. This one stores an outbound `Message` in the support team's name
and takes the ticket out of the queue, with no human in between - so the whole
design is weighted towards declining: coverage decides rather than category,
anything not covered stays OPEN, the knowledge base's own escalation rules are
enforced in code as well as asked for in the prompt, and it is the one call that
pays for `reasoningEffort: 'medium'`. It also turns `knowledge-base.md` from
documentation into **server input**: its absence is the feature's off switch, and
editing it changes what the system will tell a student.

Why it is a deviation rather than a change of direction:

- It was asked for as `gpt-5-nano` specifically, feature by feature. What is
  left for Claude is the rest of Phase 5: the stored per-ticket summary and a
  *suggested* reply an agent edits before sending - which is a near cousin of the
  auto-resolver and should reuse its knowledge-base reader rather than growing a
  second one - plus the `LlmCall` audit table and prompt caching that neither
  provider's calls have yet. Prompt caching would pay off most on the
  auto-resolver, whose prompt carries the same knowledge base on every call.
- The AI SDK rather than `openai` directly, because it is a provider-agnostic
  client: moving these calls to Claude later is a one-line change in
  `server/src/lib/ai.ts`, with the services above it untouched. One model setting
  (`OPENAI_MODEL`) serves all four features rather than one each - the same kind
  of work on the same size of input, and a knob per feature is a knob nobody sets.
- `OPENAI_API_KEY` is the only **optional** secret in `env.ts`. A deployment
  without one boots and works; the button answers 503 with a sentence the
  composer shows. Nothing else in the system depends on it.
- The prompts carry a student's own words, so all four calls set
  `store: false` - OpenAI is asked to retain nothing. That does not settle the
  open question below about third-party LLMs and student data; it is the least a
  call can do while the question is open. The summary is the widest exposure per
  call: its prompt is the whole conversation, where the polisher sends the last six
  messages and the classifier and the auto-resolver only the subject and opening
  message. **Two of the four happen without anybody asking** - every inbound email
  now reaches OpenAI twice - which is the sharpest form that open question has
  taken, and the reason `OPENAI_API_KEY` being unset has to remain a working
  configuration. Neither queued call has a budget or a sampling rate, and both are
  retried up to three times, so the worst case is multiplied rather than bounded.

## Email

**An adapter per provider, with Mailgun the default.** The decision was not
"SendGrid or Mailgun" in the end: the two differ enough at the inbound edge that
an internal shape plus one adapter each costs little and removes the lock-in.
`INBOUND_EMAIL_PROVIDER` chooses which adapter runs, `INBOUND_EMAIL_SECRET` is
the one credential it needs, and nothing outside `server/src/lib/email/` names a
vendor.

Mailgun is the default for one concrete reason: **SendGrid Inbound Parse has no
signature mechanism at all.** SendGrid does sign its Event Webhook, but that is
delivery and engagement events for mail you sent, a different product that does
not carry inbound mail. The only authentication Inbound Parse offers is a secret
embedded in the parse URL, so the SendGrid adapter authenticates with a
constant-time comparison of HTTP Basic credentials. That is a bearer token on
every request rather than a per-payload signature, which is weaker in the
ordinary ways - anything logging URLs or `Authorization` headers leaks it, and
there is no replay window. Mailgun signs `timestamp + token` with HMAC-SHA256,
which the adapter verifies along with a 15-minute freshness window.

- **Inbound**: existing support mailboxes forward to a single provider address.
  The provider parses the MIME and POSTs a form body to `POST
  /api/email/inbound`. This works regardless of what platform the original
  mailboxes run on. No new dependency decodes it: Bun's `FormData` handles both
  `multipart/form-data` and `application/x-www-form-urlencoded`.
- **Outbound**: transactional send for replies and notifications. Not built yet.

What is in place:

- Webhook signature verification on every inbound request, and the raw body kept
  unparsed so the signature is checked against the bytes that arrived.
- **Idempotency** on the provider's message ID - webhooks are retried, and
  without this you get duplicate tickets. Mail with no `Message-ID` falls back to
  a SHA-256 fingerprint of the *parsed* fields; fingerprinting the raw body would
  dedupe nothing, because the multipart boundary is regenerated per request.
- **Threading**: `Message-ID`, `In-Reply-To` and `References` are stored on every
  message, and a reply matching one reattaches to its ticket rather than opening
  a new one. A `RESOLVED` or `CLOSED` ticket reopens when the student replies.
- Quoted text and signatures are stripped before storage, so neither the agent
  nor Claude reads a thread back to itself. Mailgun's own `stripped-text` is
  preferred where it exists; the local heuristics are the fallback.
- **Loop and auto-reply suppression**: out-of-office markers, `Precedence: bulk`,
  bounces with an empty `Return-Path`, and mail from our own support address are
  stored but not converted. Without this, one autoresponder is an unbounded
  ticket source - and a mail loop the moment outbound send exists.
- Setting `?sort=`, filters and paging on the read side; see `GET /api/tickets`.

Still to do: SPF, DKIM and DMARC for the sending domain, the provider account and
a real inbound route, attachment storage (metadata is kept, bytes are dropped),
and everything outbound.

## Background processing

**The queue is pg-boss**, which keeps its jobs in the Postgres the application
already uses. This settles what was an open decision here.

- Queued work today: **classifying a new ticket** (`ticket.classify`) and
  **answering it from the knowledge base** (`ticket.auto-resolve`), both enqueued
  by the inbound path in the transaction that creates the ticket. Two jobs rather
  than one doing both, because they are independent decisions that fail
  independently. Still to come: summarise, draft reply, send outbound, expire
  sessions, nightly cleanup.
- Every unit of work is idempotent and has bounded retries with backoff -
  three attempts, exponential, recorded on the queue row in the database.

**Why pg-boss over BullMQ or a hosted broker.** Two reasons, in order:

1. **It needs no second piece of infrastructure.** The database is already
   provisioned, already backed up, already in the deployment story and already
   the thing that must be up for the app to work at all. A queue that lives in
   it inherits all of that, where Redis would be one more thing to run, secure
   and pay for. The price is polling rather than push, so a job starts within a
   second or two instead of instantly - exactly the right trade for work nobody
   is watching.
2. **A job can be enqueued inside the transaction that creates the work.**
   Because the jobs are rows in the same database, `fromPrisma(tx)` hands
   pg-boss the transaction's own connection and the job commits with the ticket.
   No external broker can do that. It removes the window where a process commits
   a ticket and then dies before telling anyone to classify it - the gap that
   otherwise needs a reconciliation sweep to close. It also makes the retry safe:
   `serializable()` re-runs its whole callback on a write conflict, and because the
   job rows are written through `tx` they roll back with the ticket, so a retry
   cannot leave duplicate jobs behind.

pg-boss owns its own `pgboss` schema and migrates it itself on start. Nothing in
`prisma/schema.prisma` describes those tables and `prisma migrate` knows nothing
about them, which is the boundary that keeps the two migration systems from
meeting.

**Inbound email still converts inline**; only the two arrival jobs are queued. The
seam for moving conversion itself is unchanged and still unused: every payload is
stored as a `RawEmail` *before* conversion, and `processedAt IS NULL` is exactly
the query a worker would claim from. A conversion that fails leaves the payload
with `processedAt` null and an `error` set, so the provider's retry resumes from
the stored row instead of starting a second ticket.

## Deployment

- **Docker**, multi-stage builds. Two images: `client` (static build) and `server`.
- **Docker Compose** for local development: server, client, and Postgres.
- **Cloud provider** - deliberately not fixed. The container runs on Azure Container Apps, AWS ECS or App Runner, or Google Cloud Run without modification. This choice is deferred until the data-residency question is answered.
- **Managed PostgreSQL** in the chosen provider, with automated backups and point-in-time recovery.
- Migrations run as a release step before the new container takes traffic.
- `GET /health` endpoint for container health checks.
- Secrets from the provider's secret manager, never baked into images.

## Testing

**Playwright** for end-to-end tests, in its own `e2e/` workspace, Chromium only.

- Tests drive the real client and API through a browser, so the whole stack is
  exercised as a user sees it - React Router, the Vite proxy, Better Auth's
  `httpOnly` session cookie, `requireAuth` on the server. Nothing is mocked,
  and nothing is reimplemented in the tests to make the cookie work.
- Playwright's `webServer` starts the API and the client itself and shuts them
  down afterwards, on ports 3001 and 5174 so the development servers on 3000
  and 5173 can stay up.
- The API runs against a **separate `helpdesk_test` database**, selected purely
  by environment: Bun loads `server/.env.test` and `server/.env.test.local` when
  `NODE_ENV=test`, so the same `env.ts` and the same Prisma config point at the
  test database with no code path for tests. The database is dropped, migrated
  and seeded before every run, and the reset script refuses any database whose
  name does not end in `_test`, so development data is never at risk.

**Vitest + React Testing Library** for client component tests, in `client/`.

- Vitest rather than `bun test` for the client because it runs through the
  Vite pipeline: the same React plugin, `@/` alias and TypeScript handling
  as the app, with `vitest.config.ts` extending `vite.config.ts` so there is
  one build configuration, not two. Bun's runner has no equivalent of that
  and weaker DOM support.
- jsdom as the environment: Radix primitives need real-enough DOM APIs
  (`getComputedStyle`, focus management, pointer events); a few gaps
  (`hasPointerCapture`, `scrollIntoView`, `ResizeObserver`) are stubbed in
  `client/src/test/setup.ts`.
- Tests mock only the HTTP boundary (`apiFetch`) and render the page with the
  real query client, auth context and router, so they cover how a page turns
  URL state into requests and responses into UI - the logic an e2e test
  would need many slow runs to pin down - while the e2e suite keeps proving
  the stack end to end.
- Server unit tests and CI are still open; `bun test` remains the likely
  choice for a service worth testing in isolation, since the server has no
  Vite pipeline to share.

## Open decisions

- **Cloud provider and region** - blocked on the data-residency and PII policy question.
- **Whether student personal data may be sent to a third-party LLM API** - must be answered before build starts, as it may require a redaction layer between email parsing and the Claude calls.
- **Password hashing algorithm** - required by the login flow above.
- **Job queue library** - required by background processing above. Inbound email runs inline until it is chosen; see Background processing for the seam.
- **Validation library** - required at the API boundary.
- **Unit test runner and CI** - Playwright covers end-to-end (see Testing); a unit test runner and a CI pipeline are not yet chosen.
