/**
 * Turning a received email into a ticket.
 *
 * The pipeline the route runs is verify → decode → parse → dedupe key → store
 * → convert. Parsing comes *before* storing on purpose: the dedupe key is a
 * fingerprint of the parsed fields when the mail carries no Message-ID, and a
 * fingerprint of the raw bytes would be useless - the multipart boundary is
 * regenerated on every POST, so two retries of the same message would hash
 * differently and dedupe nothing.
 */
import { createHash } from "node:crypto";
import { Prisma } from "../generated/prisma/client.ts";
import type { EmailProvider } from "../generated/prisma/enums.ts";
import { prisma } from "../lib/prisma.ts";
import { serializable } from "../lib/transaction.ts";
import type { InboundEmail } from "../lib/email/inbound-email.ts";

export type IngestResult = {
  rawEmailId: number;
  /** Null when the payload was stored but deliberately not converted. */
  ticketId: number | null;
  /** The provider is retrying something already handled; nothing was created. */
  duplicate: boolean;
};

/** Why a stored payload was not converted. Written to `RawEmail.error`. */
const REASON_AUTO_REPLY =
  "Auto-reply or bounce: stored but not converted, so an autoresponder cannot open a ticket per message.";
const REASON_UNPARSEABLE =
  "No usable sender address in the payload: there is no one to file a ticket under.";

/**
 * Stores an inbound payload and converts it into a ticket.
 *
 * `email` is `null` when the adapter authenticated the payload but could not
 * make sense of it. That is still stored - the whole point of `RawEmail` - with
 * `error` set and `processedAt` left null.
 *
 * Two phases, not one transaction. Rolling a failed conversion back would
 * discard the payload, which is the one thing this table exists to keep; a
 * single transaction would also hold a serializable lock open across a
 * multi-hundred-KB JSON write, and would leave a future worker with no
 * unprocessed rows to claim. The two phases keep both properties the single
 * transaction had - no duplicate tickets, and a retry that genuinely
 * reprocesses - and lose none of the payload.
 */
export async function ingestInboundEmail(
  provider: EmailProvider,
  email: InboundEmail | null,
  payload: unknown,
): Promise<IngestResult> {
  const dedupeKey = email ? (email.rfcMessageId ?? fingerprint(email)) : fingerprintPayload(payload);

  // --- phase 1: store the payload ------------------------------------------
  // Ordinary isolation is enough: the unique constraint on (provider,
  // dedupeKey) holds at any level, and it is the constraint - not a read - that
  // decides which of two concurrent deliveries is the first.
  const stored = await storeRawEmail(provider, dedupeKey, payload);

  // Already converted on an earlier delivery of the same message. Task 4.6:
  // the provider is retrying, so answer 200 and create nothing.
  if (stored.duplicate && stored.rawEmail.processedAt !== null) {
    return {
      rawEmailId: stored.rawEmail.id,
      ticketId: stored.rawEmail.ticketId,
      duplicate: true,
    };
  }

  // A row with `processedAt` null - whether new, or left behind by an attempt
  // that died mid-conversion - falls through to phase 2 and is converted now.
  const rawEmailId = stored.rawEmail.id;

  if (!email) {
    await markUnconverted(rawEmailId, REASON_UNPARSEABLE);
    return { rawEmailId, ticketId: null, duplicate: false };
  }

  if (email.autoReply) {
    await markUnconverted(rawEmailId, REASON_AUTO_REPLY);
    return { rawEmailId, ticketId: null, duplicate: false };
  }

  // --- phase 2: convert -----------------------------------------------------
  try {
    return await convert(rawEmailId, email);
  } catch (err) {
    // The payload is safe in the table with `processedAt` still null, so the
    // provider's retry resumes from it rather than starting over. The error is
    // recorded for the row and then rethrown, which is what makes the route
    // answer 500 and the provider retry at all.
    await recordFailure(rawEmailId, err);
    throw err;
  }
}

/**
 * Inserts the payload, or finds the row that already holds it.
 *
 * `P2002` on `(provider, dedupeKey)` is the expected outcome of a retry, not an
 * error: the row is re-read so the caller can tell a completed delivery from an
 * abandoned one. The re-read cannot come back empty in practice - nothing ever
 * deletes a `RawEmail` - but a missing row is treated as a conflict worth
 * surfacing rather than silently swallowed.
 */
async function storeRawEmail(provider: EmailProvider, dedupeKey: string, payload: unknown) {
  try {
    const rawEmail = await prisma.rawEmail.create({
      data: {
        provider,
        dedupeKey,
        payload: payload as Prisma.InputJsonValue,
      },
      select: RAW_EMAIL_FIELDS,
    });
    return { rawEmail, duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    const existing = await prisma.rawEmail.findUnique({
      where: { provider_dedupeKey: { provider, dedupeKey } },
      select: RAW_EMAIL_FIELDS,
    });
    if (!existing) throw err;

    return { rawEmail: existing, duplicate: true };
  }
}

const RAW_EMAIL_FIELDS = {
  id: true,
  processedAt: true,
  ticketId: true,
} as const satisfies Prisma.RawEmailSelect;

/**
 * Creates or extends a ticket, in one serializable transaction with the lookup
 * that decided which. Serializable because two replies to the same new thread
 * arriving together would otherwise both find no parent and both open a ticket.
 */
async function convert(rawEmailId: number, email: InboundEmail): Promise<IngestResult> {
  return serializable(async (tx) => {
    const parentTicketId = await findParentTicket(tx, email);

    const ticketId =
      parentTicketId ??
      (
        await tx.ticket.create({
          data: {
            subject: email.subject,
            // The opening message's body, denormalised onto the ticket. Only
            // the first message's: a later reply updates `lastMessageAt`, not
            // this, so `body` stays the original request rather than drifting
            // into whatever was said most recently.
            body: email.strippedBody ?? email.body,
            // `""` when the mail was plain text only, which is a normal value
            // for this column rather than a missing one.
            bodyHtml: email.bodyHtml ?? "",
            requesterEmail: email.from.email,
            requesterName: email.from.name,
            // `status` defaults to OPEN, `category` stays null until the Phase 5
            // classifier runs, and `assignedToId` stays null because inbound
            // mail names no one to give the ticket to. None is set here.
          },
          select: { id: true },
        })
      ).id;

    // A reply to a ticket someone had finished with belongs back in the queue.
    // Both RESOLVED and CLOSED reopen: filing a student's reply under a closed
    // ticket would leave it where no default view shows it, which is the exact
    // failure this product exists to prevent.
    if (parentTicketId !== null) {
      await tx.ticket.updateMany({
        where: { id: parentTicketId, status: { in: ["RESOLVED", "CLOSED"] } },
        data: { status: "OPEN" },
      });
    }

    const message = await addMessage(tx, ticketId, {
      direction: "INBOUND",
      fromEmail: email.from.email,
      fromName: email.from.name,
      // The stripped body is what an agent reads and what Phase 5 sends to
      // Claude; the full text is still in the payload if it is ever needed.
      body: email.strippedBody ?? email.body,
      bodyHtml: email.bodyHtml,
      rfcMessageId: email.rfcMessageId,
      inReplyTo: email.inReplyTo,
      references: email.references.length > 0 ? email.references.join(" ") : undefined,
    });

    await tx.rawEmail.update({
      where: { id: rawEmailId },
      data: {
        processedAt: new Date(),
        error: null,
        ticketId,
        createdMessageId: message.id,
      },
    });

    return { rawEmailId, ticketId, duplicate: false };
  }).catch(async (err) => {
    // The message is already ingested - the same mail reached us by two routes,
    // or a retry arrived while the first attempt was still in flight. Its
    // ticket is the answer, so this is a duplicate rather than a failure.
    if (isUniqueViolation(err) && email.rfcMessageId) {
      const existing = await prisma.message.findUnique({
        where: { rfcMessageId: email.rfcMessageId },
        select: { id: true, ticketId: true },
      });
      if (existing) {
        await prisma.rawEmail.update({
          where: { id: rawEmailId },
          data: {
            processedAt: new Date(),
            error: null,
            ticketId: existing.ticketId,
            createdMessageId: existing.id,
          },
        });
        return { rawEmailId, ticketId: existing.ticketId, duplicate: true };
      }
    }
    throw err;
  });
}

/**
 * Appends a message to a ticket and moves the ticket's `lastMessageAt` with it.
 *
 * One helper for the two so they cannot drift apart: a message written without
 * the bump would be invisible to the list's ordering, which reads the
 * denormalised column rather than joining the thread. Task 3.8's agent reply
 * goes through here too, with `direction: "OUTBOUND"`.
 */
export async function addMessage(
  tx: Prisma.TransactionClient,
  ticketId: number,
  input: {
    direction: "INBOUND" | "OUTBOUND";
    fromEmail: string;
    fromName: string;
    body: string;
    bodyHtml?: string;
    rfcMessageId?: string;
    inReplyTo?: string;
    references?: string;
  },
) {
  const message = await tx.message.create({
    data: {
      ticketId,
      direction: input.direction,
      fromEmail: input.fromEmail,
      fromName: input.fromName,
      body: input.body,
      bodyHtml: input.bodyHtml ?? null,
      rfcMessageId: input.rfcMessageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? null,
    },
    select: { id: true, createdAt: true },
  });

  await tx.ticket.update({
    where: { id: ticketId },
    data: { lastMessageAt: message.createdAt },
  });

  return message;
}

/**
 * The ticket this email is a reply to, or null when it starts a new thread
 * (task 4.10).
 *
 * `In-Reply-To` is checked first because it names the immediate parent;
 * `References` is the whole ancestry and is the fallback, walked newest-first
 * so a forwarded thread lands on the most recent of our messages it mentions
 * rather than the oldest. Subject matching is deliberately *not* used: "Re:
 * Question" from two students is one ticket under that rule, and merging two
 * people's requests is worse than splitting one person's thread.
 */
async function findParentTicket(
  tx: Prisma.TransactionClient,
  email: InboundEmail,
): Promise<number | null> {
  const candidates = [email.inReplyTo, ...[...email.references].reverse()].filter(
    (id): id is string => id !== undefined && id !== "",
  );
  if (candidates.length === 0) return null;

  const matches = await tx.message.findMany({
    where: { rfcMessageId: { in: [...new Set(candidates)] } },
    select: { rfcMessageId: true, ticketId: true },
  });
  if (matches.length === 0) return null;

  // Back to candidate order: the first candidate that matched is the closest
  // ancestor, and `findMany` does not promise the order asked for.
  const byMessageId = new Map(matches.map((match) => [match.rfcMessageId, match.ticketId]));
  for (const candidate of candidates) {
    const ticketId = byMessageId.get(candidate);
    if (ticketId !== undefined) return ticketId;
  }
  return null;
}

/**
 * Records that the payload was stored on purpose and not converted. Leaves
 * `processedAt` null, so the row shows up in exactly the same query a worker
 * or an operator uses to find unconverted mail.
 */
async function markUnconverted(rawEmailId: number, reason: string) {
  await prisma.rawEmail.update({ where: { id: rawEmailId }, data: { error: reason } });
}

/**
 * Records a conversion failure against the row. Best-effort: if the database
 * is what failed, this write fails too, and the original error is the one worth
 * reporting - so it is swallowed rather than masking the cause.
 */
async function recordFailure(rawEmailId: number, err: unknown) {
  try {
    await prisma.rawEmail.update({
      where: { id: rawEmailId },
      data: { error: `Conversion failed: ${errorText(err)}` },
    });
  } catch (writeErr) {
    console.error(`Could not record the failure on RawEmail ${rawEmailId}:`, writeErr);
  }
}

/** Longest error text stored, so a stack trace cannot fill the column. */
const MAX_ERROR_LENGTH = 2000;

function errorText(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.length > MAX_ERROR_LENGTH ? text.slice(0, MAX_ERROR_LENGTH) : text;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * The dedupe key for mail with no Message-ID, which is rare but legal.
 *
 * A SHA-256 of the *parsed* fields, normalised. Hashing the raw body instead
 * would look equivalent and dedupe nothing: the multipart boundary is random
 * per request, so a provider's retry of the identical message produces
 * different bytes every time.
 *
 * Two genuinely distinct messages from one sender with the same subject and
 * body would collide and the second would be dropped. That is the right trade:
 * such a message is almost always a retry, and the payload is still in the
 * table either way.
 */
function fingerprint(email: InboundEmail): string {
  const parts = [
    email.from.email,
    email.recipient,
    email.subject.trim(),
    email.body.replace(/\s+/g, " ").trim(),
  ];
  return `sha256:${createHash("sha256").update(parts.join("\n")).digest("hex")}`;
}

/**
 * The dedupe key for a payload that could not be parsed at all. There are no
 * fields to normalise, so the stored JSON is hashed - which is stable here,
 * because it is the decoded form fields rather than the raw multipart bytes.
 */
function fingerprintPayload(payload: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload) ?? "null").digest("hex")}`;
}
