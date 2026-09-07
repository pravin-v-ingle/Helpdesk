# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

AI-powered ticket management system for student support. Support emails become
tickets; Claude classifies them, summarises them, and drafts replies from a
knowledge base. Agents review and send. Admins manage users.

Planning documents, in the order they were written:

- `project-scope.md` - what the system does, ticket statuses, categories, roles
- `tech-stack.md` - technology choices and the reasoning behind them
- `implementation-plan.md` - phased task breakdown, with completed tasks ticked

Read the relevant one before making a change that touches scope or architecture.
Keep them current when a decision changes.!

## Fetching documentation

**Use the context7 MCP server for library and framework documentation.** Call
`resolve-library-id` then `query-docs` before writing code against Bun, Express,
React, Vite, Prisma, the Anthropic SDK, or any other dependency - even for APIs
that seem familiar. Training data lags behind these libraries, and this project
runs recent versions of all of them.

Prefer context7 over web search for library documentation. It is not useful for
debugging this project's own business logic.

## Stack

Runtime is **Bun** (not Node). Bun executes TypeScript directly, so the server
has no build or transpile step.

- Client: React 19 + TypeScript on Vite 8
- Server: Express 5 + TypeScript on Bun
- Database: PostgreSQL with Prisma 7 (driver adapter `@prisma/adapter-pg`;
  client generated to `server/src/generated/prisma`)
- Auth: Better Auth, email and password, database-backed sessions
- AI: Claude API via `@anthropic-ai/sdk`, default model `claude-opus-5` (not yet added)
- Email: SendGrid or Mailgun, inbound webhook plus outbound send (not yet added)

## Commands

Run from the repository root:

| Command | Description |
|---|---|
| `bun install` | Install all workspace dependencies |
| `bun run dev` | Start API and client together |
| `bun run dev:server` | API only, port 3000 |
| `bun run dev:client` | Client only, port 5173 |
| `bun run build` | Build both workspaces |
| `bun run typecheck` | Typecheck both workspaces |

Run `bun run typecheck` before considering a change complete.

## Layout

```
client/          React app
  src/
  vite.config.ts   proxies /api to the server in development
server/          Express API
  src/
    routes/      Express routers, thin
    services/    business logic
    middleware/  error handling, auth
    lib/         clients and shared setup
    app.ts       app assembly
    index.ts     entry point
    env.ts       environment configuration
```

## Conventions

- **Bun workspaces.** Install at the root, not inside `client/` or `server/`.
- **Relative imports include the `.ts` extension** on the server, matching Bun's
  resolution. The server tsconfig sets `allowImportingTsExtensions`.
- **Business logic lives in services**, not in route handlers. Routes validate
  input, call a service, and shape the response.
- **Express 5 forwards async rejections** to the error middleware automatically -
  no `try`/`catch` in route handlers just to call `next(err)`.
- **Throw `HttpError`** (`server/src/middleware/error-handler.ts`) when a service
  needs to control the status code. Anything else becomes a 500.
- **Configuration comes from `env.ts`**, validated at startup. Never read
  `process.env` directly elsewhere.
- **The client calls relative `/api` paths.** Vite proxies them in development,
  which is why no CORS configuration is needed. Do not hardcode
  `http://localhost:3000` in client code.
- **API keys and secrets stay server-side.** No Claude or email provider call
  originates from the browser.

## State

Phase 1 is done. Phase 2 is done on the server and untouched on the client.

Working: Postgres and Prisma with migrations, Better Auth over database-backed
sessions, `requireAuth()` and `requireRole()`, `GET /api/me`, admin-only user
management at `/api/users`, and a seed script for the initial admin.

Not built yet: the whole client beyond the Vite starter (login page, auth
context, protected routes, admin user page - tasks 2.11 to 2.14), and every
later phase - no tickets, no AI, no email.

Notes for working on auth:

- **There is no self-registration.** `blockPublicSignUp` in `app.ts` 404s
  `/api/auth/sign-up/*` before Better Auth sees it. Create accounts through
  `POST /api/users` or the seed script, both of which call
  `auth.api.signUpEmail()` in-process. Do not remove that guard or set
  `disableSignUp` instead - see the comments in `src/lib/auth.ts`.
- **`role` and `active` are server-owned.** They are declared to Better Auth
  with `input: false`, so no request body can set them; the users service writes
  them through Prisma.
- **Bun installs with an isolated `node_modules`.** Undeclared transitive
  packages such as `@better-auth/core` are not resolvable from our code. Use the
  public `auth.api` / `auth.$context` surface rather than importing internals.
- Run `bun run db:seed` after migrating a fresh database.
