/**
 * The support knowledge base, read off disk once.
 *
 * `knowledge-base.md` at the repository root is the document the auto-resolver
 * answers from - and, unlike every other markdown file here, it is **server
 * input rather than documentation**. Editing it changes what the system will
 * tell a student, so it is read through this one module and nowhere else.
 *
 * **The absence of a knowledge base is how the feature is switched off.** There
 * is no `AUTO_RESOLVE_ENABLED` flag, deliberately: a flag would be a second
 * thing to get wrong, and the honest gate is whether there is anything to answer
 * from. A missing, unreadable or stub file returns `null`, the auto-resolver
 * returns early, and every ticket stays OPEN for a human - which is exactly the
 * behaviour this repository had before the feature existed.
 *
 * **It is cached for the life of the process.** An edit to `knowledge-base.md`
 * needs a server restart to take effect. That is the right trade for a file that
 * changes a few times a year and would otherwise be re-read, and re-validated,
 * once per inbound email. `bun --hot` does not reload it either, since the module
 * itself has not changed.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { env } from "../env.ts";

/**
 * Shortest document that counts as a knowledge base.
 *
 * A stub guard, not a quality bar: the thing it is meant to catch is an empty or
 * placeholder file, because **a model asked to answer policy questions from
 * nothing is a model inventing policy**, and it would do so in the support
 * team's name on a ticket nobody reviews. Two hundred characters is below any
 * real document and above every accidental one.
 */
const MIN_LENGTH = 200;

/**
 * Where the file lives when `KNOWLEDGE_BASE_PATH` says nothing: the repository
 * root, three levels up from `server/src/lib/`.
 *
 * Resolved from this module rather than from `process.cwd()`, and that is not a
 * stylistic preference. `bun run dev` runs with the working directory at
 * `server/`, `bun src/index.ts` from the root does not, and a container sets its
 * own `WORKDIR` - so a cwd-relative default would find the file on one machine
 * and silently disable the whole feature on another, with no error anywhere to
 * say why.
 */
const DEFAULT_PATH = resolve(import.meta.dir, "../../../knowledge-base.md");

/**
 * The read, memoised - including a `null` result, which is the point of wrapping
 * it in an object. A bare `string | undefined` cache would be indistinguishable
 * from "not read yet" on a server with no knowledge base, and would go back to
 * the disk on every inbound email to be disappointed again.
 */
let cache: { text: string | null } | undefined;

/** Where the knowledge base is read from, for the log line and for tests. */
export function knowledgeBasePath(): string {
  const configured = env.knowledgeBasePath;
  if (!configured) return DEFAULT_PATH;

  // A relative override is relative to where the process was started, which is
  // what someone typing one into `.env` means by it. An absolute one is taken
  // as given.
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/**
 * The knowledge base, or `null` when there is not a usable one.
 *
 * Never throws. A read failure is not a broken server - it is a server with the
 * auto-resolver switched off - so it is logged once and answered with `null`.
 * Everything that consults this treats `null` as "leave the ticket to a human".
 */
export function knowledgeBase(): string | null {
  cache ??= { text: read() };
  return cache.text;
}

function read(): string | null {
  const path = knowledgeBasePath();

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.info(
      `No knowledge base at ${path}, so tickets will not be auto-resolved: ${reason}`,
    );
    return null;
  }

  const trimmed = text.trim();
  if (trimmed.length < MIN_LENGTH) {
    console.info(
      `The knowledge base at ${path} is only ${trimmed.length} characters, under the ` +
        `${MIN_LENGTH} needed to answer from; tickets will not be auto-resolved.`,
    );
    return null;
  }

  return trimmed;
}

/** Forgets the cached read. For tests; nothing in the running server calls it. */
export function resetKnowledgeBase(): void {
  cache = undefined;
}
