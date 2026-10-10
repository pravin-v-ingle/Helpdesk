/**
 * Loads the sample tickets in `seed-tickets.json` into the database, so an
 * emptied development database can be refilled with something worth looking at.
 * Task 3.4.
 *
 *   bun run db:seed:tickets                  create the tickets, or refuse if any exist
 *   bun run db:seed:tickets -- --force       create them anyway, alongside what is there
 *   bun run db:seed:tickets -- --reset       delete every ticket first, then create them
 *
 * The fixture was captured from a development database and is loaded unchanged:
 * 19 tickets, 28 messages, spread over about ten days. **Looking aged is the
 * whole point of it** - a queue where every row has the same `lastMessageAt` is
 * useless for judging the list view, the default ordering or the paging - which
 * is why every timestamp is written explicitly below rather than left to
 * `@default(now())`.
 *
 * It carries no ids and no `RawEmail` rows, by design. Ids come from the
 * sequence, and a provider payload is hundreds of kilobytes of JSON that no view
 * reads; a reseeded ticket genuinely has no stored payload behind it, which is
 * honest rather than lossy.
 *
 * For demonstrating the *classifier* and the auto-resolver, `bun run email:test`
 * is still the better tool: it drives the real inbound path, so the tickets it
 * creates get a category and a look from the knowledge base. These are for
 * having a populated queue.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  MessageDirection,
  TicketCategory,
  TicketStatus,
} from "../src/generated/prisma/enums.ts";
import { prisma } from "../src/lib/prisma.ts";

const force = process.argv.includes("--force");
const reset = process.argv.includes("--reset");

/**
 * The fixture's shape, validated rather than trusted.
 *
 * The valuable part is that the three enums are the **generated Prisma** ones:
 * a fixture written before an enum member was renamed fails here with a message
 * naming the field, instead of reaching Postgres and coming back as `invalid
 * input value for enum`.
 *
 * Timestamps are validated as strings and converted below, not with
 * `z.coerce.date()`, which accepts anything `new Date()` does not choke on -
 * including `"nonsense"`, as an Invalid Date.
 */
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "must be an ISO timestamp",
});

const messageFixture = z.object({
  direction: z.enum(MessageDirection),
  fromEmail: z.string(),
  fromName: z.string(),
  body: z.string(),
  bodyHtml: z.string().nullable(),
  /**
   * Preserved rather than dropped, and the one field here it would be easy to
   * think optional. Threading matches a reply's `In-Reply-To` against it and the
   * inbound dedupe key is built from it, so a fixture loaded without these looks
   * identical and silently stops `email:test --in-reply-to` working - five of
   * these messages thread onto another in the same file.
   */
  rfcMessageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.string().nullable(),
  createdAt: timestamp,
});

const ticketFixture = z.object({
  subject: z.string(),
  body: z.string(),
  bodyHtml: z.string(),
  status: z.enum(TicketStatus),
  category: z.enum(TicketCategory).nullable(),
  requesterEmail: z.string(),
  requesterName: z.string(),
  lastMessageAt: timestamp,
  createdAt: timestamp,
  /** An address rather than an id: ids differ between databases, addresses do not. */
  assigneeEmail: z.string().nullable(),
  messages: z.array(messageFixture).min(1),
});

const fixtureFile = z.object({
  generatedAt: z.string(),
  note: z.string(),
  tickets: z.array(ticketFixture).min(1),
});

type TicketFixture = z.infer<typeof ticketFixture>;

/**
 * Resolved from this module rather than from the working directory: `bun run
 * db:seed:tickets` runs from `server/`, but the script is also runnable from the
 * repository root, and a cwd-relative path would work from one and not the
 * other.
 */
const FIXTURE_PATH = resolve(import.meta.dir, "seed-tickets.json");

/**
 * Prisma's interactive transactions time out after five seconds by default.
 * Nineteen nested creates and a user lookup are comfortably inside that on a
 * warm connection and not necessarily on a cold one, and a timeout here would
 * roll the lot back halfway through.
 */
const TRANSACTION_TIMEOUT_MS = 30_000;

async function main() {
  // Before anything is read, let alone deleted. A guard that ran after the first
  // query would refuse with a connection error rather than with its own message
  // - and if the connection happened to work, it would be refusing later than it
  // should.
  if (reset) guardAgainstTheTestDatabase();

  const fixture = loadFixture();
  const existing = await prisma.ticket.count();

  if (reset) {
    await deleteEverything();
  } else if (existing > 0 && !force) {
    // The mistake being guarded is running this twice and getting two of
    // everything, which is quiet and annoying to undo. Both escape hatches are
    // printed literally, as `seed.ts` prints `--repair`.
    console.error(
      `Refusing to seed: this database already holds ${existing} ticket(s).\n` +
        "\n    bun run db:seed:tickets -- --reset    delete them and load the fixture\n" +
        "    bun run db:seed:tickets -- --force    load the fixture alongside them\n",
    );
    process.exit(1);
  }

  const assignees = await resolveAssignees(fixture.tickets);
  const taken = await alreadyPresent(fixture.tickets);

  let created = 0;
  let createdMessages = 0;
  let skipped = 0;

  await prisma.$transaction(
    async (tx) => {
      for (const ticket of fixture.tickets) {
        // Only reachable under `--force`, where the fixture may already be in
        // the database: `Message.rfcMessageId` is unique, so re-creating one
        // would abort the whole transaction with a raw P2002 rather than saying
        // what happened.
        if (ticket.messages.some((m) => m.rfcMessageId && taken.has(m.rfcMessageId))) {
          skipped++;
          continue;
        }

        await tx.ticket.create({
          data: {
            subject: ticket.subject,
            body: ticket.body,
            bodyHtml: ticket.bodyHtml,
            status: ticket.status,
            category: ticket.category,
            requesterEmail: ticket.requesterEmail,
            requesterName: ticket.requesterName,
            assignedToId: ticket.assigneeEmail
              ? (assignees.get(ticket.assigneeEmail.toLowerCase()) ?? null)
              : null,
            // Both written explicitly. `createdAt` is a `@default(now())` and so
            // is writable; `lastMessageAt` is the list's sort key and the reason
            // the fixture exists. `updatedAt` is `@updatedAt` and cannot be
            // preserved - Prisma stamps it on insert - so a seeded ticket shows
            // an `updatedAt` later than its `createdAt`. Nothing renders it.
            createdAt: new Date(ticket.createdAt),
            lastMessageAt: new Date(ticket.lastMessageAt),
            /**
             * **Not written through `addMessage`**, which is the helper the
             * inbound path and the reply endpoint both use - and the obvious
             * thing to reach for here. It would be wrong twice over: it takes no
             * `createdAt`, so every message would be stamped `now()`, and it
             * moves `lastMessageAt` to that same `now()`, which is exactly the
             * column this script is being careful about. Nineteen tickets would
             * end up indistinguishable in the default ordering.
             *
             * Nor should `addMessage` grow an optional `createdAt` to suit this:
             * the mandatory, forward-only bump is the one invariant it exists to
             * enforce, and weakening it for an offline script would cost the
             * inbound path the guarantee it was written for.
             */
            messages: {
              create: ticket.messages.map((message) => ({
                direction: message.direction,
                fromEmail: message.fromEmail,
                fromName: message.fromName,
                body: message.body,
                bodyHtml: message.bodyHtml,
                rfcMessageId: message.rfcMessageId,
                inReplyTo: message.inReplyTo,
                references: message.references,
                createdAt: new Date(message.createdAt),
              })),
            },
          },
          select: { id: true },
        });
        created++;
        createdMessages += ticket.messages.length;
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );

  console.log(
    `Seeded ${created} ticket(s) and ${createdMessages} message(s) from the ${fixture.generatedAt} fixture.`,
  );
  if (skipped > 0) {
    console.log(`Skipped ${skipped} already present (matched on their Message-IDs).`);
  }
}

function loadFixture() {
  let raw: string;
  try {
    raw = readFileSync(FIXTURE_PATH, "utf8");
  } catch (err) {
    console.error(`Could not read ${FIXTURE_PATH}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Read at runtime and validated, rather than `import`ed: `server/tsconfig.json`
  // does not set `resolveJsonModule`, and `prisma/` is in its `include` - so an
  // import here would run under Bun and fail `bun run typecheck`, which is the
  // worst of both.
  const parsed = fixtureFile.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.error(`${FIXTURE_PATH} does not match the expected shape:`);
    console.error(z.prettifyError(parsed.error));
    process.exit(1);
  }
  return parsed.data;
}

/**
 * Clears the tickets, and the raw emails first.
 *
 * **`RawEmail` does not cascade**, which is the trap in this function and the
 * reason it is more than one `deleteMany`. `Message.ticket` is `onDelete:
 * Cascade`, so messages go with their ticket; `RawEmail.ticket` is `onDelete:
 * SetNull` and `RawEmail.createdMessageId` is a plain `Int?` that nothing
 * enforces. A bare `ticket.deleteMany()` would therefore leave rows pointing at
 * a message that no longer exists - and, worse, keep their `dedupeKey`. The next
 * `bun run email:test` with a Message-ID used before the reset would then hit the
 * unique constraint, be answered `duplicate: true`, create no ticket, and look
 * for all the world like a broken webhook.
 */
async function deleteEverything() {
  const [rawEmails, tickets] = await prisma.$transaction([
    prisma.rawEmail.deleteMany({}),
    prisma.ticket.deleteMany({}),
  ]);

  console.log(
    `Deleted ${tickets.count} ticket(s) with their messages, and ${rawEmails.count} stored payload(s).`,
  );
}

/**
 * Refuses `--reset` against the end-to-end database, the inverse of the guard in
 * `scripts/reset-test-db.ts` - which refuses to run on anything *but* a `_test`
 * database, for the same reason in the other direction.
 *
 * That database is rebuilt from scratch by `db:test:reset` and its contents are
 * the Playwright fixtures. Clearing it from here would break a suite rather than
 * a developer's demo data, and it would break it somewhere else entirely, with
 * nothing pointing back at this script.
 */
function guardAgainstTheTestDatabase() {
  const database = decodeURIComponent(
    new URL(prismaDatabaseUrl()).pathname.replace(/^\//, ""),
  );

  // Reported separately, so the message names the condition that actually
  // tripped rather than asserting something about the database that may not be
  // true of it.
  const reason =
    process.env.NODE_ENV === "test"
      ? 'NODE_ENV is "test"'
      : database.endsWith("_test")
        ? 'its name ends in "_test"'
        : undefined;
  if (!reason) return;

  console.error(
    `Refusing to clear "${database}": ${reason}, so this looks like the\n` +
      "end-to-end test database. Use `bun run db:test:reset` for that one.",
  );
  process.exit(1);
}

function prismaDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  return url;
}

/**
 * Maps the fixture's assignee addresses to user ids on *this* database.
 *
 * Eighteen of the nineteen tickets are unassigned and the one that is names
 * `agent@helpdesk.local`, who will not exist on a database seeded by a different
 * `SEED_ADMIN_EMAIL` - so the warning below is the expected outcome rather than
 * an unusual one, and it says what to do about it.
 *
 * A deactivated user is treated as a miss too. `PATCH /api/tickets/:id` refuses
 * to assign one outright, so planting one here would create a state no code path
 * can produce and the API would not let anyone fix by hand.
 */
async function resolveAssignees(tickets: TicketFixture[]): Promise<Map<string, string>> {
  const wanted = [
    ...new Set(
      tickets
        .map((ticket) => ticket.assigneeEmail?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email)),
    ),
  ];
  if (wanted.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { email: { in: wanted } },
    select: { id: true, email: true, active: true },
  });

  const byEmail = new Map(users.map((user) => [user.email, user]));
  const resolved = new Map<string, string>();

  for (const email of wanted) {
    const user = byEmail.get(email);
    if (!user) {
      console.warn(
        `No user ${email} on this database, so their ticket(s) are seeded unassigned. ` +
          "Create that account if you want them assigned, or ignore this.",
      );
      continue;
    }
    if (!user.active) {
      console.warn(
        `${email} is deactivated, so their ticket(s) are seeded unassigned - the API ` +
          "refuses to assign a deactivated user, so seeding one would be a state nothing could reach.",
      );
      continue;
    }
    resolved.set(email, user.id);
  }

  return resolved;
}

/**
 * The fixture's Message-IDs that this database already holds. Only ever non-empty
 * under `--force`; see the skip in `main`.
 */
async function alreadyPresent(tickets: TicketFixture[]): Promise<Set<string>> {
  const ids = tickets.flatMap((ticket) =>
    ticket.messages
      .map((message) => message.rfcMessageId)
      .filter((id): id is string => id !== null),
  );
  if (ids.length === 0) return new Set();

  const found = await prisma.message.findMany({
    where: { rfcMessageId: { in: ids } },
    select: { rfcMessageId: true },
  });

  return new Set(found.map((message) => message.rfcMessageId).filter((id): id is string => id !== null));
}

main()
  .catch((err) => {
    console.error("Ticket seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
