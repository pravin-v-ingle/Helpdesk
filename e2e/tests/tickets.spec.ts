import { test, expect, type APIRequestContext } from "@playwright/test";
import { createAgent, TEST_USER_PASSWORD } from "./helpers/api.ts";
import { signInAs } from "./helpers/auth.ts";
import { sendInboundEmail, uniqueMessageId, uniqueSubject } from "./helpers/inbound-email.ts";
import { listTickets, ticketRow, ticketsTable, TicketStatus } from "./helpers/tickets.ts";

/**
 * The ticket queue at `/tickets`: who may see it, and the filters it keeps in
 * the URL. The webhook is how tickets get here, so a test that needs a row
 * posts one (see `inbound-email.spec.ts` for the webhook's own coverage).
 */

const SENDER = "grace@example.com";
const SENDER_NAME = "Grace Hopper";

/** Posts one email and returns the subject its ticket will carry. */
async function seedTicket(request: APIRequestContext, label: string): Promise<string> {
  const subject = uniqueSubject(label);
  await sendInboundEmail(request, {
    from: SENDER,
    fromName: SENDER_NAME,
    subject,
    body: "Posting this so the queue has a row to show.",
    messageId: uniqueMessageId(label.toLowerCase().replace(/\s+/g, "-")),
  });
  return subject;
}

test.describe("Tickets page", () => {
  test("lists the queue and reaches it from the nav bar", async ({ page, request }) => {
    const subject = await seedTicket(request, "Queue from the nav bar");

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
    const subject = await seedTicket(request, "Filtered ticket");

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
    const subject = await seedTicket(request, "Agent visible ticket");
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
