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
 * - Recording runs from places with no caller to catch it — a `setInterval`
 *   callback, an EventEmitter handler, and an `async` function started with
 *   `void`. On Node 22 all three end the process: uncaught exceptions always
 *   have, and `--unhandled-rejections=throw` is the default. Nothing in this
 *   codebase installs an `uncaughtException` or `unhandledRejection` handler
 *   (`grep -rn 'uncaughtException\|unhandledRejection' src/` finds nothing), so
 *   there is no net below these call sites.
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
 * This module imports nothing on purpose. `proxy.ts`, `exchange.ts` and
 * `websocket.ts` all need the guard, and `exchange.ts` ⇄ `websocket.ts` already
 * have a type-only edge between them that a runtime import would turn into a
 * real cycle. A leaf module cannot participate in one.
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
