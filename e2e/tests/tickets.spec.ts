import { test, expect, type APIRequestContext } from "@playwright/test";
import { createAgent, TEST_USER_PASSWORD } from "./helpers/api.ts";
import { signInAs } from "./helpers/auth.ts";
import { sendInboundEmail, uniqueMessageId, uniqueSubject } from "./helpers/inbound-email.ts";
import {
  findTicketBySubject,
  listTickets,
  type Ticket,
  ticketRow,
  ticketsTable,
  ticketSubjectsInOrder,
  TicketStatus,
} from "./helpers/tickets.ts";

/**
 * The ticket queue at `/tickets`: who may see it, and the filters it keeps in
 * the URL. The webhook is how tickets get here, so a test that needs a row
 * posts one (see `inbound-email.spec.ts` for the webhook's own coverage).
 */

const SENDER = "grace@example.com";
const SENDER_NAME = "Grace Hopper";

/** What `seedTicket` hands back: enough to find the row, and to reply to it. */
type SeededTicket = {
  subject: string;
  ticketId: number;
  /** The Message-ID posted, which a reply threads onto as `In-Reply-To`. */
  messageId: string;
};

/** Posts one email and returns the ticket it created. */
async function seedTicket(request: APIRequestContext, label: string): Promise<SeededTicket> {
  const subject = uniqueSubject(label);
  const messageId = uniqueMessageId(label.toLowerCase().replace(/\s+/g, "-"));
  const { result } = await sendInboundEmail(request, {
    from: SENDER,
    fromName: SENDER_NAME,
    subject,
    body: "Posting this so the queue has a row to show.",
    messageId,
  });
  // Fresh, authentic, non-auto-reply mail always converts; a null id would mean
  // the payload was stored on purpose without becoming a ticket.
  if (result.ticketId === null) throw new Error(`Seeding "${subject}" produced no ticket.`);
  return { subject, ticketId: result.ticketId, messageId };
}

/** The list row for a seeded ticket. Scans every page, so paging cannot hide it. */
async function seededRow(request: APIRequestContext, seeded: SeededTicket): Promise<Ticket> {
  const ticket = await findTicketBySubject(request, seeded.subject);
  if (!ticket) throw new Error(`No ticket in the list for "${seeded.subject}".`);
  return ticket;
}

/**
 * The seeded subjects in the order a list returned them, with every other
 * spec's tickets dropped. Order assertions use this rather than an absolute
 * position: the queue is shared by the whole run, and Playwright shards spec
 * files across workers, so neither `tickets[0]` nor a whole page is stable.
 */
function orderOf(subjects: string[], seeded: SeededTicket[]): string[] {
  const wanted = new Set(seeded.map((ticket) => ticket.subject));
  return subjects.filter((subject) => wanted.has(subject));
}

const subjectsOf = (tickets: Ticket[]): string[] => tickets.map((ticket) => ticket.subject);

const millis = (timestamp: string): number => new Date(timestamp).getTime();

test.describe("Tickets page", () => {
  test("lists the queue and reaches it from the nav bar", async ({ page, request }) => {
    const { subject } = await seedTicket(request, "Queue from the nav bar");

    await page.goto("/");
    await page.getByRole("banner").getByRole("link", { name: "Tickets" }).click();

    await expect(page).toHaveURL("/tickets");
    await expect(page.getByRole("heading", { name: "Tickets" })).toBeVisible();
    await expect(ticketsTable(page)).toBeVisible();
    await expect(ticketRow(page, subject)).toBeVisible();
  });

  test("keeps the status and category filters in the URL across a reload", async ({
    page,
    request,
  }) => {
    const { subject } = await seedTicket(request, "Filtered ticket");

    await page.goto("/tickets");
    const row = ticketRow(page, subject);
    await expect(row).toBeVisible();

    const status = page.getByRole("combobox", { name: "Status" });
    const category = page.getByRole("combobox", { name: "Category" });

    await status.click();
    await page.getByRole("option", { name: "Open" }).click();

    await expect(page).toHaveURL(`/tickets?status=${TicketStatus.OPEN}`);
    await expect(status).toContainText("Open");
    // A new ticket is OPEN and unclassified, so it survives both filters.
    await expect(row).toBeVisible();

    await category.click();
    await page.getByRole("option", { name: "Uncategorised" }).click();

    await expect(page).toHaveURL(`/tickets?status=${TicketStatus.OPEN}&category=none`);
    await expect(category).toContainText("Uncategorised");
    await expect(row).toBeVisible();

    // The point of keeping the filters in the URL: a reload is the same view.
    await page.reload();

    await expect(page).toHaveURL(`/tickets?status=${TicketStatus.OPEN}&category=none`);
    await expect(status).toContainText("Open");
    await expect(category).toContainText("Uncategorised");
    await expect(row).toBeVisible();

    // A filter the row cannot match empties the table rather than ignoring it.
    await status.click();
    await page.getByRole("option", { name: "Resolved" }).click();

    await expect(page).toHaveURL(`/tickets?status=${TicketStatus.RESOLVED}&category=none`);
    await expect(ticketRow(page, subject)).toHaveCount(0);
    await expect(page.getByText("No tickets match your filters.")).toBeVisible();
  });
});

test.describe("Tickets and roles", () => {
  test("an agent can work the queue but is still refused the users page", async ({
    browser,
    baseURL,
    request,
  }) => {
    const { subject } = await seedTicket(request, "Agent visible ticket");
    const agent = await createAgent(request, "Queue Agent");
    const { context, page } = await signInAs(browser, baseURL, agent.email, TEST_USER_PASSWORD);

    // The nav link is unconditional: tickets are the agent's job.
    const nav = page.getByRole("banner");
    await expect(nav.getByRole("link", { name: "Tickets" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Users" })).toHaveCount(0);

    await page.goto("/tickets");
    await expect(ticketsTable(page)).toBeVisible();
    await expect(ticketRow(page, subject)).toBeVisible();

    // `GET /api/tickets` has `requireAuth` and deliberately no `requireRole`.
    const list = await listTickets(context.request);
    expect(list.tickets.map((ticket) => ticket.subject)).toContain(subject);

    // The admin-only page is still not theirs, and the refusal leaves the
    // session alone - they land on `/`, not on `/login`.
    await page.goto("/users");
    await expect(page).toHaveURL("/");
    const refused = await context.request.get("/api/users");
    expect(refused.status()).toBe(403);

    await context.close();
  });
});

/**
 * `GET /api/tickets` orders by `[{ lastMessageAt: direction }, { id: "asc" }]`
 * (`server/src/services/tickets.ts`) and defaults to `sort=newest`
 * (`server/src/routes/tickets.ts`). These pin that server behaviour; `/tickets`
 * itself has no sort control yet (task 3.9b), so the page is only read with the
 * default order.
 */
test.describe("Ticket ordering", () => {
  test("lists newest activity first by default, and oldest first on request", async ({
    request,
  }) => {
    // Seeded one at a time, so the expected order is known from the sequence
    // below and never read back off the returned timestamps - which would make
    // the assertion agree with whatever the server did. The guard is that the
    // `id` tiebreaker is hard-coded `asc` and does not flip with direction, so a
    // three-way tie in `lastMessageAt` would return creation order under *both*
    // directions: the newest-first assertion is the one that would then fail.
    const a = await seedTicket(request, "Order A");
    const b = await seedTicket(request, "Order B");
    const c = await seedTicket(request, "Order C");

    const seeded = [a, b, c];
    const [rowA, rowB, rowC] = await Promise.all([
      seededRow(request, a),
      seededRow(request, b),
      seededRow(request, c),
    ]);

    // Strictly increasing, so the tie above is ruled out diagnosably rather
    // than waited out with a sleep.
    expect(millis(rowA.lastMessageAt)).toBeLessThan(millis(rowB.lastMessageAt));
    expect(millis(rowB.lastMessageAt)).toBeLessThan(millis(rowC.lastMessageAt));

    // No `sort` at all: the route's default is `newest`. `pageSize` is pinned
    // rather than left at the default 20, which other specs' tickets could fill.
    const newest = await listTickets(request, { pageSize: 100 });
    expect(orderOf(subjectsOf(newest.tickets), seeded)).toEqual([c.subject, b.subject, a.subject]);

    const oldest = await listTickets(request, { sort: "oldest", pageSize: 100 });
    expect(orderOf(subjectsOf(oldest.tickets), seeded)).toEqual([a.subject, b.subject, c.subject]);
  });

  test("a reply moves its ticket to the top of the queue", async ({ page, request }) => {
    // Three fresh tickets rather than test 1's: that test has to observe the
    // unbumped order, and three extra posts are cheap next to the diagnosis a
    // shared fixture would cost.
    const a = await seedTicket(request, "Bump A");
    const b = await seedTicket(request, "Bump B");
    const c = await seedTicket(request, "Bump C");
    const seeded = [a, b, c];

    const { result } = await sendInboundEmail(request, {
      from: SENDER,
      fromName: SENDER_NAME,
      subject: `Re: ${a.subject}`,
      body: "Replying to the oldest of the three, so its last activity is now.",
      // A fresh id: the webhook dedupes on this value, so reusing A's would be
      // a replay and change nothing.
      messageId: uniqueMessageId("bump-a-reply"),
      inReplyTo: a.messageId,
    });

    // It must have threaded onto A. A reply that failed to thread opens a *new*
    // ticket, which also sits on top of the queue - the order assertion below
    // would then pass for exactly the wrong reason.
    expect(result.ticketId).toBe(a.ticketId);

    const [rowA, rowB, rowC] = await Promise.all([
      seededRow(request, a),
      seededRow(request, b),
      seededRow(request, c),
    ]);
    expect(rowA.messageCount).toBe(2);

    const newest = await listTickets(request, { pageSize: 100 });
    expect(orderOf(subjectsOf(newest.tickets), seeded)).toEqual([a.subject, c.subject, b.subject]);

    // The half that makes the test mean something: A is still the *oldest* of
    // the three by creation, so the order above cannot be a `createdAt` sort.
    // `addMessage` bumps `lastMessageAt` only, which is the key being pinned.
    expect(millis(rowA.createdAt)).toBeLessThan(millis(rowB.createdAt));
    expect(millis(rowA.createdAt)).toBeLessThan(millis(rowC.createdAt));

    // The product claim, in the table an agent actually reads. `readFilters`
    // takes `pageSize` from the URL (clamped to 100), so no control is needed.
    // `expect.poll` waits past the first load and `keepPreviousData`.
    await page.goto("/tickets?pageSize=100");
    // The reply does not rewrite the ticket's `subject` column, so the row is
    // still found under A's original subject - not a `Re:` of it.
    await expect(ticketRow(page, a.subject)).toBeVisible();
    await expect
      .poll(async () => orderOf(await ticketSubjectsInOrder(page), seeded))
      .toEqual([a.subject, c.subject, b.subject]);
  });

  test("refuses an unknown sort", async ({ request }) => {
    // `request.get` directly: the `listTickets` helper asserts a 200.
    const res = await request.get("/api/tickets", { params: { sort: "bogus" } });

    expect(res.status()).toBe(400);
    // The message is the point - it is what pins the parameter's vocabulary.
    expect(await res.json()).toEqual({ error: "sort must be newest or oldest" });
  });
});
