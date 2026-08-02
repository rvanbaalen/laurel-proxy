/**
 * Runs one recording concern and absorbs anything it throws.
 *
 * The invariant: **a recording failure may lose a recording, but must never
 * affect the bytes an application sees, nor terminate the process.** Laurel is
 * a debugging tool. A proxy that dies because an INSERT hit a full disk is a
 * worse outcome for the developer holding it than a missing row.
 *
 * Two things make an unguarded recording failure fatal rather than merely
 * lossy, and both are structural rather than hypothetical:
 *
 * - Recording runs from places with no caller to catch it — two `setInterval`
 *   callbacks (the write flush and retention), an EventEmitter handler, and
 *   `async` functions started with `void`. On Node 22 all of them end the
 *   process: uncaught exceptions always have, and `--unhandled-rejections=throw`
 *   is the default. Nothing in this codebase installs an `uncaughtException` or
 *   `unhandledRejection` handler (`grep -rn 'uncaughtException\|
 *   unhandledRejection' src/` finds nothing), so there is no net below these
 *   call sites.
 * - Recording also runs *inside* relay loops whose `catch` tears the connection
 *   down, so a throw there aborts a live transfer — the recording inverting the
 *   priority it is supposed to serve.
 *
 * Callers pass a thunk rather than a finished value, and that is the whole
 * reason this takes a function at all: an argument expression is evaluated
 * before the call it belongs to, so `guard(sink, buildRecord())` would leave
 * `buildRecord()` outside the boundary. Building the record inside the thunk is
 * what makes the boundary structurally total rather than total only as long as
 * nothing on the construction side happens to throw.
 *
 * It lives in `shared/` and imports nothing on purpose. Both `server/` (the
 * exchange, the relay, the write flush) and `storage/` (retention) need the
 * guard, and `storage/` must not depend on `server/` — that is backwards. A
 * dependency-free module under `shared/`, which every layer already imports, is
 * reachable from both without any layer gaining a new neighbour. It also keeps
 * `exchange.ts` ⇄ `websocket.ts` off each other: they already share a type-only
 * edge that a runtime import between them would turn into a real cycle, and a
 * leaf module cannot participate in one.
 */
export function recordSafely(record: () => void): void {
  try {
    record();
  } catch {
    // Deliberately silent. Every channel available for reporting this — the
    // database, the event stream — is itself a recording concern and could be
    // the thing that just failed. The exchange happened either way; only our
    // account of it is missing.
  }
}
