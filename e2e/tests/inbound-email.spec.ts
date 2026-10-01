import { test, expect } from "@playwright/test";
import {
  buildMailgunPayload,
  postInboundEmail,
  sendInboundEmail,
  uniqueMessageId,
  uniqueSubject,
  type IngestResult,
} from "./helpers/inbound-email.ts";
import {
  findTicketBySubject,
  ticketCells,
  ticketCount,
  ticketRow,
  ticketsTable,
  TicketStatus,
} from "./helpers/tickets.ts";

/**
 * The inbound email webhook, end to end: a signed payload arrives at
 * `POST /api/email/inbound` and the ticket it produces is read back through
 * `GET /api/tickets` and seen in the browser on `/tickets`.
 *
 * The webhook has no session - the Mailgun signature is its authentication -
 * so these specs sign their own payloads with `INBOUND_EMAIL_SECRET` from
 * `server/.env.test`. Every request goes through the client origin (5174), so
 * the Vite proxy is in the path exactly as it is for the pages.
 *
 * Each test uses its own Message-ID and subject: the webhook deduplicates on
 * the former and the specs find their ticket by the latter, so sharing either
 * would make tests depend on each other inside the one shared database.
 */

const SENDER = "ada@example.com";
const SENDER_NAME = "Ada Lovelace";
const BODY = "Hello,\n\nI cannot see my enrolment for next term. Could you check?\n\nThanks,\nAda";

test.describe("Inbound email to ticket", () => {
  test("a signed email becomes an open ticket and shows up on the tickets page", async ({
    page,
    request,
  }) => {
    const subject = uniqueSubject("Help with my enrolment");
    const { result } = await sendInboundEmail(request, {
      from: SENDER,
      fromName: SENDER_NAME,
      subject,
      body: BODY,
      messageId: uniqueMessageId("enrolment"),
    });

    expect(result.duplicate).toBe(false);
    expect(result.ticketId).not.toBeNull();
    expect(result.rawEmailId).toBeGreaterThan(0);

    // The API's view of it first: status, category and message count are what
    // the table below renders, so a mismatch localises to one side or the other.
    const ticket = await findTicketBySubject(request, subject);
    expect(ticket).toBeDefined();
    expect(ticket?.id).toBe(result.ticketId);
    expect(ticket?.status).toBe(TicketStatus.OPEN);
    expect(ticket?.category).toBeNull();
    expect(ticket?.requesterEmail).toBe(SENDER);
    expect(ticket?.requesterName).toBe(SENDER_NAME);
    expect(ticket?.messageCount).toBe(1);

    // And what an agent sees. The row is found by its subject cell, so this
    // also asserts the subject survived the round trip unchanged.
    await page.goto("/tickets");
    await expect(ticketsTable(page)).toBeVisible();

    const row = ticketRow(page, subject);
    await expect(row).toHaveCount(1);
    const cells = ticketCells(row);
    await expect(cells.requester).toContainText(SENDER_NAME);
    await expect(cells.requester).toContainText(SENDER);
    await expect(cells.status).toHaveText("Open");
    // An em dash: nothing has classified it, and nothing can until Phase 5.
    await expect(cells.category).toHaveText("—");
    await expect(cells.messages).toHaveText("1");
  });

  test("a reply threads onto the same ticket instead of opening a second", async ({
    page,
    request,
  }) => {
    const subject = uniqueSubject("Transcript request");
    const firstMessageId = uniqueMessageId("transcript");
    const { result: first } = await sendInboundEmail(request, {
      from: SENDER,
      fromName: SENDER_NAME,
      subject,
      body: "Could you send my transcript?",
      messageId: firstMessageId,
    });

    const before = await ticketCount(request);

    // The reply quotes the first message's id in In-Reply-To (and References),
    // which is what the threading lookup matches on - not the subject.
    const replySubject = `Re: ${subject}`;
    const { result: reply } = await sendInboundEmail(request, {
      from: SENDER,
      fromName: SENDER_NAME,
      subject: replySubject,
      body: "Any news on this? Thanks.",
      messageId: uniqueMessageId("transcript-reply"),
      inReplyTo: firstMessageId,
    });

    expect(reply.ticketId).toBe(first.ticketId);
    expect(reply.duplicate).toBe(false);
    expect(await ticketCount(request)).toBe(before);

    const ticket = await findTicketBySubject(request, subject);
    // The thread keeps the subject it opened with; the reply's "Re:" is not a
    // ticket of its own.
    expect(ticket?.id).toBe(first.ticketId);
    expect(ticket?.messageCount).toBe(2);
    expect(await findTicketBySubject(request, replySubject)).toBeUndefined();

    await page.goto("/tickets");
    const row = ticketRow(page, subject);
    await expect(row).toHaveCount(1);
    await expect(ticketCells(row).messages).toHaveText("2");
    await expect(ticketRow(page, replySubject)).toHaveCount(0);
  });

  test("a replayed payload is reported as a duplicate and creates nothing", async ({ request }) => {
    const subject = uniqueSubject("Fee statement");
    const message = {
      from: SENDER,
      fromName: SENDER_NAME,
      subject,
      body: "Please resend my fee statement.",
      messageId: uniqueMessageId("fees"),
    };

    const { payload, result: first } = await sendInboundEmail(request, message);
    const before = await ticketCount(request);

    // The identical bytes a provider retrying a delivery would send - same
    // Message-ID, same signature, same timestamp.
    const res = await postInboundEmail(request, payload);

    expect(res.status()).toBe(200);
    const replay = (await res.json()) as IngestResult;
    expect(replay.duplicate).toBe(true);
    expect(replay.ticketId).toBe(first.ticketId);
    // The same stored payload answered it, rather than a second one.
    expect(replay.rawEmailId).toBe(first.rawEmailId);

    expect(await ticketCount(request)).toBe(before);
    const ticket = await findTicketBySubject(request, subject);
    expect(ticket?.messageCount).toBe(1);
  });

  test("rejects a tampered signature with 401 and writes nothing", async ({ request }) => {
    const subject = uniqueSubject("Tampered delivery");
    const payload = buildMailgunPayload({
      from: SENDER,
      fromName: SENDER_NAME,
      subject,
      body: "This one was not signed by the provider.",
      messageId: uniqueMessageId("tampered"),
    });
    const before = await ticketCount(request);

    // One hex digit changed: same length, so the constant-time compare is
    // reached rather than short-circuiting on the length.
    const tampered = {
      ...payload,
      signature: payload.signature!.replace(/.$/, (last) => (last === "0" ? "1" : "0")),
    };

    const res = await postInboundEmail(request, tampered);

    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid webhook signature" });
    expect(await ticketCount(request)).toBe(before);
    expect(await findTicketBySubject(request, subject)).toBeUndefined();

    // The payload itself was fine: signed properly, the same fields do create a
    // ticket. Without this the test would also pass if the route rejected
    // everything.
    const accepted = await postInboundEmail(request, payload);
    expect(accepted.status()).toBe(200);
    expect(((await accepted.json()) as IngestResult).ticketId).not.toBeNull();
    expect(await findTicketBySubject(request, subject)).toBeDefined();
  });
});
