/**
 * Placeholders for the variables `env.ts` refuses to start without, so a unit
 * test never depends on a developer's `server/.env`.
 *
 * `env.ts` validates at import time and calls `process.exit(1)` when something
 * required is missing - which in a test run would kill the whole process with no
 * failing test to explain it. Anything that imports `env.ts`, directly or (far
 * more often) through `middleware/error-handler.ts`, therefore needs these set
 * before the first import. Import this module **first** in a server test file;
 * ESM evaluates imports in order, so it runs before the module under test.
 *
 * `??=`, never `=`: a real value already in the environment wins. Nothing here
 * is ever connected to or signed with - a unit test that reached Postgres would
 * not be a unit test - so the values only have to be the right shape.
 *
 * Deliberately absent: `OPENAI_API_KEY`. The reply polisher's unconfigured
 * branch is a thing worth testing (`lib/ai.test.ts`), and a default here would
 * hide it. That file mocks `env.ts` to say what it needs instead.
 */
process.env.DATABASE_URL ??= "postgresql://unit-tests@127.0.0.1:5432/never-connected";
process.env.BETTER_AUTH_SECRET ??= "unit-tests-secret-which-signs-nothing-real";
