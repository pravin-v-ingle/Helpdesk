import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  buildMailgunPayload,
  MAX_SIGNATURE_AGE_MS,
  postInboundEmail,
  postRawInboundBody,
  sendInboundEmail,
  uniqueMessageId,
  uniqueSubject,
  type IngestResult,
  type InboundMessage,
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

/**
 * Asserts that a payload was authentic and stored, and deliberately produced no
 * ticket: `200` with `ticketId: null`, a `RawEmail` id all the same, and nothing
 * added to the queue. The count is read before the send, so this also catches a
 * ticket opened under some other subject.
 */
async function expectStoredButNotConverted(
  request: APIRequestContext,
  message: InboundMessage,
): Promise<void> {
  const before = await ticketCount(request);

  const { result } = await sendInboundEmail(request, message);

  expect(result.ticketId).toBeNull();
  expect(result.duplicate).toBe(false);
  // Stored even though it was not converted - that is what `RawEmail` is for,
  // and it is the difference between suppressing a message and losing it.
  expect(result.rawEmailId).toBeGreaterThan(0);
  expect(await ticketCount(request)).toBe(before);
  expect(await findTicketBySubject(request, message.subject)).toBeUndefined();
}

test.describe("Inbound email the webhook stores without converting", () => {
  /**
   * An autoresponder must not open a ticket per message it bounces back. Three
   * of the markers `detectAutoReply` reads are covered because they are
   * independent branches, and mail in the wild carries whichever its sender's
   * software happens to set.
   */
  test("an auto-reply marked Precedence: bulk opens no ticket", async ({ request }) => {
    await expectStoredButNotConverted(request, {
      from: SENDER,
      fromName: SENDER_NAME,
      subject: uniqueSubject("Out of office"),
      body: "I am away from the office until next week.",
      messageId: uniqueMessageId("bulk"),
      headers: [["Precedence", "bulk"]],
    });
  });

  test("an RFC 3834 Auto-Submitted reply opens no ticket", async ({ request }) => {
    await expectStoredButNotConverted(request, {
      from: SENDER,
      fromName: SENDER_NAME,
      subject: uniqueSubject("Automatic reply"),
      body: "This is an automatic response. Please do not reply.",
      messageId: uniqueMessageId("auto-submitted"),
      // Any value but `no` means a machine wrote it.
      headers: [["Auto-Submitted", "auto-replied"]],
    });
  });

  test("a bounce with an empty Return-Path opens no ticket", async ({ request }) => {
    await expectStoredButNotConverted(request, {
      from: SENDER,
      fromName: SENDER_NAME,
      subject: uniqueSubject("Undelivered Mail Returned to Sender"),
      body: "The message could not be delivered to one or more recipients.",
      messageId: uniqueMessageId("bounce"),
      // `<>` is a delivery failure notice: there is no address to reply to.
      headers: [["Return-Path", "<>"]],
    });
  });

  test("mail with no usable sender address opens no ticket", async ({ request }) => {
    // Authentic - the signature is valid - but `parse()` returns null, because
    // neither the From header nor the envelope sender holds an address, and a
    // ticket with no one to reply to is worse than no ticket.
    await expectStoredButNotConverted(request, {
      from: "not-an-address",
      fromName: "Junk Sender",
      subject: uniqueSubject("Nobody to reply to"),
      body: "There is no address anywhere in this payload.",
      messageId: uniqueMessageId("no-sender"),
    });
  });
});

test.describe("Inbound email the webhook refuses", () => {
  test("rejects a correctly signed payload that is too old", async ({ request }) => {
    const subject = uniqueSubject("Stale delivery");
    const message: InboundMessage = {
      from: SENDER,
      fromName: SENDER_NAME,
      subject,
      body: "Captured once and replayed much later.",
      messageId: uniqueMessageId("stale"),
    };
    const before = await ticketCount(request);

    // Signed properly, just not recently: the signature covers the timestamp
    // and never expires on its own, so without the freshness window a single
    // captured payload could be resent forever.
    const stale = buildMailgunPayload({
      ...message,
      signedAt: Date.now() - (MAX_SIGNATURE_AGE_MS + 60_000),
    });

    const res = await postInboundEmail(request, stale);

    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid webhook signature" });
    expect(await ticketCount(request)).toBe(before);
    expect(await findTicketBySubject(request, subject)).toBeUndefined();

    // The age was the only thing wrong with it: the same message signed now is
    // accepted, so this test cannot pass by the route refusing everything.
    const { result } = await sendInboundEmail(request, message);
    expect(result.ticketId).not.toBeNull();
    expect(await findTicketBySubject(request, subject)).toBeDefined();
  });

  test("answers 400, not 500, for a body it cannot decode", async ({ request }) => {
    const before = await ticketCount(request);

    // A multipart content type whose boundary never appears in the body - the
    // shape a misconfigured or truncated delivery actually takes.
    const res = await postRawInboundBody(
      request,
      "this body has nothing to do with the boundary it claims",
      "multipart/form-data; boundary=----boundaryThatDoesNotAppear",
    );

    // 400 rather than 500 is the point: a 500 tells the provider to retry, and
    // a body that does not decode will not decode on the tenth attempt either.
    // Nothing is stored, because there is nothing in it to recover.
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Could not decode the request body");
    expect(await ticketCount(request)).toBe(before);
  });
});

test.describe("Deduplication without a Message-ID", () => {
  test("a resent payload with no Message-ID is still a duplicate", async ({ request }) => {
    // No Message-Id at all, which is legal and rare. The dedupe key falls back
    // to a fingerprint of the *parsed* fields - sender, recipient, subject,
    // body - and this is the test that tells that apart from a hash of the raw
    // body, which would dedupe nothing: the two posts below differ on the wire.
    const message: InboundMessage = {
      from: SENDER,
      fromName: SENDER_NAME,
      subject: uniqueSubject("Fingerprinted enquiry"),
      body: "Could someone confirm my timetable, please?",
    };
    const before = await ticketCount(request);

    const { payload: firstPayload, result: first } = await sendInboundEmail(request, message);
    expect(first.duplicate).toBe(false);
    expect(first.ticketId).not.toBeNull();
    expect(await ticketCount(request)).toBe(before + 1);

    // Dated a minute earlier, so the timestamp, token and signature all differ,
    // and Playwright generates a fresh multipart boundary per request on top of
    // that. The bytes are therefore genuinely different; only the parsed fields
    // are the same.
    const { payload: secondPayload, result: second } = await sendInboundEmail(request, {
      ...message,
      signedAt: Date.now() - 60_000,
    });
    expect(secondPayload.timestamp).not.toBe(firstPayload.timestamp);
    expect(secondPayload.token).not.toBe(firstPayload.token);
    expect(secondPayload.signature).not.toBe(firstPayload.signature);

    expect(second.duplicate).toBe(true);
    expect(second.ticketId).toBe(first.ticketId);
    // The same stored payload answered it, rather than a second row.
    expect(second.rawEmailId).toBe(first.rawEmailId);

    expect(await ticketCount(request)).toBe(before + 1);
    const ticket = await findTicketBySubject(request, message.subject);
    expect(ticket?.messageCount).toBe(1);
  });
});

/**
 * Deliberately not covered here, so the gaps are not mistaken for oversights:
 *
 * - **A reply reopening a RESOLVED or CLOSED ticket.** There is no write
 *   endpoint for a ticket yet (`PATCH /api/tickets/:id` is task 3.7), and a
 *   spec may only reach the stack through the browser or the `request` fixture,
 *   so there is no sanctioned way to put a ticket into either status first.
 *   Verified by hand; untested until 3.7 lands, at which point it belongs
 *   beside the threading test above.
 * - **413 for an oversized body.** It needs a POST of more than 30 MB, which
 *   costs seconds of wall clock on every run and is the kind of test that fails
 *   for reasons unrelated to the limit it checks.
 * - **The SendGrid adapter.** `server/.env.test` pins
 *   `INBOUND_EMAIL_PROVIDER=mailgun` and the run starts one API process, so
 *   SendGrid's HTTP Basic `verify()` and its single header-block parsing are
 *   unreachable from here without a second stack.
 */
