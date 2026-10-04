# Implementation plan

Phased task breakdown for the AI-powered ticket management system.
See `project-scope.md` for scope and `tech-stack.md` for technology choices.

Tasks are numbered `<phase>.<task>`. Each phase ends with something that works and can be demonstrated.

---

## Phase 1 - Project setup

- [x] 1.1 Create the repository with `client/` and `server/` folders and a README.
- [x] 1.2 Set up the Express + TypeScript server.
- [x] 1.3 Set up the React + TypeScript client .
- [ ] 1.4 setup postgres database
<!-- - [ ] 1.5 Write `docker-compose.yml` for local development: Postgres, server, client.
- [ ] 1.6 Initialise Prisma and connect to the local database.
- [ ] 1.7 Load configuration from environment variables and commit `.env.example`.
- [ ] 1.8 Add a `GET /health` endpoint.
- [ ] 1.9 Add central error-handling middleware.
- [ ] 1.10 Proxy `/api` from the client to the server in development and verify a call succeeds. -->

<!-- **Done when**: `docker compose up` runs the database, API, and client, and the client can call the API. -->

---

## Phase 2 - Authentication and users

Tasks 2.2 to 2.6 were written before **Better Auth** was adopted. It supplies
the hashing, the session table and the endpoints, so those tasks are met by
configuring it rather than by writing the code. The endpoint names are its own:

| Plan | Actual |
|---|---|
| `POST /api/auth/login` | `POST /api/auth/sign-in/email` |
| `POST /api/auth/logout` | `POST /api/auth/sign-out` |
| `GET /api/auth/me` | `GET /api/me` (ours, wrapping Better Auth's session) |

- [x] 2.1 Add the `User` and `Session` models with the `Role` enum to the Prisma schema and migrate.
- [x] 2.2 Add password hashing and verification helpers. *(Better Auth)*
- [x] 2.3 Add session creation - random token, store its hash, set an expiry. *(Better Auth)*
- [x] 2.4 Implement `POST /api/auth/login`, setting the session cookie. *(Better Auth)*
- [x] 2.5 Implement `POST /api/auth/logout`, deleting the session row. *(Better Auth)*
- [x] 2.6 Implement `GET /api/auth/me` for restoring client state on load.
- [x] 2.7 Add `requireAuth()` middleware.
- [x] 2.8 Add `requireRole('ADMIN')` middleware.
- [x] 2.9 Write the seed script that creates the initial admin account.
- [x] 2.10 Implement admin user endpoints: list, create agent, edit, deactivate.
- [x] 2.11 Build the login page.
- [x] 2.12 Build the auth context and protected route wrapper.
- [x] 2.13a Build the admin user list page: `/users` shows a searchable, filterable, paginated table; `GET /api/users` gains `q`, `role`, `status`, `page`, `pageSize`.
- [x] 2.13b Add the create-user dialog to `/users`.
- [x] 2.13c Add the edit-user dialog to `/users`: per-row edit button, `PATCH` accepts name, email and an optional password.
- [x] 2.13d Add a delete action to `/users`: per-row trash button behind a confirmation modal, `DELETE` soft-deletes by setting `deletedAt` and `active: false`, admins are refused, and the row stays in the list as "Deleted".
- [ ] 2.13e Add a restore (and suspend/reactivate) control to `/users`. The API has supported it since 2.10 - `PATCH { active: true | false }` - but no button invokes it, so a deleted or deactivated user can only be brought back by hand.
- [x] 2.14 Redirect to login on a 401 anywhere in the client.
- [x] 2.15 Scaffold Playwright end-to-end testing in an `e2e/` workspace against a separate `helpdesk_test` database, reset and seeded on every run. No specs yet.

**Done when**: the seeded admin can log in, create an agent, and that agent can log in. Agents cannot reach admin pages.

---

## Phase 3 - Tickets

Built against seeded data, before email exists.

- [x] 3.1 Add the `Ticket` model: status enum (`OPEN`, `RESOLVED`, `CLOSED`), category enum (`GENERAL_QUESTION`, `TECHNICAL_QUESTION`, `REFUND_REQUEST`), requester email and name, subject, timestamps.
- [x] 3.2 Add the `Message` model for the emails and replies on a ticket, with an inbound or outbound direction.
- [x] 3.3 Add indexes for the columns the list view filters and sorts on. (Covers the filters and the default order. Every column became sortable in 3.9b and `subject`, `requesterName` and the message count are deliberately left unindexed - see the note on `Ticket`'s `@@index` block for the reasoning and the trigger to revisit.)
- [ ] 3.4 Write a seed script that creates sample tickets and messages.
- [x] 3.5 Implement `GET /api/tickets` with pagination, filter by status and category, and sort by date.
- [x] 3.6 Implement `GET /api/tickets/:id` returning the ticket and its messages. (The list row plus `assignedTo` and the thread, oldest message first. `Ticket.body` is left out - it is the first message denormalised, so the thread already carries it - and `bodyHtml`, on the ticket and on every message, stays server-side until something sanitises it. A non-numeric id is a 404, not a 400.)
- [ ] 3.7 Implement `PATCH /api/tickets/:id` to change status and category.
- [ ] 3.8 Implement `POST /api/tickets/:id/messages` to add an agent reply (stored only for now).
- [x] 3.9a Build the ticket list page: `/tickets` shows a paginated table with status and category filters, all of its state in the URL. Not admin-gated - working tickets is the agent's job.
- [x] 3.9b Make every column header on `/tickets` a sort control, with the sorting done on the server. TanStack Table v9 owns the column model and the toggle cycle; `sortBy` and `sortDir` live in the URL and go to the API. The old `?sort=newest|oldest` is retired. `/users` migrated to the same idiom in the same change.
- [x] 3.10 Build the ticket detail page showing the message thread. `/tickets/:id`, reached from the subject link on the queue. Read-only: subject, status, category, requester, assignee, and the thread with each message's direction and time. Loading, not-found and error states included (3.13's half for this page).
- [x] 3.10a Assign a ticket from the detail page. `PATCH /api/tickets/:id` takes `{ assignedToId }` (a user id, or `null` to unassign) and returns the whole ticket; `GET /api/assignees` lists the active accounts it can go to, signed-in rather than admin-only, because `/api/users` is closed to agents. Any signed-in user may assign any ticket to anyone, admins included - nothing records who did it. Not in the original plan: the schema carried `assignedToId` from 3.1 and this fills it in.
- [ ] 3.11 Add status and category controls to the detail page.
- [ ] 3.12 Add the reply composer to the detail page.
- [ ] 3.13 Add loading, empty, and error states to both pages.

**Done when**: an agent can browse, filter, and sort tickets - by any column, in either direction, with the choice surviving a reload - open one, change its status and category, and write a reply.

---

## Phase 4 - Email

Tasks 4.3 to 4.11 are done, with two deliberate gaps. The webhook converts
inline rather than queueing, so 4.2 and 4.5 are deferred together - and the seam
they slot into is already there:

| Deferred | Why it is safe to defer | The seam |
|---|---|---|
| 4.2 job queue and worker | Nothing in the inbound path makes an AI call yet; the classifier is Phase 5. | `RawEmail.processedAt IS NULL` is the query a worker claims from. |
| 4.5 store, queue, return 200 | With no queue there is nothing to queue. The store still happens first. | A payload is written before conversion, so a failure leaves it recoverable and the provider's retry resumes from that row. |

Also outstanding: 4.1 needs DNS and a provider account outside this repo -
everything built here is exercised by `bun run email:test`, which signs a
provider-shaped payload locally. Attachment *metadata* is stored; the bytes are
dropped until there is a blob store to put them in.

- [ ] 4.1 Configure the email provider account, sending domain, and inbound route.
- [ ] 4.2 Add the job queue and a worker process.
- [x] 4.3 Add a `RawEmail` model that stores the incoming provider payload as received.
- [x] 4.4 Implement the inbound webhook endpoint with provider signature verification. *(Mailgun: HMAC-SHA256 over `timestamp + token`, plus a 15-minute freshness window. SendGrid Inbound Parse has **no signature mechanism at all** - its signed webhook is the Event Webhook, a different product - so that adapter authenticates with HTTP Basic credentials embedded in the parse URL. This is why Mailgun is the default.)*
- [ ] 4.5 Make the webhook store the payload, queue a job, and return 200 immediately.
- [x] 4.6 Skip payloads whose provider message ID has already been processed.
- [x] 4.7 Implement the parse job: extract sender, subject, body, and headers.
- [x] 4.8 Strip quoted replies and signatures from the message body.
- [x] 4.9 Create a ticket from a parsed email.
- [x] 4.10 Attach replies to the existing ticket by matching `In-Reply-To` and `References` against stored message IDs.
- [x] 4.11 Reopen a resolved **or closed** ticket when the student replies to it. *(Amended from "resolved": filing a reply under a closed ticket leaves it where no default view shows it, which is the failure this product exists to prevent.)*
- [ ] 4.12 Implement the outbound send service.
- [ ] 4.13 Set threading headers on outbound mail so student replies come back to the same ticket.
- [ ] 4.14 Wire the reply composer to actually send the email.
- [ ] 4.15 Show send status on each outbound message.

**Done when**: an email creates a ticket, an agent reply is delivered, and the student's reply lands on the same ticket.

---

## Phase 5 - AI classification and summaries

- [ ] 5.1 Add the Claude client wrapper with timeouts and retries.
- [ ] 5.2 Add the `LlmCall` model logging model, prompt version, tokens, cost, latency, and ticket for every call.
- [ ] 5.3 Write the classification prompt with a structured output schema restricted to the three categories.
- [ ] 5.4 Implement the classification job, run when a ticket is created.
- [ ] 5.5 Store the AI category and let an agent override it.
- [ ] 5.6 Write the summarisation prompt.
- [ ] 5.7 Implement the summary job, re-running when a new message arrives.
- [ ] 5.8 Apply prompt caching to the fixed part of the prompt.
- [ ] 5.9 Make ticket creation succeed even when an AI call fails.
- [ ] 5.10 Show the category on the ticket list and detail pages, marked as AI-assigned and editable.
- [ ] 5.11 Show the summary on the ticket detail page.

**Done when**: new tickets arrive already categorised and summarised, and agents can correct the category.

---

## Phase 6 - Knowledge base and suggested replies

- [ ] 6.1 Add the `KbArticle` model: title, body, category, and status.
- [ ] 6.2 Implement knowledge base CRUD endpoints for admins.
- [ ] 6.3 Build the knowledge base admin page: list, create, edit, retire.
- [ ] 6.4 Write the first set of articles for the most common questions.
- [ ] 6.5 Pass the article list to the model so it can select the relevant ones for a ticket.
- [ ] 6.6 Write the reply drafting prompt, including tone guidance and a requirement to cite the articles used.
- [ ] 6.7 Implement the draft generation job, run after classification.
- [ ] 6.8 Produce no draft when no article covers the question, rather than an invented answer.
- [ ] 6.9 Build the suggested reply panel on the ticket detail page, showing the cited articles.
- [ ] 6.10 Let an agent accept the draft into the composer, edit it, or discard it.
- [ ] 6.11 Record whether each sent reply was AI-written, AI-edited, or written by hand.

**Done when**: agents see a drafted reply with its sources and can send or edit it in one step.

---

## Phase 7 - Dashboard

- [ ] 7.1 Implement the dashboard metrics endpoint.
- [ ] 7.2 Build the dashboard page with ticket counts by status and by category.
- [ ] 7.3 Add ticket volume over time.
- [ ] 7.4 Add draft acceptance rate and category override rate.
- [ ] 7.5 Link every dashboard tile through to a filtered ticket list.

**Done when**: opening the app shows the current state of the queue at a glance.

---

## Phase 8 - Deployment

- [ ] 8.1 Write production Dockerfiles for the client and server.
- [ ] 8.2 Lock CORS to known origins and set the production cookie flags.
- [ ] 8.3 Add rate limiting to the login and webhook endpoints.
- [ ] 8.4 Provision the cloud environment: container hosting and managed Postgres.
- [ ] 8.5 Move secrets into the provider's secret manager.
- [ ] 8.6 Run migrations as a release step before new containers take traffic.
- [ ] 8.7 Configure database backups.
- [ ] 8.8 Add error tracking and log collection.
- [ ] 8.9 Point the real support mailbox at the system and go live.

**Done when**: the system runs in production against real support email.
