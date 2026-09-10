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
- [ ] 2.13 Build the admin user management page.
- [x] 2.14 Redirect to login on a 401 anywhere in the client.

**Done when**: the seeded admin can log in, create an agent, and that agent can log in. Agents cannot reach admin pages.

---

## Phase 3 - Tickets

Built against seeded data, before email exists.

- [ ] 3.1 Add the `Ticket` model: status enum (`OPEN`, `RESOLVED`, `CLOSED`), category enum (`GENERAL_QUESTION`, `TECHNICAL_QUESTION`, `REFUND_REQUEST`), requester email and name, subject, timestamps.
- [ ] 3.2 Add the `Message` model for the emails and replies on a ticket, with an inbound or outbound direction.
- [ ] 3.3 Add indexes for the columns the list view filters and sorts on.
- [ ] 3.4 Write a seed script that creates sample tickets and messages.
- [ ] 3.5 Implement `GET /api/tickets` with pagination, filter by status and category, and sort by date.
- [ ] 3.6 Implement `GET /api/tickets/:id` returning the ticket and its messages.
- [ ] 3.7 Implement `PATCH /api/tickets/:id` to change status and category.
- [ ] 3.8 Implement `POST /api/tickets/:id/messages` to add an agent reply (stored only for now).
- [ ] 3.9 Build the ticket list page with a table, pagination, filters, and sorting.
- [ ] 3.10 Build the ticket detail page showing the message thread.
- [ ] 3.11 Add status and category controls to the detail page.
- [ ] 3.12 Add the reply composer to the detail page.
- [ ] 3.13 Add loading, empty, and error states to both pages.

**Done when**: an agent can browse, filter, and sort tickets, open one, change its status and category, and write a reply.

---

## Phase 4 - Email

- [ ] 4.1 Configure the email provider account, sending domain, and inbound route.
- [ ] 4.2 Add the job queue and a worker process.
- [ ] 4.3 Add a `RawEmail` model that stores the incoming provider payload as received.
- [ ] 4.4 Implement the inbound webhook endpoint with provider signature verification.
- [ ] 4.5 Make the webhook store the payload, queue a job, and return 200 immediately.
- [ ] 4.6 Skip payloads whose provider message ID has already been processed.
- [ ] 4.7 Implement the parse job: extract sender, subject, body, and headers.
- [ ] 4.8 Strip quoted replies and signatures from the message body.
- [ ] 4.9 Create a ticket from a parsed email.
- [ ] 4.10 Attach replies to the existing ticket by matching `In-Reply-To` and `References` against stored message IDs.
- [ ] 4.11 Reopen a resolved ticket when the student replies to it.
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
