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
Keep them current when a decision changes.

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

- Client: React 19 + TypeScript on Vite 8, React Router v7, shadcn/ui on
  Tailwind CSS v4 (`radix-nova` style, `neutral` base colour), Axios for HTTP,
  TanStack Query for server data
- Server: Express 5 + TypeScript on Bun
- Shared: `core/` (`@helpdesk/core`), a workspace of plain TypeScript imported
  by both client and server - Zod schemas for request bodies (see
  Conventions)
- Database: PostgreSQL with Prisma 7 (driver adapter `@prisma/adapter-pg`;
  client generated to `server/src/generated/prisma`)
- Auth: Better Auth, email and password, database-backed sessions
- AI: Claude API via `@anthropic-ai/sdk`, default model `claude-opus-5` (not yet
  added). **Everything actually built goes to OpenAI `gpt-5-nano` through the
  Vercel AI SDK** (`ai` + `@ai-sdk/openai`): the reply polisher, the ticket
  summariser, and the automatic classifier that categorises a new ticket as it
  arrives - see Polishing a draft reply, Summarising a ticket and Classifying a
  ticket automatically below, and `tech-stack.md` for why the deviation stands.
  One `OPENAI_MODEL` serves all three, and `OPENAI_API_KEY` is the one optional
  secret in `env.ts` - **unset has to keep working**, which is how the e2e stack
  runs.
- Email: provider-agnostic inbound, one adapter per provider (`server/src/lib/email/`),
  chosen by `INBOUND_EMAIL_PROVIDER`; Mailgun is the default because SendGrid
  Inbound Parse has no signature mechanism. Outbound send not yet added.
- Jobs: **pg-boss** in the application's own Postgres (`lib/queue.ts`), its own
  `pgboss` schema which it migrates itself. Classification is the only queued
  work so far; `QUEUE_ENABLED` and `RUN_WORKERS` control it and both default on
  (see Background jobs)
- Testing: Playwright end-to-end in `e2e/`, Chromium only, against a separate
  `helpdesk_test` database; Vitest + React Testing Library on jsdom for
  client component tests, and **`bun test`** for server unit tests - Bun's own
  runner, no dependency and no configuration (see Testing)

## Commands

Run from the repository root:

| Command | Description |
|---|---|
| `bun install` | Install all workspace dependencies |
| `bun run dev` | Start API and client together |
| `bun run dev:server` | API only, port 3000 - starts the job queue and its workers too |
| `cd server && bun run worker` | The job workers on their own, with no HTTP server |
| `bun run dev:client` | Client only, port 5173 |
| `bun run build` | Build both workspaces |
| `bun run typecheck` | Typecheck all workspaces |
| `bun run test:unit` | Run both unit suites - client (Vitest) then server (`bun test`) |
| `bun run test:unit:client` | The client component tests only |
| `bun run test:unit:server` | The server unit tests only |
| `bun run test:e2e` | Run the Playwright end-to-end tests (see Testing) |
| `cd server && bun run email:test` | POST a signed, provider-shaped email to the inbound webhook (see Tickets and inbound email) |

Run `bun run typecheck` and `bun run test:unit` before considering a change
complete. `bun test` does **not** typecheck, so a test file that has drifted from
the types it uses passes the suite and fails only the typecheck - which is why
both commands matter, not just the one that went red last.

## Layout

```
core/            @helpdesk/core - code both client and server import
  src/
    schemas/     one Zod schema module per resource (users.ts so far:
                 create, edit and PATCH, composed from shared field rules)
  package.json   `exports` maps each module to its .ts source; no build step
  tsconfig.json  no DOM, no Bun types - the code must run in both
client/          React app
  src/
    auth/        auth context, provider, protected route
    components/  shared UI - app shell, nav bar, Pagination (shared by both
                 list pages), UsersTable and TicketsTable (each + its
                 skeleton), UserFormDialog and the Create/Edit dialogs built
                 on it, DeleteUserDialog (the row's delete confirmation)
      ui/        shadcn/ui components, generated by the CLI, owned by the repo
    pages/       one component per route, with its component test beside it (*.test.tsx)
    lib/         Axios API helper, TanStack query client, users, tickets and
                 assignees API clients, Better Auth browser client, cn()
    test/        setup.ts - jest-dom matchers, RTL cleanup, jsdom polyfills for Radix
    index.css    Tailwind import and the shadcn theme (generated by shadcn init)
    App.tsx      route table
    main.tsx     entry point
  index.html       root element, dark-mode class script
  components.json  shadcn configuration and aliases
  vite.config.ts   Tailwind plugin, @/ alias, proxies /api to the server in development
  vitest.config.ts extends vite.config.ts: jsdom, setup file, *.test.{ts,tsx} under src
server/          Express API
  src/
    routes/      Express routers, thin
    jobs/        pg-boss worker handlers (one per queue) and their registration
    services/    business logic
    middleware/  error handling, auth
    lib/         clients and shared setup, parseBody() for shared schemas,
                 serializable() in transaction.ts
      queue.ts   pg-boss: lifecycle, queue names, transactional enqueue
      email/     inbound provider adapters: the InboundEmail contract
                 (inbound-email.ts), the registry (providers.ts), mailgun.ts,
                 sendgrid.ts, and the shared parsing bits - multipart.ts,
                 address.ts, strip-quoted-reply.ts
    app.ts       app assembly
    index.ts     entry point - starts the queue, then listens
    worker.ts    entry point for the workers alone, with no HTTP server
    env.ts       environment configuration
  scripts/       reset-test-db.ts - resets the e2e database;
                 send-test-email.ts - signs and POSTs a test inbound email
  .env.test      committed settings for the e2e API (test ports, test admin)
e2e/             Playwright end-to-end tests
  playwright.config.ts  starts API and client, Chromium only
  tests/         specs go here (empty so far)
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
  `process.env` directly elsewhere. Bun loads `server/.env` itself, plus
  `.env.<NODE_ENV>` and `.env.<NODE_ENV>.local` on top - that is how the e2e
  stack swaps in its database without any code path for tests.
- **Prisma 7 CLI differences.** `prisma migrate dev` and `db push` no longer
  run `prisma generate` - run `bun run db:generate` after a schema change.
  `--skip-seed` and `--skip-generate` were removed. `prisma migrate reset
  --force` refuses to run when it detects an AI agent until the user has
  consented (`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`).
- **The client calls relative `/api` paths.** Vite proxies them in development,
  which is why no CORS configuration is needed. Do not hardcode
  `http://localhost:3000` in client code.
- **Client HTTP is Axios, through `apiFetch()`** in `client/src/lib/api.ts`.
  Never call `fetch()` or `axios` directly from a page, hook or component;
  add a function to the resource's API client (`lib/users.ts` is the pattern)
  that calls `apiFetch()`, so every request gets the same error shape and the
  401 handling. The only exception is Better Auth's own browser client.
- **Client server-state is TanStack Query.** Read data with `useQuery` and
  write it with `useMutation` + `invalidateQueries` (`CreateUserDialog` is
  the pattern: `mutationFn: createUser`, `onSuccess` invalidates
  `userKeys.all`); never hand-roll a `useEffect` + `useState` +
  `AbortController` around `apiFetch()`. Define the keys, `queryOptions` and
  write functions beside the API client (`userKeys`,
  `userListQueryOptions()`, `createUser()` in `lib/users.ts`) and pass the
  query's `signal` to `apiFetch()`. Details under Authentication → Client
  pieces.
- **Request bodies that a form also fills are validated by one Zod schema in
  `core/`, imported by both sides.** The package is `@helpdesk/core`
  (directory `core/`, a Bun workspace like the others); `createUserSchema` in
  `core/src/schemas/users.ts` is the pattern, used by `CreateUserDialog.tsx`
  through `zodResolver` and by `POST /api/users` through `parseBody()`. The
  point is that the form and the API can never disagree about what is valid,
  and that the 400 the server returns carries the same message the form
  would have shown. To add one:
  1. Create or extend `core/src/schemas/<resource>.ts`. Export the schema
     (`z.object`) and its type (`export type XInput = z.infer<typeof
     xSchema>`). Messages are user-facing sentences that name the field and
     end in a full stop (`Name must be at least 3 characters.`) - they are
     shown in the form and returned by the API as-is. Use the `text(label)`
     helper for string fields so a missing key reports `<Label> is
     required.` rather than Zod's default.
  2. Register a new file in `core/package.json` `exports`
     (`"./schemas/<resource>": "./src/schemas/<resource>.ts"`); imports are
     `@helpdesk/core/schemas/<resource>` on both sides, never a relative path
     into `core/`. `schemas/text.ts` is the exception that proves it: the
     `text(label)` helper both resource schemas build on, unexported from the
     package and imported relatively *within* `core/` only.
  3. Client: `useForm<XInput>({ resolver: zodResolver(xSchema) })` and the
     API client function takes `XInput`. Server: `parseBody(xSchema,
     req.body ?? {})` in the route (`server/src/lib/validate.ts`), which
     throws the first issue as a 400, then pass the typed result to the
     service.
  Where one resource has several shapes, compose them from shared *field*
  schemas rather than repeating the rules - `users.ts` declares `nameField`,
  `emailField` and the two password fields once, then builds
  `createUserSchema` (password required), `editUserSchema` (password
  optional) and `updateUserSchema` (every field optional, because `PATCH` is
  a partial update and `{ role }` or `{ active }` must still parse). An
  optional field that means "leave it alone" puts `.optional()` before the
  string check and transforms `''` to `undefined`, so the service only has to
  ask whether the value is set.
  Rules: nothing in `core/` may import from `client/`, `server/`, the
  browser, Bun, Express or Prisma - its tsconfig has no DOM or Bun types so
  that fails to typecheck. Server-owned fields (`role`, `active`) stay out
  of the shared schema; the route reads them separately. `bun run typecheck`
  covers `core/` through its own `typecheck` script. Two things to know:
  `bun --hot` does not watch files outside `server/`, so restart the API
  after editing `core/`; and Vite serves the package from its `.ts` source
  through the workspace symlink, so there is no build to run.
- **Forms are react-hook-form with a Zod schema**, never controlled
  `useState` fields with hand-written checks. `LoginPage.tsx` and
  `UserFormDialog.tsx` (the engine behind both user dialogs) are the two
  examples; copy their shape:
  - a `z.object({...})` schema with the user-facing message on each rule,
    and `type Values = z.infer<typeof schema>`. If the server validates the
    same body, the schema lives in `core/` (previous bullet) and both import
    it; a form the server never sees as-is - the login page, whose body goes
    to Better Auth - keeps its schema at module level in the page;
  - `useForm<Values>({ resolver: zodResolver(schema), defaultValues })` with
    every field defaulted to `''` so inputs are never uncontrolled;
  - inputs wired with `{...register('field')}` inside `Field` / `FieldLabel`
    / `Input` / `FieldError`, with `data-invalid` on the `Field` and
    `aria-invalid` on the `Input` from `errors.field`;
  - `<form noValidate onSubmit={(e) => void onSubmit(e)}>` where `onSubmit =
    handleSubmit(async (values) => ...)`, so the browser's own validation
    bubbles never appear and Zod's messages are the only ones;
  - server refusals through `setError`: a message that belongs to one field
    goes on that field (`setError('email', ...)` for the 409 duplicate), the
    rest on `setError('root', ...)`, rendered in a `<p role="alert">`; a
    network failure is the same `'Could not reach the server. Please try
    again.'` string every page uses;
  - the submit button disabled on `formState.isSubmitting`, and `reset()` on
    close for a form that lives in a dialog.
  Zod 4 details (`core/src/schemas/users.ts` shows both): use `z.email()`
  piped after `.min(1)` rather than the deprecated `.string().email()`, and
  remember `.trim()` is a transform, not
  a check - apply it to names and emails, never to a password, which must
  reach the server exactly as typed. The client-side schema only saves a
  round trip; the server validates again and is the authority.
- **A destructive action is confirmed with an `AlertDialog`**, not a `Dialog`:
  it announces as `role="alertdialog"`, focuses Cancel, and an accidental
  click on the overlay does not dismiss it. `DeleteUserDialog.tsx` is the
  pattern. Two things it gets right and a copy must too: the
  `AlertDialogAction` is a close button, so its `onClick` calls
  `event.preventDefault()` and the dialog is closed by the mutation's outcome
  instead - otherwise a server refusal disappears behind the closing modal -
  and `onOpenChange` refuses every dismissal while the mutation is pending,
  resetting it on the way in so a previous refusal is not still on screen.
  The confirmation's wording promises only what the action does: the delete is
  soft, so it says the account is kept, and it hands the user's open tickets
  back to the queue, so it says that too - an admin has to know the queue moves
  underneath them.
- **Roles are the `Role` enum, never the strings `"ADMIN"` / `"AGENT"`.**
  Write `Role.ADMIN`, compare with `=== Role.ADMIN`, type with `Role`. The
  source of truth is `enum Role` in `server/prisma/schema.prisma`, which
  Prisma 7 generates as a const object plus a same-named type
  (`server/src/generated/prisma/enums.ts`, re-exported from `client.ts`), not
  a TypeScript `enum`. Three copies exist, one per workspace, because none can
  import the others' code: the server imports the generated one; the client
  has an identical mirror in `client/src/lib/api.ts` (with an `isRole()`
  guard for URL and request values); `e2e/tests/helpers/api.ts` has a third.
  The client and e2e copies cannot be TypeScript `enum`s anyway - their
  tsconfigs set `erasableSyntaxOnly`, which forbids the keyword - and the
  const-object shape is what makes the three comparable. Adding a role means
  a Prisma migration, `bun run db:generate`, and the same line in both
  mirrors. The only string literals allowed are inside those definitions;
  `parseRole()` in `routes/users.ts` and `readFilters()` in `UsersPage.tsx`
  validate incoming text with `isRole()` rather than comparing to literals.
- **The ticket enums mirror Prisma the same way `Role` does, but live beside
  their own type.** `TicketStatus` and `TicketCategory` are const objects with
  `isTicketStatus` / `isTicketCategory` guards in `client/src/lib/tickets.ts`,
  not in `lib/api.ts`. The rule is that an enum mirror lives with the type whose
  field it is: `Role` sits in `api.ts` because it is a field of `PublicUser`,
  declared there; these are fields of `Ticket`, declared in `tickets.ts`, and the
  nearer precedent is `UserStatus` already living in `lib/users.ts`. Const
  objects rather than TypeScript `enum`s, for the same `erasableSyntaxOnly`
  reason. Server-side the rule is the one `Role` already sets: write
  `TicketStatus.OPEN` and `TicketCategory.REFUND_REQUEST`, never the strings -
  `routes/tickets.ts` keys its validation records on the enum members for
  exactly that reason.
- **API keys and secrets stay server-side.** No Claude or email provider call
  originates from the browser.

## UI

Styling is shadcn/ui on Tailwind CSS v4; `tech-stack.md` has the reasoning.

- **Build pages from the components in `client/src/components/ui/`** - `Button`,
  `Input`, `Label`, `Card`, `Badge`, `Field`, `Table`, `Select`, `Skeleton`,
  `Dialog`, `AlertDialog` so far. Import them through the
  `@/` alias (`@/components/ui/button`), which `client/tsconfig*.json` `paths`
  and `vite.config.ts` both define. Layout and spacing use Tailwind utilities
  directly on elements.
- **Add components with `npx -y shadcn@latest add <name> --yes`** from
  `client/`, not `bunx` - the CLI prints nothing and hangs under `bunx` on this
  machine. The shell has no stdin, so answer every prompt with a flag. The CLI
  still installs through Bun (it reads `bun.lock`).
- **Colours come from the theme tokens** (`bg-background`, `text-foreground`,
  `text-muted-foreground`, `text-destructive`, `border`), not raw palette
  classes such as `text-gray-500`. The tokens switch with the theme, so no
  per-element `dark:` variants are needed.
- **`client/src/index.css` is the theme**, generated by `shadcn init`. Edit the
  token values there if the palette needs to change; do not add a second
  stylesheet or per-component CSS.
- **Dark mode is the `.dark` class on `<html>`.** An inline script in
  `index.html` sets it from `prefers-color-scheme` before first paint. There is
  no in-app toggle yet.
- **A data table is TanStack Table v9 with the sorting done on the server.**
  `TicketsTable.tsx` and `UsersTable.tsx` are the two examples and the repo has
  no other table idiom - do not hand-roll the next one. The shape: `features =
  tableFeatures({ rowSortingFeature })` and `helper =
  createColumnHelper<typeof features, TRow>()` at module scope, the cell
  renderers inside the column defs (which is what makes a label-order /
  cell-order mismatch structurally impossible), and `useTable({ features,
  columns, data, manualSorting: true, enableMultiSort: false, state: {
  sorting }, onSortingChange, getRowId })`. Four of those are deliberate and
  load-bearing:
  - **`manualSorting: true` and no `sortedRowModel`.** The library owns the
    column model, the header state and the toggle cycle; the database owns the
    order. Nothing is re-sorted in the browser, because the server sorts the
    whole result set and the page shows one page of it - re-sorting the visible
    page would silently break paging. Registering a row model later is the one
    change that would undo this, which is what
    `TicketsPage.test.tsx`'s "renders rows in the order the server returned
    them" exists to catch.
  - **`getRowId`**, or React keys rows by index and a re-sort reuses DOM nodes
    across semantically different rows.
  - **Controlled `state.sorting`, derived from the URL.** The page is the only
    owner; a header click is a URL write that comes back round as new props.
    `client/src/lib/sorting.ts` holds `SortDir`, `Sort<TKey>`,
    `toSortingState()` and `sortingChangeHandler()` - the adapter from
    TanStack's updater-or-value callback to a single-column URL write, and the
    one place a column id (typed as a plain `string`) is validated back into a
    sort key. TanStack's types never reach a page.
  - **`sortDescFirst` set explicitly on every column**, as the v9 docs advise:
    the type sniffing misjudges nullable columns, and `category` is `null` on
    every row today.
  Register **no pagination feature** - `Pagination.tsx` and the server own
  paging between them, and `rowCount` does nothing without
  `rowPaginationFeature`. Headers render through
  `components/SortableHead.tsx`, which takes plain scalars rather than a
  TanStack `Header` so no v9 generic reaches our own checked code. Its rules:
  `aria-sort` goes on the `<th>` where ARIA puts it; the button's only text
  node is the column label and the direction is an `aria-hidden` lucide icon,
  **never** a text glyph or visually hidden state text, because assertions in
  both test suites compare header `textContent` against the exact label; and a
  non-sortable column (Actions) gets no `aria-sort` attribute at all rather
  than `"none"`, which would claim it is a sortable column that happens to be
  unsorted. The sort vocabulary is a per-workspace mirror with a guard, the
  same arrangement `Role` has - `TicketSortBy` in `lib/tickets.ts`,
  `UserSortBy` in `lib/users.ts`, each matching a union in the service that
  keys a `Record` of Prisma `orderBy` fragments. Column ids equal the sort keys
  exactly, so nothing needs translating.
- **Loading states are `Skeleton` placeholders shaped like the content**, not
  a "Loading…" message or a spinner. `ProtectedRoute` shows a shell skeleton
  (nav strip, heading, text lines) while the session is restored;
  `UsersTableSkeleton` in `components/UsersTable.tsx` shows the table's headers with
  placeholder rows before the first response. A skeleton carries a visually
  hidden `role="status"` text for assistive technology and is not given the
  real element's accessible name, so a test waiting for the `Users` table
  cannot match the placeholder. Once data has arrived, refetches keep the old
  content on screen (`keepPreviousData`, `aria-busy`) rather than returning
  to the skeleton.
- **`Card` is a flex column with a gap between its children.** Anything that
  wraps several card sections in one element - a `<form>` around `CardContent`
  and `CardFooter`, say - must carry the same gap
  (`flex flex-col gap-(--card-spacing)`) or the sections sit flush. The login
  page does this.

## Authentication

Better Auth, email and password only, with sessions stored in Postgres. The
reasoning is in `tech-stack.md`; this is what you need to know to work on it.

### How a request is authenticated

1. `POST /api/auth/sign-in/email` verifies the password against the hash on the
   `Account` row (`providerId: "credential"`; credentials are not on `User`),
   writes a `Session` row, and sets an `httpOnly` cookie.
2. Every protected request runs `requireAuth()`, which calls
   `auth.api.getSession()` - a database read, every time. There is deliberately
   no `session.cookieCache` and no `secondaryStorage`, so deleting the
   `Session` row (sign-out, deactivation) kills the session immediately.
3. `POST /api/auth/sign-out` deletes the row. Sessions otherwise last 7 days,
   sliding with activity (Better Auth's defaults).

Better Auth is mounted in `app.ts` as `app.all("/api/auth/*splat",
toNodeHandler(auth))` **before `express.json()`**, because it reads the raw
request stream itself. Its endpoints bypass our error middleware and return
Better Auth's own `{ data, error }` shape; everything else returns `{ error }`.

Environment (`server/src/env.ts`): `BETTER_AUTH_SECRET` is required.
`BETTER_AUTH_URL` defaults to `http://localhost:<PORT>` outside production; in
production it is required and must be `https://`, because Better Auth derives
the cookie's `Secure` flag from it. `TRUSTED_ORIGINS` is a comma-separated
list of extra origins Better Auth accepts; it defaults to the Vite dev server
outside production and is required in production. `TRUSTED_PROXIES` lists the
reverse proxies whose `X-Forwarded-For` Express believes (see rate limiting
below); unset means none.

### Server pieces

- **`server/src/lib/auth.ts`** - the `betterAuth()` instance. Do not add
  `cookieCache` or `secondaryStorage` (see above).
- **Rate limiting** is Better Auth's, on in production only: `rateLimit.enabled:
  isProduction` in `lib/auth.ts`, where `isProduction` (`env.ts`) is
  `NODE_ENV === "production"`. Production allows 100 requests per 10 s overall
  and 3 sign-in attempts per 10 s per client IP; `development` and `test` are
  never throttled, so local work and the e2e suite can sign in repeatedly.
  Better Auth only sees headers, so it cannot
  tell a real proxy header from a forged one; instead `app.ts` sets Express's
  `trust proxy` from `TRUSTED_PROXIES`, then copies `req.ip` into the
  `x-client-ip` header (`CLIENT_IP_HEADER` in `lib/auth.ts`) on every
  `/api/auth` request, overwriting whatever arrived, and Better Auth reads
  only that header. Do not add `X-Forwarded-For` to `ipAddressHeaders`.
- **`requireAuth`** (`middleware/require-auth.ts`) - 401 when there is no
  session or the user is deactivated; otherwise sets `req.user` and
  `req.session` (typed in `src/types/express.d.ts`).
- **`requireRole("ADMIN")`** (`middleware/require-role.ts`) - 403 for the wrong
  role. Mount it after `requireAuth`. It answers 403, not 401, on purpose: a
  401 would trigger the client's redirect-to-login and bounce a valid session.
- **`GET /api/me`** - the signed-in user as a `PublicUser` from the users
  service, the same shape `/api/users` returns. The client restores its session
  from this on load.
- **`/api/users`** (`routes/users.ts`, `services/users.ts`) - admin only. List,
  get, create, `PATCH` (name, role, `active: true` to restore, `active: false`
  to suspend), `DELETE` (soft-deletes - nothing is ever hard-deleted, because
  tickets a person handled still have to name them). Create validates `name`,
  `email` and `password` with `createUserSchema` from `@helpdesk/core` - the
  same schema the dialog runs - so its 400 messages are the form's messages
  (`Name is required.`, `Password must be at least 8 characters.`); `role`
  is read separately and defaults to `Role.AGENT`. `PATCH` is a partial
  update validated by `updateUserSchema`: it takes `name`, `email` and
  `password` (the edit dialog's fields) plus the older `role` and `active`.
  **Removal is two states, recorded by `deletedAt` and enforced by `active`.**
  `DELETE` sets `deletedAt = now()` *and* `active: false`; `PATCH
  { active: false }` sets only `active: false` and leaves `deletedAt` null. So
  `deletedAt != null` always implies `active === false`, and `active` stays the
  single gate every access check consults - the sign-in hook in `lib/auth.ts`
  and `requireAuth` are deliberately untouched by this, because a second
  independent gate is one more thing a future check can forget to test. The
  reachable states are active (`true`/null), deactivated (`false`/null) and
  deleted (`false`/set). `PATCH { active: true }` restores from either and
  clears `deletedAt`, so a reactivation cannot leave the invariant broken.
  Both removals share two guards, **in this order**: your own account is
  refused first ("You cannot deactivate your own account" - the same message
  from both, since only one of the two can be meant), then any `role: ADMIN`
  is refused outright, not merely the last one ("An admin cannot be deleted.
  Change their role first." / "An admin cannot be deactivated. …"). Demoting
  first is therefore the only way an admin leaves the system, which is why
  `assertNotLastActiveAdmin` is now reachable only from `updateUser`'s
  demotion path. Repeating either call is a no-op that returns the row
  unchanged.
  **Both removals hand the user's `OPEN` tickets back to the unassigned
  queue**, inside the same serializable transaction as the removal itself
  (`unassignOpenTickets` in `services/users.ts`), so there is no instant where
  the account is suspended and an open ticket still names it. `OPEN` only: on a
  `RESOLVED` or `CLOSED` ticket the assignee has stopped being a job queue and
  become the record of who dealt with it, which is the whole reason the row is
  soft-deleted rather than removed. `PATCH { active: true }` does **not** put
  them back - nothing records which tickets were taken, and one another agent
  has since picked up must not be pulled off them. `Ticket.assignedTo`'s
  `onDelete: SetNull` is still only a safety net; this is a `updateMany`, and no
  `User` row is ever removed. `DeleteUserDialog` invalidates `ticketKeys.all`
  alongside `userKeys.all` for the same reason: the detail view names an
  assignee that just changed.
  A **blank or absent `password` leaves the account's password alone**; a
  supplied one goes through `setUserPassword()` and then deletes that user's
  sessions, so the old password cannot keep a session alive - which also
  signs out an admin who changes their own password. The password write is
  outside the service's serializable transaction, because Better Auth's
  adapter cannot join one: if it fails, the name/email change has already
  committed. Changing the email is allowed and returns the same 409 as
  create when it is taken. The list accepts `?q=`
  (case-insensitive substring of name or email, trimmed, max 100 chars),
  `?role=ADMIN|AGENT`, `?status=active|inactive|deleted` (one parameter for
  the one UI control, rather than two booleans that could ask for a
  combination that never exists), `?sortBy=name|email|role|status|createdAt`
  with `?sortDir=asc|desc`, `?page=` (1-based, default 1)
  and `?pageSize=` (default 20, max 100), and returns `{ users, total, page,
  pageSize }`. A bad value is a 400 naming the field; a page past the end is
  `users: []` with the real `total`. **The default ordering is unchanged**:
  with no `sortBy` it is active first, then newest, then `id` so a row cannot
  straddle two pages - which sinks deleted rows to
  the bottom, interleaved with the deactivated ones rather than below them, so
  the Status filter rather than the order is what separates the two. **An
  absent `?status=` still means every row here** - the API's default is
  unchanged and `?status=all` is a 400, because `all` is a device the page
  invented for its own URL (see State) and never sends. That
  default is a composite no `sortBy` member names, which is why - unlike the
  ticket list, whose route defaults both parameters - `ListUsersOptions`
  leaves them optional and `services/users.ts` picks `DEFAULT_ORDER_BY` when
  `sortBy` is absent, and why a bare `/users` shows no column as sorted. A
  lone `?sortDir=` is accepted and ignored: it names no column. `sortBy=status`
  orders by `active` then `deletedAt`, which is the three-way Status the table
  shows: on `desc`, Active -> Inactive -> Deleted, because Postgres sorts NULLs
  first on DESC. Guards in the service: a user
  cannot change their own role or deactivate themselves, and the last active
  admin cannot be demoted or deactivated. The last-admin check and the write
  it guards run in one serializable transaction (`serializable()` in the
  service), retried on conflict, so two admins removing each other at once
  cannot both succeed. Deactivation sets `active: false` and deletes the
  user's sessions in the same transaction.
- **`role` and `active` are server-owned.** Declared to Better Auth as
  additional fields with `input: false`, so no request body can set them; the
  users service writes them through Prisma. A `session.create.before` hook
  refuses sign-in for a deactivated user with "This account has been
  deactivated." (`code: ACCOUNT_DEACTIVATED`).
- **There is no self-registration.** Two independent layers: `disableSignUp`
  inside Better Auth, and `blockPublicSignUp` in `app.ts`, which 404s
  `/api/auth/sign-up/*` in front of the handler so the endpoint does not
  advertise itself. `auth.api.signUpEmail()` is refused too - it runs through
  the same handler. `autoSignIn` is off, so creating an agent never hands the
  admin that agent's session.
- **Create accounts with `createUserWithPassword()`** from
  `lib/auth-accounts.ts` - the only sanctioned path, used by `POST /api/users`
  and the seed script. It writes through Better Auth's internal adapter (the
  route the library's own admin plugin takes), enforces the configured
  min/max password length itself because the sign-up endpoint that would
  normally do so is bypassed, and then re-reads the account the way sign-in
  does. The `Account.issuer` value it writes (`local:credential`) is copied
  from the library because the constant is not importable; if a `better-auth`
  upgrade changes it, account creation throws rather than producing users who
  cannot sign in. `setUserPassword()` in the same file exists for the seed
  script's `--repair` path only and is not exposed through the API.
- **Bun installs with an isolated `node_modules`.** Undeclared transitive
  packages such as `@better-auth/core` are not resolvable from our code. Use
  the public `auth.api` / `auth.$context` surface rather than importing
  internals.
- **Seeding.** Run `bun run db:seed` after migrating a fresh database. It
  creates the admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
  (`SEED_ADMIN_NAME` optional, defaults to "Admin") and never resets an
  existing account's password. If the email is taken by a non-admin or
  deactivated row it reports and exits 1; `bun run db:seed -- --repair`
  promotes that row, resets its password and clears its sessions.

### Client pieces

- **`AuthProvider`** (`client/src/auth/AuthProvider.tsx`) holds one of three
  states - `loading`, `anonymous`, `authenticated` with a `user` - and
  `useAuth()` from `auth-context.ts` reads it. `loading` exists so a page
  refresh does not flash to `/login` while `GET /api/me` is in flight.
- **The user comes from `GET /api/me`, not Better Auth's `useSession()`**, so
  the client has one `PublicUser` type rather than two. That type is declared
  in `client/src/lib/api.ts`, beside the client's copy of the `Role` enum (see
  Conventions), and mirrors `publicUserSelect` in
  `server/src/services/users.ts` - change both together, plus the third copy
  in `e2e/tests/helpers/api.ts`. `deletedAt` (`string | null` on the client,
  `null` meaning the account is live) is the most recent field to go through
  all three.
- **`authClient`** (`client/src/lib/auth-client.ts`) is used only for
  `signIn.email` and `signOut`. It has no `baseURL`: it defaults to the page's
  origin plus `/api/auth`, which Vite proxies in development.
- **`signIn()` resolves to an error message string when refused** (wrong
  credentials, deactivated account) rather than throwing; the login page shows
  it as the form-level `errors.root`. On success it re-fetches `/api/me`.
- **All other API calls go through `apiFetch()`** in `client/src/lib/api.ts`,
  an Axios instance with no `baseURL` (paths are same-origin, so the cookie
  rides along) that throws `ApiError` on non-2xx and Axios's own error when
  the server was never reached or the request was aborted. A 401 from anywhere
  fires the handler `AuthProvider` registers, which sets the state to
  `anonymous`; `ProtectedRoute` then redirects to `/login` with the original
  path in `location.state.from`, and the login page navigates back there
  after sign-in.
- **Pages read server data through TanStack Query**, never with their own
  `useEffect` + `useState` around `apiFetch()`. The `QueryClient` is
  `client/src/lib/query-client.ts`, provided in `main.tsx` above the router;
  it retries server and network failures once and 4xx never. Each resource's
  keys and `queryOptions` live beside its API client - `userKeys` and
  `userListQueryOptions()` in `lib/users.ts` are the pattern - so a page
  only does `useQuery(userListQueryOptions(params))`; the query's `signal`
  is passed through to Axios, which cancels a superseded request. The
  users page adds `placeholderData: keepPreviousData` so the table does not
  collapse between pages. `AuthProvider` calls `queryClient.clear()` on
  sign-in and sign-out, so cached data never crosses sessions. The session
  itself (`GET /api/me`) is not a query: `AuthProvider` owns that state
  machine.
- **Routing.** `/login` is public; every other route nests under
  `ProtectedRoute` then `AppLayout`, so new pages get the session gate and the
  nav bar by being placed in that branch of `App.tsx`.
- **`RequireRole`** (`client/src/auth/RequireRole.tsx`) gates routes on the
  user's role. It nests inside `ProtectedRoute` and sends the wrong role to
  `/`, not `/login` - the session is valid, the page just is not theirs.
  `/users` sits under `<RequireRole role="ADMIN" />`; put further admin-only
  routes in the same branch. This is a UX gate only; the server's
  `requireRole("ADMIN")` on `/api/users` is the security boundary.
- **Admin-only nav links** render on `user.role === 'ADMIN'` in `NavBar.tsx`,
  which reads the user from `useAuth()`. The "Users" link is the example.

### Not built

Self-service password reset, email verification (the `Verification` table is
unused), forcing a password change on first sign-in, a job that deletes
expired `Session` rows, and any rate limit on our own routes (`/api/me`,
`/api/users`) - only Better Auth's endpoints are limited. An admin *can* now
set someone's password through the edit dialog (`PATCH /api/users/:id`), but
nothing tells that person it changed - there is no email out yet.

Known gap, not yet investigated: a `POST /api/auth/sign-in/email` sent with an
`Origin` that is not in `TRUSTED_ORIGINS` (`http://evil.example`, observed
against the test API on 2026-09-14) still returned 200. Either Better Auth's
origin check does not apply to that request shape or the configuration is not
what we think. Check before relying on `TRUSTED_ORIGINS` as a CSRF defence.

## Tickets and inbound email

Support mail becomes a ticket through one webhook. The models are `Ticket`,
`Message` and `RawEmail`; `/api/tickets` reads them back.

### Where the webhook sits, and why

`app.ts` mounts it **between the Better Auth block and `express.json()`**:

```ts
app.use("/api/email", inboundEmailRouter);   // reads the raw body itself
app.use(express.json());
```

The same reason as Better Auth: the payload is `multipart/form-data` and the
signature has to be checked against the bytes as they arrived, so
`express.json()` must not have consumed the stream. The router applies its own
`express.raw({ type: "*/*", limit: "30mb" })`, so nothing else in the app is
affected. 30 MB clears SendGrid's ceiling; Mailgun's is 25 MB.

There is **no `requireAuth`** - the provider has no session, and the signature is
the authentication. Rate limiting is task 8.3.

### The provider contract

Everything vendor-specific stops inside `server/src/lib/email/`. The rest of the
system knows only `InboundEmail`:

```ts
export interface InboundProvider {
  readonly id: EmailProvider;
  verify(ctx: InboundContext): boolean;
  parse(ctx: InboundContext): InboundEmail | null;   // null = authentic but unusable
}
```

- `PROVIDERS` in `providers.ts` is a `Record<EmailProvider, InboundProvider>`, so
  adding a member to the Prisma enum is a compile error until an adapter exists.
  It lives in its own module rather than in `inbound-email.ts` deliberately: the
  adapters import that file for the shared helpers, and having it import them
  back made a cycle that threw `Cannot access 'mailgunProvider' before
  initialization` whenever an adapter was the first module loaded. Keep the
  registry downstream of both.
- **Mailgun** verifies `HMAC-SHA256(secret, timestamp + token)` against the
  `signature` field with `timingSafeEqual`, plus a 15-minute freshness window so
  a captured payload cannot be replayed forever. Note what the signature does
  *not* cover: the body bytes. That is Mailgun's design, not a shortcut here.
- **SendGrid Inbound Parse has no signature mechanism at all.** Its signed
  webhook is the Event Webhook, a different product. So `verify()` is a
  constant-time comparison of HTTP Basic credentials against
  `INBOUND_EMAIL_SECRET` - a bearer token on every request, which is genuinely
  weaker, and the reason Mailgun is the default.
- **Read threading headers from the fields *and* the header block.** Mailgun
  usually promotes `Message-Id`, `In-Reply-To` and `References` to their own form
  fields, but only usually; relying on that alone silently broke threading,
  because mail with no `Message-ID` falls back to a content fingerprint and a
  reply then opens its own ticket. Field first, then `message-headers`.
- **No RFC 2047 decoder.** `=?UTF-8?B?...?=` encoded words appear in names and
  subjects; Mailgun decodes them, SendGrid does not. The mojibake is accepted on
  purpose - see the note in `address.ts`.
- **Hostile input is truncated**: subject to 512 characters, display names to
  200, body to 256 KB. Postgres `text` would store a 10 MB subject happily and
  the list view would never recover.

### The dedupe key

`email.rfcMessageId ?? fingerprint(email)`, unique per provider, which is what
makes a webhook retry a no-op instead of a second ticket. The fingerprint is a
SHA-256 of the **parsed** fields - from, recipient, subject, body. It must never
hash the raw body: the multipart boundary is regenerated on every POST, so two
retries of one message would hash differently and dedupe nothing. That is also
why the pipeline is verify, decode, parse, dedupe key, store - not
store-then-parse.

### The two-phase write

`ingestInboundEmail()` is deliberately **not** one transaction:

1. Insert the `RawEmail` with `processedAt: null`, at ordinary isolation - a
   unique constraint holds at any level. On `P2002`, re-read the row: if
   `processedAt` is set the provider is retrying something already handled, so
   return `duplicate: true`; if it is null a previous attempt died
   mid-conversion, so **fall through to phase 2 with that row**.
2. In a `serializable()` transaction (`lib/transaction.ts`): find the parent
   message, append or create, bump `lastMessageAt`, stamp `processedAt`,
   `ticketId` and `createdMessageId`. On failure write `error` and let it 500 -
   the provider retries, and the retry resumes from the stored row.

A single all-or-nothing transaction was the obvious design and it is wrong:
rolling back discards the payload, which is the one thing `RawEmail` exists to
keep. It would also hold a serializable transaction open across a
multi-hundred-KB JSON write, and leave a future worker with no unprocessed rows
to claim.

### Threading, reopening, and what is dropped

- **No parent** found gives a new `Ticket` (`OPEN`, `category: null`,
  `assignedToId: null`) and its first inbound `Message`.
- **Parent found** appends the message, and if the ticket is `RESOLVED` **or
  `CLOSED`** it goes back to `OPEN`. Task 4.11 said only "resolved"; following
  that literally files a student's reply where no default view shows it, so the
  plan text was amended rather than deviated from silently.
- Matching is on `Message.rfcMessageId` against `[inReplyTo, ...references]`,
  closest ancestor first. **Never on subject** - "Re: Question" from two students
  is one ticket under that rule, and merging two people's requests is worse than
  splitting one person's thread.
- **`autoReply`, or `parse()` returned null**: the row stays with `error` set and
  `processedAt` null. Authentic mail, deliberately not converted, visible in the
  table. The markers are in `detectAutoReply` - `Auto-Submitted`, `Precedence`,
  `X-Autoreply`, an empty `Return-Path`, and our own `SUPPORT_EMAIL_ADDRESS`.
- `addMessage(tx, ...)` writes the message and bumps `lastMessageAt` together, so
  the two cannot drift; task 3.8's agent reply reuses it.
- **Attachment metadata is kept, the bytes are dropped** - a deliberate narrowing
  of task 4.3's "as received" until there is a blob store.
- `Ticket.body` and `Ticket.bodyHtml` are denormalised from the **first** message
  only. A later reply moves `lastMessageAt`, not these, so `body` stays the
  original request rather than drifting into whatever was said most recently.
  `bodyHtml` is `""` for plain-text mail, which is a normal value here.

### Webhook status codes

The caller is a machine that reads these as instructions.

| Status | When | Stored? | Provider does |
|---|---|---|---|
| 401 | signature, credentials or freshness failed | no | stops retrying |
| 400 | body undecodable (no content type, bad multipart) | no | stops retrying |
| 413 | body over 30 MB | no | stops retrying |
| 200 `{ duplicate: false, ticketId }` | converted | yes | done |
| 200 `{ duplicate: true, ticketId }` | already processed | yes (existing row) | done |
| 200 `{ ticketId: null }` | authentic, not converted - no sender, or auto-reply | yes, `error` set | done |
| 500 | unexpected conversion failure | yes, `error` set, `processedAt` null | retries; the retry resumes |

The 413 depends on the error handler honouring a numeric 4xx `status` on a plain
error - `express.raw`'s size refusal is not an `HttpError`. Without that branch it
would be a 500, and a provider would retry an oversized message for hours. The
same branch fixed a pre-existing bug: malformed JSON on any route used to 500.

### Testing it locally

`cd server && bun run email:test` builds a provider-shaped multipart payload,
signs it with `env.inboundEmail.secret` and POSTs it to the running API.
`--message-id` and `--in-reply-to` are what make threading and reopening
testable, which is otherwise the hardest part of the feature to verify:

```
bun run email:test --message-id "<a@x>"           # creates a ticket
bun run email:test --message-id "<a@x>"           # duplicate: true, no new ticket
bun run email:test --in-reply-to "<a@x>"          # threads onto that ticket
bun run email:test --header "Precedence: bulk"    # stored with an error, no ticket
```

Outside production `INBOUND_EMAIL_SECRET` has a fixed development default, so
this works against `bun run dev` with no configuration at all.

### Reading tickets

`GET /api/tickets` is `requireAuth` only - **no `requireRole`**. Working tickets
is the agent's job (`project-scope.md`), and `/tickets` sits outside the
`RequireRole` branch of the client route table for the same reason. Ticket ids
are sequential integers and therefore guessable, which is fine precisely because
every signed-in user may read every ticket.

Parameters: `status`, `category` (plus `none` for the unclassified), `sortBy`,
`sortDir`, `page`, `pageSize`. Returns `{ tickets, total, page, pageSize }`.
`category=none` exists because until Phase 5 every ticket has `category: null`,
so a Category filter without it would be a control that can only ever return
nothing.

**Ordering** is `sortBy` + `sortDir`, defaulting to `lastMessageAt` / `desc`
independently of each other, so `?sortDir=asc` alone is meaningful. `sortBy` is
one of `subject`, `requesterName`, `status`, `category`, `messageCount`,
`lastMessageAt` - the members are exactly the column ids the client's table
uses, so the header an agent clicks, the parameter on the wire and the server's
lookup key are one string. An `ORDER_BY` `Record` keyed by that union
(`services/tickets.ts`) replaces the old non-exhaustive ternary, and
`orderByFor` appends `{ id: "asc" }` in one place, so no sort key can be added
without the tiebreaker that stops a row straddling two pages. The old
`?sort=newest|oldest` is **retired with no alias**. Four things worth knowing:
`messageCount` orders by a relation count (`{ messages: { _count: dir } }`), not
a column, so it is the one sort no index can help; `status` and `category` carry
`{ lastMessageAt: "desc" }` as a secondary term, because with three distinct
values "sort by status" is really "group by status" and `id asc` inside a group
is the opposite of queue order - the price is that `desc` is not then the strict
inverse of `asc`; enum columns sort by Prisma **declaration** order, so `status`
gives OPEN < RESOLVED < CLOSED but `category` gives General < Technical <
Refund, whose labels read in a different order; and `category` is nullable, so
Postgres puts the unclassified last on `asc` and first on `desc`.

The list response deliberately omits three `Ticket` columns: `bodyHtml` is
untrusted sender markup and nothing on the client sanitises it, and `body` and
`assignedToId` are not on the list view.

`GET /api/tickets/:id` returns `{ ticket }` - the same row the list returns plus
`assignedTo` (`{ id, name, email }` or null) and `messages`, **oldest first**,
each `{ id, direction, fromEmail, fromName, body, createdAt }`. Same auth as the
list: `requireAuth`, no role check, no ownership check. Two columns still stay
behind. `Ticket.body` is the first message denormalised, so the thread already
carries it, and the list's rule holds here too - a field no page reads quietly
becomes part of the contract. `bodyHtml`, on the ticket and on every message, is
untrusted sender markup: this is the endpoint that will keep being tempted to
include it, and the answer is no until something sanitises it. An id that is not
a positive integer is a **404, not a 400** (`parseTicketId` in `routes/tickets.ts`):
`/api/tickets/abc` names no ticket, and "Ticket not found" is the one message the
detail page has to render anyway. A query parameter is different - there the
field name is worth saying, which is what `parseIntParam` does.

### Changing a ticket

`PATCH /api/tickets/:id` takes any of `assignedToId`, `status` and `category`
and returns the whole ticket in the detail shape, so the client replaces its
copy rather than patching it and hoping the two agree. One write for all three,
so a UI that eventually changes two at once cannot half-apply them.

**Presence is the instruction.** The keys in the body are the change; anything
absent is left alone. That is why `null` on the two nullable fields is a value
rather than a way of saying nothing - `assignedToId: null` unassigns,
`category: null` clears the classification - and why `parseTicketPatch` tests
`Object.hasOwn` rather than `!== undefined`. A body with none of the three is a
400 (`Supply at least one of assignedToId, status or category`) rather than a
200 that changed nothing, because a request asking for nothing is a client bug
and a 200 would hide it. `category` takes the enum or `null`, never the list
filter's `none`: that spelling is a query-string device, and a JSON body has a
real null to use.

`status` and `category` need no check beyond enum membership. **Every status
transition is allowed, CLOSED back to OPEN included** - a student's reply
reopens a closed ticket by itself (see the inbound rules), so an agent may do by
hand what the mail does on its own. The assignee is the one field that can name
something impossible, so it is the only one with a check in the service, and
that check and the write share a `serializable()` transaction like every other
check-then-write here: otherwise an account deactivated between the two would
still end up holding a ticket. Its refusals are user-facing sentences the client
shows as they arrive ("That user no longer exists.", "A deactivated user cannot
be assigned tickets.") and are 400s rather than 404s, since the ticket in the
path exists and it is the body that names someone impossible.

Who may change a ticket: **any signed-in user, any ticket, including one
somebody else holds** - the same reasoning as the queue being readable by
everyone. A ticket nobody can take off a colleague who is away is a ticket
nobody answers. The acting user is not recorded; tickets have no audit trail
yet, so nothing says who closed one or who reassigned it.

### Replying to a ticket

`POST /api/tickets/:id/messages` appends an agent's reply. The body is
`{ body }`, validated by `ticketReplySchema` in `@helpdesk/core` - the composer
runs the same schema, so the 400 carries the sentence the form would have shown
(`Reply is required.`, `Reply must be at most 10,000 characters.`). The reply is
trimmed before the length rules run, so whitespace is the empty reply it really
is. Ten thousand characters is far under the inbound path's 256 KB body
truncation *and* under `express.json()`'s own 100 KB default, which would
otherwise refuse a long reply with a message written by Express.

It returns **201 and the whole ticket in the detail shape**, the same contract
`PATCH` has and for the same reason: a reply changes the thread, the message
count and `lastMessageAt`, so the client replaces its copy rather than splicing
a message into it.

Four things the endpoint deliberately does:

- **The author is the session, never the body.** `req.user` supplies `fromName`
  and `fromEmail`, so no signed-in agent can write in a colleague's name. That
  makes the message the only record anywhere of who did what to a ticket -
  status, category and assignee changes still go unattributed. The address mail
  will eventually be *sent* from is `SUPPORT_EMAIL_ADDRESS`, an envelope
  question rather than a question of authorship.
- **It writes through `addMessage`** (`services/inbound-email.ts`), the inbound
  path's helper, which moves `lastMessageAt` with the message. A reply that did
  not move it would be invisible to the queue's default ordering, which reads
  the denormalised column rather than joining the thread.
- **`Ticket.body` is untouched.** It is the *first* message denormalised - the
  original request - and a reply must not rewrite what the student asked for.
- **`rfcMessageId` stays null and nothing is emailed.** Task 4.13 mints a
  Message-ID at send time so a student's reply threads back; inventing one here
  would claim a message went out that never did.

Existence check, write and the re-read of the detail share one `serializable()`
transaction, so the response is the thread with the reply already in it. Same
auth as the rest: `requireAuth`, no role check, no ownership check - any
signed-in user may reply to any ticket.

On the client the composer sits under the thread in the detail page's left
column: one textarea, an **Add reply** button, react-hook-form over the shared
schema, and its own mutation rather than `useTicketUpdate`'s, so a refusal
reports under the textarea instead of in the Details card on the other side of
the page. A refusal leaves what was typed where it is; only a stored reply
clears the field. Both writes on the page funnel their response through
`storeTicket()`, which puts the detail in the cache and invalidates
`ticketKeys.lists()`. The footer says the reply is saved on the ticket and that
nothing is emailed to the requester yet, and the button says "Add reply" rather
than "Send" - the same rule the delete confirmation follows: the wording
promises only what the action does.

### Polishing a draft reply

`POST /api/tickets/:id/polish` takes `{ body }` and returns `{ body }` - the same
draft, rewritten by a model. The only call in the system that is not Anthropic's:
OpenAI `gpt-5-nano` through the Vercel AI SDK, in `server/src/lib/ai.ts` (the
provider) and `server/src/services/polish-reply.ts` (the prompt and the rules).

**Nothing is stored.** Not the draft, not the rewrite, no `Message`, no row
anywhere - the text goes back into the textarea the agent typed it in and they
decide. That is what makes it safe to ship ahead of the AI in Phase 5 and why it
needs no confirmation step: a bad rewrite costs one press of Undo, and the
endpoint cannot put words on a ticket by itself. It is a `POST` that changes
nothing, so it answers 200, invalidates nothing and is the one request the detail
page makes that leaves the query cache alone.

Five things it deliberately does:

- **It hangs off a ticket id, because the thread is the context.** A reply
  rewritten without the question it answers loses the requester's name, the
  problem and the register the conversation is in, and reads like a form letter.
  The last six messages are sent, each truncated to 2,000 characters - latency,
  not correctness, since the tail is what a reply is answering. The thread is
  read, never written.
- **The body is `ticketReplySchema`**, the same schema the reply itself uses, so
  a draft has to be a usable reply before it is worth a round trip and the
  composer validates once for both. The schema now exports `MAX_REPLY_LENGTH`
  because the service has to respect it: a rewrite longer than the composer
  accepts would be a response the form then refuses with nothing on screen to
  say why, so that is a 502 with a sentence instead.
- **The instructions forbid three things**: inventing facts (it would put a
  promise in an agent's name that nobody made), answering the student rather than
  rewriting the draft (it would replace the agent's judgement with the model's),
  and wrapping the result in commentary (the agent would have to edit the output
  of the thing meant to save them editing). A draft that tries to talk to the
  model past those is a prompt injection an agent typed at themselves: it costs
  them a bad rewrite and nothing more, because the output is text in a textarea
  and nothing downstream executes, stores or sends it.
- **`store: false`, `reasoningEffort: 'low'`, `textVerbosity: 'low'`.** The first
  asks OpenAI to retain nothing, because the prompt carries a student's own words
  and `tech-stack.md` still lists third-party LLMs and student data as an open
  question. The other two keep a copy-edit fast enough to press a button for.
- **Every provider failure is one 502 with one sentence**, the real error logged
  rather than returned - it can carry the request body, which is a student's
  message. An empty answer is a 502 too: returning it would wipe the draft, the
  one outcome this feature must not have. The order of refusals is 404 (no such
  ticket, checked before anything is paid for), 400 (empty draft), 503 (this
  server has no `OPENAI_API_KEY`), 502 (the provider).

On the client `polishReply()` in `lib/tickets.ts` is the API client, and the
composer grows a **Polish** button *before* Add reply - that is the order of the
job: write it, improve it, add it. It is `outline` rather than the default, so
the button that actually puts the reply on the ticket stays the one the eye lands
on. Four rules it follows:

- **The draft it replaced is kept in component state**, and a **Undo polish**
  button beside a note saying the text was rewritten puts it back. A button that
  silently overwrites what somebody typed is one an agent only dares press on a
  draft they did not care about. The kept draft is forgotten when the reply
  lands - a stored reply is not something Undo should rewind.
- **The draft is remembered only once the request comes back**, so a refusal
  leaves the textarea exactly as it was and offers no Undo for something that
  never happened. Refusals go to `errors.root`, where the submit's also go: same
  textarea, same sentence to read.
- **An empty draft is a disabled button, not a validation message.** There is no
  mistake to report, and asking a model to improve nothing would be inviting it
  to write the reply itself.
- **One `busy` flag for both requests**, so either in flight disables the
  textarea and both buttons: a reply cannot be added out from under a rewrite
  about to replace it, and a rewrite cannot be asked for twice at once.
  `setValue(..., { shouldValidate: true })` because the rewrite is what gets
  submitted, so it is the text the schema has to be happy with.

### Summarising a ticket

`POST /api/tickets/:id/summary` takes **no body** and returns `{ summary }`: the
ticket and the conversation on it, summarised by a model.
`server/src/services/summarize-ticket.ts` holds the prompt and the rules; the
provider is the same `lib/ai.ts` the polisher uses.

**Nothing is stored, and that is the design rather than a stage on the way to
storing it.** There is no `Ticket.summary` column and never should be: a saved
summary is wrong the moment the next message arrives, and an agent who reads "the
student is waiting on a refund date" will not notice the refund was paid two
replies ago. A stale summary is worse than none, because it is read *instead of*
the thread. Regenerating costs a fraction of a penny; being wrong costs the
student. So every press is a fresh summary of the thread as it stands, there is no
invalidation to get right, and the endpoint may be asked again at any time.

Why a `POST` with no request body, which looks like it should be a `GET`: this
costs money per call and must never be served from a cache, and a summary is
generated rather than fetched. The route reads nothing off the request but the id.

What it sends, and how it differs from the polisher:

- **The whole conversation, up to 30 messages, each truncated to 4,000
  characters** - against the polisher's last 6 at 2,000. A summary is a claim
  about the whole thread, and cutting the middle out of one produces a summary
  that is confidently wrong about what was agreed. When the cap bites the
  **oldest** go: a summary missing the opening request is visibly incomplete,
  where one missing the latest exchange reads as complete and is not.
- **Each message is labelled with its sender *and its timestamp***, which the
  polisher's prompt omits: "what is still outstanding" usually turns on how long
  ago the last thing happened.
- **The ticket's own fields too** - subject, student, status, opened, message
  count - so the summary can say where the ticket stands, not only what was said.
- **The instructions ask for three things in order**: what the student wants, what
  has been done or promised, what is outstanding; at most 120 words; plain text,
  with short plain labels allowed but no markdown. The prohibitions are the
  polisher's and matter more here, because an agent reads a summary instead of the
  thread: invent nothing, do not resolve a contradiction, do not address the
  student, do not suggest a reply.
- **`store: false`**, as the polisher does, and it matters most on this call: the
  prompt is the entire conversation, so it carries more of a student's own words
  than anything else the system sends anywhere.

Refusals, in the order they can happen: **404** for an unusable id or a ticket
that is gone; **400** `There are no messages on this ticket to summarise.` -
checked before the model is paid for, because a model handed an empty thread would
invent one and the invention would be read as the ticket's history; **503** when
this server has no `OPENAI_API_KEY`; **502** for a provider failure, an empty
answer (shown as-is it would read as "this ticket has nothing in it", a claim the
model never made) or one over `MAX_SUMMARY_LENGTH` (2,000 - longer than that is
not a summary).

On the client `summarizeTicket()` in `lib/tickets.ts` is the API client and
`TicketSummary` in `TicketDetailPage.tsx` is the control: a **Summary** section
between the thread and the composer, in that order because that is the order of
the job - read what happened, or have it read to you, then answer. A `useMutation`
and deliberately **not** a `useQuery`: a query would hand back a cached answer, and
the whole point is that there isn't one. So the summary lives in the mutation's
state, is thrown away on navigation, and the button says what a second press does
- "Summarise ticket", then "Summarising…", then **"Regenerate summary"**. A note
beside it says the text is written by AI and not saved, because a summary that
looked saved would be trusted later when the thread had moved on. An empty thread
is a disabled button with a note rather than a refusal after the fact, the same
treatment Polish gives an empty draft; the previous summary stays on screen under
`aria-busy` while a new one is written, rather than the section collapsing.

### Classifying a ticket automatically

A new ticket is categorised by a model as it arrives. No endpoint, no button and
nothing for an agent to trigger: `services/classify-ticket.ts` is called from the
inbound path and that is the whole interface. Tasks 5.3, 5.4, 5.5 and 5.9.

**It is non-blocking, and that is the shape of the feature.** `convert()` in
`services/inbound-email.ts` enqueues `ticket.classify` on the pg-boss queue
*inside* its serializable transaction, and returns. A worker picks the job up a
second or two later and does the model call; the webhook has long since answered
the provider - measured at about 1.2s round trip including Bun's own start-up.
See Background jobs above for the queue's own rules. Three properties follow and
all three are load-bearing:

1. **The job commits with the ticket.** `enqueueInTransaction` writes the job row
   through the same `tx`, so there is no window in which a ticket exists and
   nobody has been told to classify it. A failed enqueue aborts the transaction,
   which is safe: the payload is stored, the route answers 500, and the
   provider's retry resumes from it.
2. **A failed classification cannot cost a ticket** (task 5.9). The ticket, its
   message and the `RawEmail` row are all committed before the worker picks the
   job up, so a classification that fails for good leaves a working,
   uncategorised ticket.
3. **`Ticket.category IS NULL` is still the seam**, exactly as
   `RawEmail.processedAt IS NULL` is for conversion - now for the tickets that
   predate the classifier and the ones whose jobs exhausted their three retries.
   No backfill exists.

**The service throws on a transient failure and returns `null` on a permanent
one**, which is the opposite of what it did before the queue: pg-boss holds the
promise now, and a thrown error is how a job earns its retry. A rate limit, a
timeout or an unparseable answer throws; a missing ticket, an already-classified
ticket, a lost race or a server with no `OPENAI_API_KEY` returns quietly, because
retrying those would just fill the dead-letter queue. `jobs/classify-ticket.job.ts`
is the handler and does nothing but validate the payload and call the service.

Four decisions worth knowing:

- **The write is conditional**, and it is the important line in the file:
  `updateMany({ where: { id, category: null }, data: { category } })`. Because this
  runs unawaited, an agent can open a brand-new ticket and classify it inside the
  second the model takes - and a human's answer must never be overwritten by a
  machine's. An `update` by id would have clobbered them. A `count` of 0 is logged
  and accepted. The category is also re-read before the call and the model is
  skipped entirely if it is already set, so the common case costs nothing.
- **Only a new ticket, only once.** A reply arriving on an existing thread
  enqueues nothing. The category is what the ticket is *about*, settled by the
  opening message; re-running on every message would overwrite an agent's
  correction with a guess at a follow-up that says "thanks, any update?".
  Verified twice over: a technical-sounding reply to a `REFUND_REQUEST` ticket
  leaves it `REFUND_REQUEST`, and a refund-sounding reply to a
  `TECHNICAL_QUESTION` ticket adds no second row to `pgboss.job`.
- **`Output.choice` from the AI SDK, not parsing.** The options come from
  `CATEGORY_GUIDE`, a `Record<TicketCategory, string>` of category → definition, so
  adding a fourth category is a compile error until it has a definition, and the
  list the model may answer from cannot drift from the list it is told about. The
  SDK turns that into a JSON schema whose `enum` is the three categories, so an
  invalid category is not something the provider can return (task 5.3). An off-list
  answer throws inside the SDK and is swallowed like any other failure - the ticket
  keeps no category rather than an invented one. Note the wire shape if you ever
  fake it: `Output.choice` expects `{"result":"<option>"}`, not a bare string.
- **There is no fourth "unsure" option.** `project-scope.md` says every ticket
  belongs to a single category, so doubt goes to `GENERAL_QUESTION`, which is the
  catch-all by construction; the instructions say so explicitly, along with the
  rule that an angry technical complaint is still technical unless money is asked
  for. An agent correcting it on the detail page is the other half of what the
  scope promises.

Sent: the subject and the opening message only (`Ticket.body`, truncated to 4,000
characters) - a classification turns on the first paragraph and the rest is
signature and quoted mail. `store: false`, `reasoningEffort: 'low'`,
`textVerbosity: 'low'`, and a **20s** timeout rather than the interactive features'
30s: nobody is watching, so a slow provider should cost a category rather than hold
a connection open into the next delivery. No `LlmCall` audit row (5.2) and no
prompt caching (5.8) - neither exists for the other two features either.

**The client shows nothing new**, deliberately: the category already appears on the
queue and in the detail page's editable `CategorySelect`, which is all task 5.10
asks for bar the "AI-assigned" marking - and nothing records *who* set a category,
so that marking would be a claim the database cannot support. A page open at the
moment a ticket arrives will not see the category appear; nobody is watching a
ticket at the instant it is created.

**AI and the queue are both off in the e2e stack on purpose.**
`server/.env.test` sets `OPENAI_API_KEY=` and `QUEUE_ENABLED=false`, both set
rather than left out, because Bun layers `.env.test` over `server/.env` and a
developer's own values would otherwise still be in the environment - every
inbound-email spec would enqueue and make a live classification call, and the
ticket specs expect `category: null`. With the queue off nothing is enqueued at
all, which is the cheaper of the two guards; the empty key is the belt to its
braces.

`GET /api/assignees` (`routes/assignees.ts`) is the list of people a ticket can
go to: active accounts only, `{ id, name, email, role }`, by name, unpaginated.
It is `requireAuth` with no role check, which is the whole reason it exists -
`/api/users` is admin-only from its first line, and an agent assigning a ticket
needs the candidates. A route of its own rather than a path under `usersRouter`,
so nothing has to be registered above that admin gate where the next handler
added could silently land outside it. **Admins are in the list**: working tickets
is not an admin privilege but it is not forbidden them either, and an admin who
picks a ticket up must be able to be the one holding it. Deleted accounts are
covered by the same `active: true` filter, because a deleted row always carries
`active: false`.

## Background jobs

The queue is **pg-boss**, in the application's own Postgres. `tech-stack.md` has
the reasoning; this is what you need to know to work on it. Task 4.2.

`server/src/lib/queue.ts` owns the pg-boss instance, the queue names and the
lifecycle. `server/src/jobs/` holds the handlers, one file per queue plus an
`index.ts` that registers them. Both entry points call `startQueue()` then
`startWorkers()`: `index.ts` (the API) and `worker.ts` (the workers alone).

**pg-boss keeps its own `pgboss` schema and migrates it itself on `start()`.**
Nothing in `prisma/schema.prisma` describes those tables, `bun run db:migrate`
knows nothing about them, and there is no migration to write when a queue is
added. `prisma migrate reset` on a database will drop the schema along with
everything else; pg-boss recreates it on the next start, so there is nothing to
restore.

### Enqueue inside the transaction

**`enqueueInTransaction(tx, name, data)`, not `send()` after the commit.** This
is the whole reason a Postgres-backed queue was chosen, so it is the rule rather
than an optimisation: `fromPrisma(tx)` hands pg-boss the transaction's own
connection, so the job row is written by the same transaction as the work it
describes. Either both commit or neither does, and the window where a process
commits a ticket and then dies before anyone is told to classify it does not
exist. `services/inbound-email.ts` is the example.

**It throws, and callers must not catch it.** A failed enqueue should abort the
transaction, which in the inbound path is safe rather than dangerous: the
`RawEmail` payload is already stored with `processedAt` null, the route answers
500, the provider retries, and the retry resumes from that stored row once the
queue is back. Nothing is lost - it is deferred. Swallowing the error would
instead leave a ticket nobody classifies and no record that anything went wrong.

The one case that is not an error is `QUEUE_ENABLED=false`, where the enqueue
returns `null` and does nothing. **Off is a configuration; broken is an error.**

### Writing a handler

`jobs/classify-ticket.job.ts` is the pattern. Its shape:

- **The payload is an id, not a copy of the work's input.** A job is a claim on
  work: the handler re-reads the row, so it acts on what the row says *now*
  rather than what it said when the job was written - and sees a change a human
  made in between. An id is also the only field that cannot go stale.
- **A thrown error is how a job earns its retry**, and the queue's policy is
  three attempts with exponential backoff, recorded on the queue row by
  `createQueue` so a worker in another process inherits it. So the service a
  handler calls has to throw on a *transient* failure and return quietly on a
  permanent one - see the note at the top of `services/classify-ticket.ts`, which
  spells out which is which. Getting it backwards is invisible: either a
  classification is silently lost, or the dead-letter queue fills with work that
  could never succeed.
- **A payload that will never parse is logged and completed, not retried.** Three
  attempts at something malformed is three attempts too many.
- **`batchSize` is the concurrency limit.** pg-boss hands the handler an array
  even when it holds one job; handle them in turn, because `Promise.all` would
  multiply the limit. Two for classification - a ceiling on concurrent model
  calls, so a backlog drains steadily instead of being rate limited.

### Running it

Workers run in the API process by default, which is what `bun run dev` gives.
`RUN_WORKERS=false` on the API plus `bun run worker` elsewhere splits them, which
is what the Postgres-backed queue is for: AI latency and request latency stop
competing, an API deploy no longer interrupts a classification, and a backlog is
drained by starting more workers. `worker.ts` refuses to start if either flag says
it should not be running, rather than sitting there consuming nothing and looking
healthy.

Shutdown is graceful in both: the HTTP server closes first, then `stopQueue()`
gives jobs in flight 25 seconds - longer than the classifier's own 20s model
timeout, so a stop does not abandon the job it is waiting for.

**The e2e stack runs with `QUEUE_ENABLED=false`** (`server/.env.test`), set
rather than absent for the reason `OPENAI_API_KEY=` is: Bun layers `.env.test`
over `.env`, so a developer's own value would otherwise still be in force. No
`pgboss` schema in `helpdesk_test`, no worker polling during a run, and tickets
are created uncategorised, which is what the specs expect.

## Testing

Three layers: Vitest component tests inside `client/`, `bun test` unit tests
inside `server/`, and Playwright end-to-end tests in `e2e/`. `tech-stack.md` has
the reasoning for the first and the last.

### Component tests

Vitest on jsdom with React Testing Library, inside the `client/` workspace.
They cover a page's own logic - how it turns URL state into a request, how it
renders a response, its loading, empty and error states, what its controls
write back to the URL. `client/src/pages/UsersPage.test.tsx` is the reference
for every point below; read it before writing a new test file.

**When to write one.** Every page under `client/src/pages/` gets a test file
when it is built, and the file is updated in the same change as any behaviour
it covers. Shared components in `client/src/components/` get one when they
carry logic (conditional rendering, state); pure layout does not need one.
`components/ui/` is shadcn's generated code and is not tested here. The
`AuthProvider` and route guards are exercised end to end in `e2e/` and are not
unit-tested. Component tests do not replace e2e coverage: anything that
depends on the real server - sign-in, roles, what the API actually returns -
stays in `e2e/`.

**Running.** From the repository root:

| Command | Runs |
|---|---|
| `bun run test:unit:client` | the whole client suite once (CI mode) |
| `cd client && bun run test:watch` | the suite in watch mode |
| `cd client && bunx vitest run src/pages/UsersPage.test.tsx` | one file |
| `cd client && bunx vitest run src/pages/UsersPage.test.tsx -t "debounces"` | tests whose name matches |
| `cd client && bunx vitest run --reporter=verbose` | every test by name with its result |

The suite takes under ten seconds. Run `bun run test:unit` before considering
any client change complete, alongside `bun run typecheck`; the test files are
part of the `client` tsconfig and are typechecked with everything else.
`console.log` inside a test does not reach the terminal in this setup - write to
a file or use `expect` output when debugging.

**Writing one.**

1. **Place the file beside the component**, named `<Component>.test.tsx`
   (`src/pages/UsersPage.test.tsx` next to `UsersPage.tsx`). Vitest picks up
   `src/**/*.test.{ts,tsx}`; nothing needs registering.
2. **Mock only `apiFetch`.** The test replaces the HTTP boundary and nothing
   above it:

   ```ts
   vi.mock('../lib/api.ts', async (importOriginal) => {
     const actual = await importOriginal<typeof import('../lib/api.ts')>()
     return { ...actual, apiFetch: vi.fn() }
   })
   const mockedApiFetch = vi.mocked(apiFetch)
   ```

   `ApiError` stays real, so the page's error branches run. The resource API
   client (`lib/users.ts`), TanStack Query and the router all run for real,
   which is what lets a test assert the exact request path the page builds
   (`/api/users?q=cy&role=AGENT&active=false&page=2&pageSize=2`). Do not mock
   `lib/users.ts`, `@tanstack/react-query` or `react-router`.
   Reset the mock in `beforeEach` (`mockedApiFetch.mockReset()`); respond with
   `mockResolvedValue(...)` for one shape, `mockImplementation((path) => ...)`
   when the answer depends on the request (paging), `mockRejectedValue(new
   ApiError(403, '...'))` for a refusal and `mockRejectedValue(new Error())`
   for a network failure.
3. **Render with the real providers through a `renderPage(url)` helper**: a
   fresh `QueryClient` per test with `defaultOptions.queries.retry: false`
   (otherwise an error test waits on the app client's retry), `AuthContext`
   given an `authenticated` value directly (no `AuthProvider`, no `/api/me`),
   and a `MemoryRouter` with `initialEntries: [url]` around a `Routes` table
   that mounts the page at its real path. Add a `LocationSpy` child that
   renders `useLocation().search` into a `data-testid`, and assert URL state
   through it - `window.location` never changes under `MemoryRouter`.
4. **Query by role and label**, never by class, test id (other than the spy)
   or DOM structure: `getByRole('table', { name: 'Users' })`,
   `getByLabelText('Search')`, `getByRole('combobox', { name: 'Role' })`,
   `getByRole('button', { name: 'Next' })`, `findByRole('alert')`,
   `getByRole('status')`. These are the same handles the e2e specs use, so a
   label change breaks both suites in the same way. Scope row assertions
   with `within(row)`.
5. **Interact with `userEvent.setup()`**, not `fireEvent`, so the browser's
   event sequence runs (typing fires the debounce, a click fires Radix's
   pointer handlers).
6. **Await what is asynchronous.** Data arrives after a microtask: use
   `findBy*` for the first appearance of anything that depends on a response,
   and `waitFor` for a URL change. Assert synchronously (`getBy*`,
   `queryBy*`) only for what is already on screen. Real timers throughout;
   the 300 ms search debounce is short enough to wait for. **A request that a
   URL change triggers needs its own `waitFor`**: the URL updates a render
   before TanStack Query refetches, so `waitFor(url)` followed by a bare
   `expect(requestedPaths())` is a race that passes locally and fails
   intermittently in the suite - wrap the request assertion in `waitFor` too
   (the three filter tests in `UsersPage.test.tsx` do).
7. **Cover the page's contract**, in roughly this order: initial render
   (loading placeholder, then content); the request it makes by default;
   filters read from the URL and shown in the controls; normalisation of
   values the server would refuse; each control writing the URL and the
   request that follows; pagination and its disabled ends; empty states;
   the server-refused and network-failure branches; and any snap or redirect
   the page performs on its own (a page past the end).

**jsdom gotchas** - `src/test/setup.ts` handles what it can; these need care in
the test itself:

- **Radix `Select`**: open it from the keyboard - focus the trigger, then
  `user.keyboard('{ArrowDown}')` - and `user.click` the option. Under jsdom
  the first pointer click on a trigger is dropped whenever an earlier test in
  the file used user-event, so a click-to-open test passes alone and fails
  in the suite. The `choose(user, label, option)` helper in the users test
  is the pattern; copy it rather than re-deriving it.
- **Radix in general** calls `hasPointerCapture`, `scrollIntoView` and
  `ResizeObserver`, which jsdom lacks; the setup file stubs them. If a new
  primitive throws on another missing API, stub it there, not in the test.
- **Dates**: `toLocaleDateString` follows the machine's locale, so compute
  the expected string the same way the page does rather than hardcoding it,
  and assert the `datetime` attribute for the exact value.
- **Loading placeholders** are not the element they stand in for: the users
  skeleton has `role="status"` and is `aria-hidden` without the table's
  name, so `findByRole('table', { name: 'Users' })` resolves only on real
  content. Keep that property when adding skeletons elsewhere.
- **Radix `Dialog`** (`CreateUserDialog.test.tsx` is the pattern): while it
  is open Radix sets `aria-hidden` on everything outside it, so query the
  page behind - the `Users` table, say - only after
  `waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())`.
  Closing is asynchronous (the content unmounts on a later tick), so always
  `waitFor` its absence, and settle a tick before asserting it stayed open.
  `FieldError` and the form-level `<p>` are both `role="alert"`, so assert
  messages with `findByText`, not `findByRole('alert')`. `DialogTrigger`
  opens on `user.click`; fall back to focus + `{Enter}` if the suite ever
  drops the click the way `Select` does. A click *outside* the dialog means a
  click on Radix's overlay, which has no role or accessible name - query it
  with `document.querySelector('[data-slot="dialog-overlay"]')`, the one
  place a DOM query is the right handle (`overlay()` in
  `UsersPage.test.tsx`). Escape and the overlay both dismiss under jsdom; a
  click inside the content does not, so an outside-click test is testing
  something real.

**When a test fails.** A red test after a client change is either the change
breaking behaviour or the test pinning behaviour that was meant to change.
Decide which before touching anything: fix the code if the old behaviour was
right, update the test in the same commit if the behaviour was deliberately
changed, and never loosen an assertion to get green. A test that only fails
in the suite and not alone is leaking state between tests - look for a
missing `mockReset`, a select opened by click, or a timer left running - not
a reason to add `retry` or `test.skip`. If a component test reveals a bug in
the page rather than the test, fix the page and say so.

### Server unit tests

`bun test` inside the `server/` workspace, beside the module each one covers.
The runtime is Bun and the server has no build step, so its own runner needs no
dependency and no configuration - Vitest is the client's because Vite's jsdom
setup is built around it. The eight so far cover the three AI features and the
job queue - `src/services/polish-reply.test.ts`,
`src/services/summarize-ticket.test.ts`, `src/services/classify-ticket.test.ts`,
`src/routes/tickets.polish.test.ts`, `src/routes/tickets.summary.test.ts`,
`src/lib/ai.test.ts`, `src/lib/queue.test.ts` and
`src/jobs/classify-ticket.job.test.ts`; read them, and `src/test/fakes.ts`,
before adding more.

| Command | Runs |
|---|---|
| `bun run test:unit:server` | the whole server suite (from the repository root) |
| `cd server && bun test` | the same |
| `cd server && bun test src/services/polish-reply.test.ts` | one file |
| `cd server && bun test -t "refuses an empty answer"` | tests whose name matches |

**What they cover**: a service's own logic with its outside edges replaced - the
prompt it builds, the options it sends, its guards, and how it turns a failure
into a status and a sentence. Nothing in `server/` reaches Postgres or a provider
from a unit test. Anything that needs the real database, a real session or a real
model stays in `e2e/` or stays verified by hand.

**Five rules, all of which the AI features' tests exist to demonstrate:**

1. **`mock.module` is process-global and `bun test` has no per-file isolation.**
   Every file runs in one process with one module registry, so whichever test
   file loads a module first binds it for the whole run. Two files registering
   their own fake for the same module is a test that passes alone and fails in
   the suite - which is exactly what happened here before the fakes were moved
   into one module, and again when a queue test registered a second `env` fake
   and broke nineteen tests in the classifier's file. **Every fake for every
   module goes in `src/test/fakes.ts`**, which each test file imports first - one
   registry, one order, no races. Two corollaries worth stating because both were
   violated once: a module another test file *tests* is never faked (the job test
   drives the real classifier service rather than replacing it), and a module is
   faked in exactly one place. Expose the state as
   mutable objects rather than values - a primitive export is snapshotted at
   import and later writes to it are invisible - and give it a `resetFakes()` for
   `beforeEach`. Do not pass `--concurrent`: two files driving one set of fakes at
   once would be the same bug again.
2. **Import the module under test with `await import`, not a static import.**
   `mock.module` is **not hoisted** in Bun, and the fakes module uses top-level
   `await`, so a static `import { thing } from './thing.ts'` can be evaluated
   before the fakes have finished registering - which binds the real module. The
   symptom is nasty: `classify-ticket.test.ts` bound the real Prisma client and
   silently talked to the developer's own database, where the ticket it asked
   about happened to be classified already, so every test failed with no error
   and nothing logged. A plain constant with no dependencies is safe to import
   statically; the function under test is not.
3. **Import `src/test/env-defaults.ts` first** (the fakes module already does).
   `env.ts` validates at import time and calls `process.exit(1)` on a missing
   variable, which in a test run kills the process with no failing test to explain
   it - and almost everything reaches `env.ts` through
   `middleware/error-handler.ts`. The defaults fill only what is absent, so a real
   `server/.env` still wins, and nothing is ever connected to.
4. **Replace the boundary, not the library.** The model is the AI SDK's own
   `MockLanguageModelV4` from `ai/test`, so `generateText` runs for real and the
   assertions are made against the call the service actually built. A stubbed
   `generateText` would pin nothing. The same instinct as the client's "mock only
   `apiFetch`".
5. **Annotate a fake's return type**, because `bun test` does not typecheck: an
   un-annotated fake that has drifted from the interface passes the suite and
   surfaces later as a confusing failure somewhere else. This is also why
   `@ai-sdk/provider` is a declared devDependency - it is a transitive package of
   `ai`, and Bun's isolated `node_modules` does not make those resolvable, so
   without declaring it every type `ai/test` imports silently degrades and
   assignability checks stop meaning anything.

A route is tested by mounting its router on a bare Express app with the real
`express.json()` and the real `errorHandler`, then `app.listen(0)` and `fetch`
against the port the OS picked - no supertest, and no clash with a dev server on
3000. `requireAuth` is faked to a pass-through; whether it is actually *mounted*
is an e2e question. Those tests deliberately run the real service underneath, so
what they pin is that a refusal four layers down arrives as the right status with
the right sentence.

### End-to-end tests

Playwright end-to-end tests live in the `e2e/` workspace and run with
`bun run test:e2e` against the real client and API on their own ports (3001,
5174) and a separate `helpdesk_test` database that is reset before every run.
`tech-stack.md` has the reasoning. Specs live in `e2e/tests/`.

**Delegate all e2e test work to the `e2e-test-writer` agent**
(`.claude/agents/e2e-test-writer.md`). It holds the full description of the
stack, the spec conventions, and the Prisma consent step that a database
reset from Claude Code requires. Do not write specs, start the test servers,
or run `prisma migrate reset` from the main session.

- **When to delegate**: the user asks for tests; a page or endpoint has just
  been finished and the user wants it covered; an e2e run fails and needs
  diagnosing; the UI or API changes in a way that existing specs depend on
  (a label, route, status code or error message).
- **What to tell it**: the feature or page to cover, its route(s) and the
  components involved, the behaviour expected - including the server-side
  guards the UI should surface (see Authentication: self-demotion,
  self-deactivation, last-admin) - and whether it should run the suite or
  only write specs. Point it at anything non-obvious the agent cannot read
  from the code, such as a decision the user made in conversation.
- **What it must not do**: change application code to make a test pass,
  set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` without the user saying
  yes, or point `DATABASE_URL` at anything but a `_test` database. If it
  reports an application bug behind a failing test, relay that to the user as
  a finding and fix it in the main session only when asked.
- **What to do with the result**: relay which specs were added and the exact
  run outcome. Then run `bun run typecheck` - `e2e/` is a workspace and its
  specs are typechecked with everything else.

The e2e agent owns only `e2e/`; component tests in `client/` are written in
the main session like any other client code.

## State

Phase 1 is done. Phase 2 is done on the server, and all of it is done on the
client except a restore/suspend control on the admin user page. Phase 3 has its
read half - the list and the detail page (3.1-3.3, 3.5, 3.6, 3.9a, 3.9b, 3.10) -
and nothing that writes to a ticket; Phase 4 has its inbound half (4.3-4.11,
less the queue).

Shared: `core/` holds `createUserSchema`, validated by the dialog and by
`POST /api/users` alike, and `ticketReplySchema`, validated by the reply
composer, by `POST /api/tickets/:id/messages` and by
`POST /api/tickets/:id/polish` alike - whose `MAX_REPLY_LENGTH` the polish
service imports, so a rewrite cannot come back longer than the form accepts. Nothing else about a
ticket is in `core/`: no form posts a ticket, the webhook body is a provider's
shape validated in its adapter, and a PATCH carries three server-owned enum
fields the route reads one key at a time.

Working on the server: Postgres and Prisma with migrations, pg-boss for
background jobs in that same Postgres (one queue so far, `ticket.classify`, with
`bun run worker` able to run the workers on their own), Better Auth over
database-backed sessions, `requireAuth()` and `requireRole()`, `GET /api/me`,
admin-only user management at `/api/users`, a seed script for the initial admin,
the inbound email webhook at `POST /api/email/inbound` with a Mailgun and a
SendGrid adapter behind one `InboundEmail` contract, and the ticket queue at
`GET /api/tickets` - signed-in, not admin-only. `Ticket`, `Message` and
`RawEmail` are the first application-owned tables; `Ticket` also carries `body`,
`bodyHtml` and a nullable `assignedToId` relation to `User`. `GET
/api/tickets/:id` reads one ticket with its thread, `PATCH /api/tickets/:id`
changes its assignee, status or category and `POST /api/tickets/:id/messages`
appends an agent's reply - stored on the ticket, emailed nowhere - with `GET
/api/assignees` listing who a ticket can go to; all signed-in, none
admin-only. `POST /api/tickets/:id/polish` rewrites a draft reply and `POST
/api/tickets/:id/summary` summarises the ticket and its thread, both with OpenAI
`gpt-5-nano` through the Vercel AI SDK and both storing nothing. **A new ticket is
also classified automatically**, by `services/classify-ticket.ts` running in a
pg-boss worker off a job the inbound path enqueues *inside* its own transaction -
the only AI that writes to the database and the only one nobody triggers. All three work off the one optional
secret (`OPENAI_API_KEY`; without it they log or answer 503 and the system
otherwise behaves exactly as before). `bun run email:test` exercises the whole inbound path locally
without a provider account - including the classifier, which is how it was
verified: a refund-flavoured mail became a `REFUND_REQUEST` ticket and a broken-
video one a `TECHNICAL_QUESTION`, each a second or two after the webhook had
already answered 200. See Tickets and inbound email above for the webhook's
position above `express.json()`, the dedupe key, the two-phase write and the
threading rules.

Working on the client: the login page at `/login`, an auth context that restores
the session from `GET /api/me` on load, a `ProtectedRoute` wrapper, a nav bar
showing the signed-in user with a sign-out button, a Tickets link for everyone
and a Users link for admins, a `RequireRole` wrapper, a redirect to `/login` on
any 401, and two list pages that share the same shape.

The admin user list at `/users` - a table with search, role and status filters,
sortable column headers and Previous/Next paging, all of its state in the URL
(`q`, `role`, `status`, `sortBy`, `sortDir`, `page`, `pageSize`) so a reload or
Back keeps the view. **It shows the active accounts unless the URL says
otherwise** (`DEFAULT_STATUS` in the page): removal here is soft and
deactivation reversible, so every removed account stays in the table for ever
and an unfiltered list grows into a list of mostly former colleagues. So, unlike
`role`, an absent `?status=` is not "no filter" - `?status=all` is, the one
`?status=` value that is not a `UserStatus` and the one the page keeps to
itself rather than sending (the server would refuse it). An unusable value
falls back to the default rather than widening the list, choosing Active
explicitly writes no parameter at all - the rule `page=1` already follows, so
the canonical URL stays bare - and the Status select reads "Active" on a plain
`/users`, because a filter the admin cannot see is worse than one they did not
ask for. "All statuses" is how a deleted row is found again, and the only way
back until task 2.13e adds a restore control. One knock-on: "No users yet."
is now reachable only under `?status=all`, the only view where it is true, and
an empty Active list says "No users match your filters." (the rows themselves
are rendered by `components/UsersTable.tsx`, which the page hands its data
to, whose Status cell is three-way - Active / Inactive / Deleted, the last
from `deletedAt` - and whose Actions column carries a per-row edit button and,
on anything but an admin row, a delete button), and an "Add user"
button beside the heading (`components/CreateUserDialog.tsx`) that opens a
modal with Name / Email / Password, creates an agent through `POST
/api/users`, shows a duplicate email (409) under the Email field, and on
success invalidates the list and closes; the same form, through
`components/UserFormDialog.tsx`, backs the per-row "Edit user" dialog
(`EditUserDialog.tsx`), which starts from the row's values, can change the
email, and leaves the password alone unless one is typed;
`components/DeleteUserDialog.tsx` is the delete button's confirmation - an
`AlertDialog` rather than a `Dialog`, with its own `useMutation` behind
`DELETE /api/users/:id` (see Conventions → destructive confirmations);
`client/src/lib/users.ts` is the API client, the query definitions and the
`UserSortBy` mirror, and the page reads them with TanStack Query. Every header
but Actions sorts; on a bare `/users` none of them reads as sorted, because the
default order is a composite no column describes.

The ticket queue at `/tickets` - the same pattern, deliberately: `TicketsPage`
was built from `UsersPage` and keeps its `readFilters` / `updateFilters` / URL
state / `keepPreviousData` / hold-over-error / page-past-the-end machinery, with
Status and Category selects in place of the search box and role filter, and no
header button because nothing creates a ticket from the UI. `Pagination` was
extracted out of `UsersPage` so both use it. The subject cell is a `Link` to
`/tickets/:id` and is the only live thing in a row: a link rather than a
row-wide click handler, so it has an accessible name, takes keyboard focus and
opens in a new tab. `components/TicketsTable.tsx` renders the rows - requester
name over address, an em dash for an unclassified ticket, a message count - and
`client/src/lib/tickets.ts` holds the API client, the query definitions, the
two enum mirrors, `TicketSortBy` and the detail query. Every column header is a sort control
(`sortBy` / `sortDir` in the URL, the database doing the ordering); Last message
reads as descending on a bare `/tickets`, because that *is* the default.

The ticket detail page at `/tickets/:id` (`pages/TicketDetailPage.tsx`) - where
a subject link lands. Read-only: the subject as the heading, status and category
**two columns from `lg` up**: the message thread on the left, a Details card on
the right, with the subject spanning both above them. Below `lg` they stack,
thread first - it is what an agent came to read, and it is first in the DOM too,
so the visual order and the reading order agree. The sidebar is
`lg:sticky lg:top-6`, which is what `lg:items-start` on the grid is for, and the
thread column is `minmax(0,1fr)` so an unbroken line in a message cannot widen
the page. The skeleton repeats the same grid - and carries a block for the
composer too - so nothing jumps sideways or grows downwards when the response
lands. Under the thread in the left column, in this order: a **Summary** section
whose button summarises the ticket and its conversation afresh on every press and
keeps nothing, then the reply composer, with a **Polish** button before Add reply
that sends the draft to be rewritten and an **Undo polish** beside the note that
says it was. See Replying to a ticket, Polishing a draft reply and Summarising a
ticket above.

The Details card is a description list - Status, Category, Assigned to,
Requester, Opened, Last message - with the label above each value, because a
22rem column has no room for two. The thread is one `Card` per message with a
Received / Sent badge and the time. The first three rows are controls
(`StatusSelect`, `CategorySelect`, `AssigneeSelect`): selects in the same list
as the facts that are not editable, rather than a separate toolbar saying the
same things twice. That is why the page has no status or category `Badge` - the
select shows the value - while the queue still does.

All three go through one `useTicketUpdate` mutation, so a write in flight
disables the others and every refusal reports in one place, at the foot of the
card. The
response is the whole ticket, written straight into the detail query's cache (no
refetch, no second shape to keep in step); the queue's cached pages are
invalidated instead, through `ticketKeys.lists()` rather than `all`, because
they show status and category and a change here can move a ticket out of the
filter a page was built from - while `all` would throw away the fresh detail
just stored. Each control's value is the **ticket's** field rather than what was
clicked, so a refusal needs no undo: the select never left the truth.

Two details in the selects. Radix refuses an empty value, so Unassigned and
Uncategorised are sentinels (`unassigned`, `none`) mapped to `null` on the wire.
And whoever currently holds the ticket is added to the assignee options if the
list no longer offers them (they were deactivated since), or the select would
match nothing and read as unassigned when it is not.
`client/src/lib/assignees.ts` is that list's API client, kept apart from
`lib/users.ts` because this one is readable by every signed-in user and returns
a deliberately thinner shape.
Message bodies are plain text in a `whitespace-pre-wrap` paragraph; there is no
`dangerouslySetInnerHTML` anywhere and nothing to put in one, because the
endpoint does not send `bodyHtml` - and a reply is stored as the plain text it
was typed as, so the thread stays one kind of thing. The page reads its id from `useParams` and
checks it before querying, so `/tickets/abc` shows "Ticket not found" without a
request - and a 404 from the server shows the same message, since the two are
the same miss. Its skeleton follows the list's rule: a `role="status"`
announcement with the shapes `aria-hidden` beside it, carrying none of the real
content's accessible names, so a test waiting on the `<h1>` cannot match it.
Not admin-gated, for the same reason `/tickets` is not.

Routing is React Router v7 in declarative mode. The login page is the
reference for how a form should be built: `Card` around `Field` /
`FieldLabel` / `Input` / `FieldError`, react-hook-form with a Zod resolver,
and the form-level error in `errors.root` (see Conventions → Forms);
`CreateUserDialog` is the same pattern inside a `Dialog`, with a
`useMutation` behind the submit.

Testing: Playwright is set up in `e2e/` with its own database and ports (see
Testing above); specs cover login, sign-out, protected routes, roles, the API
guards, deactivation and deletion, the users list's active-by-default Status
filter, and sorting on both lists; no e2e spec covers the ticket detail page
yet, and none covers a removal unassigning the user's open tickets. **The specs
touching the Status default (`deletion.spec.ts`, `user-management.spec.ts`) have
not been run since they were changed**: a run from Claude Code resets
`helpdesk_test` through `prisma migrate reset --force`, which Prisma 7 refuses
without `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`, and consent was not
given. They typecheck; that is all that has been verified. Vitest component tests cover both list pages and the
detail page (`UsersPage.test.tsx`, `TicketsPage.test.tsx`,
`TicketDetailPage.test.tsx`, whose polish tests fake the endpoint by path - both
of the page's POSTs are posts to a path under the ticket, and only the polish
answers with text instead of a ticket).

The AI features and the queue are the only things in `server/` with unit tests,
under `bun test`: `services/polish-reply.test.ts`,
`services/summarize-ticket.test.ts` and `services/classify-ticket.test.ts` for the
prompts, the provider options and the guards, `routes/tickets.polish.test.ts` and
`routes/tickets.summary.test.ts` for the HTTP contracts through a real Express
app, `lib/ai.test.ts` for the configured and unconfigured key, and
`lib/queue.test.ts` plus `jobs/classify-ticket.job.test.ts` for the queue - the
transactional enqueue, the disabled-vs-broken split, and which job failures are
retried. `src/test/fakes.ts` owns every fake they share and
`src/test/env-defaults.ts` keeps them off a developer's `.env`; see Testing →
Server unit tests, which is also where the `mock.module` rules that shape exists
for are written down. **No test anywhere reaches a real model**, but all three
features have been exercised against a running API with a real key: a live summary,
a live polish, and two inbound emails that classified correctly as `REFUND_REQUEST`
and `TECHNICAL_QUESTION` with a reply to the first leaving its category alone.

Not built yet, in this feature's area: an agent's reply is stored on the ticket
but never sent, so a student still hears nothing back; no record of who changed
what, so nothing says who closed a ticket or reassigned it - a reply is the one
action that names its author, through the message's own `fromName`; no job queue, so the webhook converts inline - `RawEmail.processedAt IS
NULL` is the seam a worker slots into (4.2, 4.5); no provider account or real
inbound route (4.1); attachment metadata is stored but the bytes are dropped; no
rate limit on the webhook (8.3) and none on the two AI endpoints either, which
together with the classifier are the only paths here that cost money per call -
and the classifier is the one that spends without anyone asking, one call per
inbound email, with no budget and no sampling (it does now retry, three times,
which multiplies the worst case rather than bounding it); nothing outbound at all,
so no student ever receives a reply (4.12-4.15). Of Phase 5, classification is
done (5.3-5.5, 5.9) but there is still no `LlmCall` audit row (5.2), no prompt
caching (5.8), no stored per-ticket summary (5.6, 5.7, 5.11), no suggested reply
from a knowledge base, and nothing marks a category as AI-assigned (part of 5.10)
because nothing records who set one. A backfill for the tickets that predate the
classifier does not exist either - they keep `category: null`, as do any whose
job exhausted its retries. Nothing surfaces a dead-letter job to a human: a
permanently failed classification is visible only as an uncategorised ticket and
a row in `pgboss.job`. Conversion itself is still inline rather than queued
(4.5), so the queue carries classification and nothing else yet. No seed script for sample tickets (3.4) - `email:test` makes better
demo data for this feature.

Elsewhere: a restore or suspend control on `/users` (task 2.13e; the API
has supported both since phase 2 - `PATCH { active: true | false }` - so a
deleted or deactivated user can only be brought back by hand) and no
role picker in the edit dialog. The home page at `/` is a placeholder that the
phase 7 dashboard replaces.
