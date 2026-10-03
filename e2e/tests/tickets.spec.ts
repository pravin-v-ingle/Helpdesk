import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createAgent, TEST_USER_PASSWORD } from "./helpers/api.ts";
import { signInAs } from "./helpers/auth.ts";
import { sendInboundEmail, uniqueMessageId, uniqueSubject } from "./helpers/inbound-email.ts";
import {
  findTicketBySubject,
  listTickets,
  sortHeader,
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

/** Who a seeded ticket is from. Only the requester-name sort needs to vary it. */
type Sender = { from: string; fromName: string };

const DEFAULT_SENDER: Sender = { from: SENDER, fromName: SENDER_NAME };

/** Posts one email and returns the ticket it created. */
async function seedTicket(
  request: APIRequestContext,
  label: string,
  sender: Sender = DEFAULT_SENDER,
): Promise<SeededTicket> {
  const subject = uniqueSubject(label);
  const messageId = uniqueMessageId(label.toLowerCase().replace(/\s+/g, "-"));
  const { result } = await sendInboundEmail(request, {
    from: sender.from,
    fromName: sender.fromName,
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
 * Appends one more inbound message to a seeded ticket, so its message count
 * grows by one. Threading is asserted rather than assumed: a reply that failed
 * to thread opens a ticket of its own, and the count the caller is about to
 * sort on would then be wrong for a reason no sort assertion could explain.
 */
async function replyTo(
  request: APIRequestContext,
  seeded: SeededTicket,
  label: string,
): Promise<void> {
  const { result } = await sendInboundEmail(request, {
    from: SENDER,
    fromName: SENDER_NAME,
    subject: `Re: ${seeded.subject}`,
    body: "One more message on this thread, to lengthen it.",
    // A fresh id each time: the webhook dedupes on this value, so a reused one
    // would be a replay and would add nothing.
    messageId: uniqueMessageId(label),
    inReplyTo: seeded.messageId,
  });
  if (result.ticketId !== seeded.ticketId) {
    throw new Error(
      `Reply "${label}" landed on ticket ${result.ticketId}, not on ${seeded.ticketId}.`,
    );
  }
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

/**
 * The sort keys in the page's URL. Read as parsed parameters rather than
 * compared as a whole query string, so the assertion pins which keys are
 * present and what they say without also pinning the order `URLSearchParams`
 * happens to write them in. `null` for both is the default order, which is
 * spelled as the absence of the keys - in the URL and on the wire alike.
 */
function sortParams(page: Page): { sortBy: string | null; sortDir: string | null } {
  const params = new URL(page.url()).searchParams;
  return { sortBy: params.get("sortBy"), sortDir: params.get("sortDir") };
}

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
 * How `GET /api/tickets` orders a page: `[...ORDER_BY[sortBy](sortDir),
 * { id: "asc" }]` (`server/src/services/tickets.ts`), with the route defaulting
 * the pair to `lastMessageAt` / `desc` when neither parameter is sent
 * (`server/src/routes/tickets.ts`). The single `?sort=newest|oldest` these
 * tests used to send is gone with no alias, so `?sort=` is now just an unknown
 * parameter that the query parser ignores rather than refuses.
 *
 * Each test seeds its tickets in an order matching *neither* direction of the
 * key under test, so a server that ignored `sortBy` and kept returning activity
 * order would fail both assertions rather than half of them.
 *
 * Two of the six sortable columns cannot be covered here yet. Nothing writes a
 * ticket's `status` (`PATCH /api/tickets/:id` is task 3.7) or its `category`
 * (the Phase 5 classifier), so every ticket the webhook can produce is `OPEN`
 * with `category: null`, and ordering by a column with one distinct value
 * asserts nothing. Deliberately not `test.skip`s: a skip reads as a defect to
 * come back to, and there is none - only a feature that does not exist. Add
 * them when a ticket's status or category can change.
 *
 * The table's own sort controls are in "Sorting the queue from the table".
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

    // Neither sort parameter: the route's default is `lastMessageAt` / `desc`.
    // `pageSize` is pinned rather than left at the default 20, which other
    // specs' tickets could fill.
    const newest = await listTickets(request, { pageSize: 100 });
    expect(orderOf(subjectsOf(newest.tickets), seeded)).toEqual([c.subject, b.subject, a.subject]);

    const oldest = await listTickets(request, {
      sortBy: "lastMessageAt",
      sortDir: "asc",
      pageSize: 100,
    });
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

  test("sorts by subject in both directions", async ({ request }) => {
    // Seeded out of alphabetical order on purpose: newest-activity order is
    // then Bravo, Alpha, Charlie, which is neither expectation below. The
    // expected order is read off the labels - the subjects differ at their
    // sixth character, before the timestamp `uniqueSubject` appends - and never
    // off the subjects the server returned.
    const charlie = await seedTicket(request, "Sort Charlie");
    const alpha = await seedTicket(request, "Sort Alpha");
    const bravo = await seedTicket(request, "Sort Bravo");
    const seeded = [alpha, bravo, charlie];

    const ascending = await listTickets(request, {
      sortBy: "subject",
      sortDir: "asc",
      pageSize: 100,
    });
    expect(orderOf(subjectsOf(ascending.tickets), seeded)).toEqual([
      alpha.subject,
      bravo.subject,
      charlie.subject,
    ]);

    const descending = await listTickets(request, {
      sortBy: "subject",
      sortDir: "desc",
      pageSize: 100,
    });
    expect(orderOf(subjectsOf(descending.tickets), seeded)).toEqual([
      charlie.subject,
      bravo.subject,
      alpha.subject,
    ]);
  });

  test("sorts by message count, the one key that is an aggregate", async ({ request }) => {
    // `messageCount` is not a column: it is `{ messages: { _count: dir } }`, a
    // join and a GROUP BY rather than an ORDER BY over stored data. It is the
    // one sort key whose SQL shape is different, so it is the one that most
    // deserves a test against a real database.
    const three = await seedTicket(request, "Count Three");
    const one = await seedTicket(request, "Count One");
    const two = await seedTicket(request, "Count Two");
    const seeded = [one, two, three];

    // The replies also leave activity order as Two, Three, One - again neither
    // of the expectations below, so neither can pass on the default ordering.
    await replyTo(request, three, "count-three-second");
    await replyTo(request, three, "count-three-third");
    await replyTo(request, two, "count-two-second");

    const [rowOne, rowTwo, rowThree] = await Promise.all([
      seededRow(request, one),
      seededRow(request, two),
      seededRow(request, three),
    ]);
    // The counts the sort is about, stated before it is exercised: three equal
    // counts would fall back to the `id` tiebreaker and look like a sort.
    expect([rowOne.messageCount, rowTwo.messageCount, rowThree.messageCount]).toEqual([1, 2, 3]);

    const ascending = await listTickets(request, {
      sortBy: "messageCount",
      sortDir: "asc",
      pageSize: 100,
    });
    expect(orderOf(subjectsOf(ascending.tickets), seeded)).toEqual([
      one.subject,
      two.subject,
      three.subject,
    ]);

    const descending = await listTickets(request, {
      sortBy: "messageCount",
      sortDir: "desc",
      pageSize: 100,
    });
    expect(orderOf(subjectsOf(descending.tickets), seeded)).toEqual([
      three.subject,
      two.subject,
      one.subject,
    ]);
  });

  test("sorts by requester name", async ({ request }) => {
    // Three senders rather than two: with two tickets one direction is always
    // the newest-first default as well, and the test could not tell a working
    // sort from an ignored parameter. Seeded Zoe, Ada, Mia, so the default
    // order is Mia, Ada, Zoe.
    const zoe = await seedTicket(request, "Requester Zoe", {
      from: "zoe.zimmer@example.com",
      fromName: "Zoe Zimmer",
    });
    const ada = await seedTicket(request, "Requester Ada", {
      from: "ada.lovelace@example.com",
      fromName: "Ada Lovelace",
    });
    const mia = await seedTicket(request, "Requester Mia", {
      from: "mia.mirren@example.com",
      fromName: "Mia Mirren",
    });
    const seeded = [ada, mia, zoe];

    // The display name is what the column shows and what the key orders by;
    // the address is only the tiebreaker, and these three names are distinct.
    const rows = await Promise.all(seeded.map((ticket) => seededRow(request, ticket)));
    expect(rows.map((row) => row.requesterName)).toEqual([
      "Ada Lovelace",
      "Mia Mirren",
      "Zoe Zimmer",
    ]);

    const ascending = await listTickets(request, {
      sortBy: "requesterName",
      sortDir: "asc",
      pageSize: 100,
    });
    expect(orderOf(subjectsOf(ascending.tickets), seeded)).toEqual([
      ada.subject,
      mia.subject,
      zoe.subject,
    ]);

    const descending = await listTickets(request, {
      sortBy: "requesterName",
      sortDir: "desc",
      pageSize: 100,
    });
    expect(orderOf(subjectsOf(descending.tickets), seeded)).toEqual([
      zoe.subject,
      mia.subject,
      ada.subject,
    ]);
  });

  test("refuses an unknown sortBy", async ({ request }) => {
    // `request.get` directly: the `listTickets` helper asserts a 200.
    const res = await request.get("/api/tickets", { params: { sortBy: "bogus" } });

    expect(res.status()).toBe(400);
    // The message is the point. The route joins the keys of its own `SORT_BYS`
    // record to build it, so this string is the sortable column list itself and
    // cannot drift from the set the server accepts.
    expect(await res.json()).toEqual({
      error: "sortBy must be subject, requesterName, status, category, messageCount, lastMessageAt",
    });
  });

  test("refuses an unknown sortDir", async ({ request }) => {
    // A valid `sortBy` alongside it, so the 400 can only be about the direction.
    const res = await request.get("/api/tickets", {
      params: { sortBy: "subject", sortDir: "sideways" },
    });

    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: "sortDir must be asc or desc" });
  });
});

test.describe("Sorting the queue from the table", () => {
  test("the Subject header sorts ascending, then descending, then back to the default", async ({
    page,
    request,
  }) => {
    // Seeded out of alphabetical order, so the order the page opens in
    // (Bravo, Alpha, Charlie) is neither of the two sorted orders below.
    const charlie = await seedTicket(request, "Click Charlie");
    const alpha = await seedTicket(request, "Click Alpha");
    const bravo = await seedTicket(request, "Click Bravo");
    const seeded = [alpha, bravo, charlie];
    const unsorted = [bravo.subject, alpha.subject, charlie.subject];

    // `pageSize` is URL state with no control of its own. The queue is shared
    // by the whole run, so without it a subject sort could scatter these three
    // across pages, and `orderOf` reads one page.
    await page.goto("/tickets?pageSize=100");
    await expect(ticketRow(page, alpha.subject)).toBeVisible();

    const subject = sortHeader(page, "Subject");
    const toggle = subject.getByRole("button", { name: "Subject" });
    // Sortable but unsorted is `aria-sort="none"`, not a missing attribute -
    // the missing attribute is reserved for a column that cannot sort at all.
    await expect(subject).toHaveAttribute("aria-sort", "none");
    await expect
      .poll(async () => orderOf(await ticketSubjectsInOrder(page), seeded))
      .toEqual(unsorted);

    await toggle.click();

    await expect.poll(() => sortParams(page)).toEqual({ sortBy: "subject", sortDir: "asc" });
    await expect(subject).toHaveAttribute("aria-sort", "ascending");
    await expect
      .poll(async () => orderOf(await ticketSubjectsInOrder(page), seeded))
      .toEqual([alpha.subject, bravo.subject, charlie.subject]);

    await toggle.click();

    await expect.poll(() => sortParams(page)).toEqual({ sortBy: "subject", sortDir: "desc" });
    await expect(subject).toHaveAttribute("aria-sort", "descending");
    await expect
      .poll(async () => orderOf(await ticketSubjectsInOrder(page), seeded))
      .toEqual([charlie.subject, bravo.subject, alpha.subject]);

    // A third click clears the sort rather than cycling back to ascending, and
    // clearing it removes both keys: the default is spelled as their absence
    // and never written out, so nothing is left in the URL but the `pageSize`
    // this test put there itself.
    await toggle.click();

    await expect(page).toHaveURL("/tickets?pageSize=100");
    await expect(subject).toHaveAttribute("aria-sort", "none");
    await expect
      .poll(async () => orderOf(await ticketSubjectsInOrder(page), seeded))
      .toEqual(unsorted);
  });
});
