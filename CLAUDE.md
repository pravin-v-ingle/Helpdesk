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
- Database: PostgreSQL with Prisma (not yet added)
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

Phase 1 of the implementation plan is partly done: repository, Express server,
and React client are set up and verified working together. PostgreSQL and Prisma
are next, followed by authentication in Phase 2.

Nothing beyond the health endpoint exists yet - no database, no models, no auth,
no tickets, no AI, no email.
