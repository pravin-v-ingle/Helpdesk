# Helpdesk

AI-powered ticket management system. See `project-scope.md`, `tech-stack.md`, and `implementation-plan.md`.

## Requirements

- [Bun](https://bun.sh) 1.3 or later

## Getting started

```bash
bun install
bun run dev
```

- Client: http://localhost:5173
- API: http://localhost:3000

The client's home page calls `GET /api/health` and reports whether the API is reachable.

## Scripts

Run from the repository root:

| Command | Description |
|---|---|
| `bun run dev` | Start the API and client together |
| `bun run dev:server` | Start the API only |
| `bun run dev:client` | Start the client only |
| `bun run build` | Build both workspaces |
| `bun run typecheck` | Typecheck both workspaces |

## Structure

```
client/          React + TypeScript, built with Vite
  src/
server/          Express + TypeScript, run by Bun
  src/
    routes/      Express routers
    middleware/  Error handling
    app.ts       App assembly
    index.ts     Entry point
    env.ts       Environment configuration
```

## How the pieces connect

The client calls the API at relative paths under `/api`. In development, Vite proxies
those requests to the Express server on port 3000 (see `client/vite.config.ts`), so
both run on one origin from the browser's point of view and no CORS setup is needed.

The server reads configuration from environment variables at startup and exits
immediately if a required one is missing. Copy `server/.env.example` to `server/.env`
to override defaults.

Express 5 forwards rejected promises from async route handlers to the error middleware
automatically, so handlers do not need `try`/`catch` for that.
