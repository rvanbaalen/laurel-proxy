/**
 * Runs bookkeeping work and absorbs anything it throws.
 *
 * "Bookkeeping" means work whose failure the user would rather lose than pay
 * for: capturing traffic, writing it down, pruning it later. Laurel is a
 * debugging tool, and the thing it must protect is the traffic it sits in front
 * of — a proxy that dies because an INSERT hit a full disk is a worse outcome
 * for the developer holding it than a missing row.
 *
 * Two things make an unguarded failure here fatal rather than merely lossy, and
 * both are structural rather than hypothetical:
 *
 * - This work runs from places with no caller to catch it — two `setInterval`
 *   callbacks (the write flush and retention), an EventEmitter handler, and
 *   `async` functions started with `void`. On Node 22 all of them end the
 *   process: uncaught exceptions always have, and `--unhandled-rejections=throw`
 *   is the default. Nothing in this codebase installs an `uncaughtException` or
 *   `unhandledRejection` handler (`grep -rn 'uncaughtException\|
 *   unhandledRejection' src/` finds nothing), so there is no net below these
 *   call sites.
 * - Some of it runs *inside* relay loops whose `catch` tears the connection
 *   down, so a throw there aborts a live transfer — the bookkeeping inverting
 *   the priority it exists to serve.
 *
 * Callers pass a thunk rather than a finished value, and that is the whole
 * reason this takes a function at all: an argument expression is evaluated
 * before the call it belongs to, so `guard(sink, buildRecord())` would leave
 * `buildRecord()` outside the boundary. Building inside the thunk is what makes
 * the boundary structurally total rather than total only as long as nothing on
 * the construction side happens to throw.
 *
 * It lives in `shared/` and imports nothing on purpose. Both `server/` (the
 * exchange, the relay, the write flush) and `storage/` (retention) need it, and
 * `storage/` must not depend on `server/` — that is backwards. A dependency-free
 * module under `shared/`, which every layer already imports, is reachable from
 * both without any layer gaining a new neighbour. It also keeps `exchange.ts` ⇄
 * `websocket.ts` off each other: they already share a type-only edge that a
 * runtime import between them would turn into a real cycle, and a leaf module
 * cannot participate in one.
 */
export function neverFatal(work: () => void): void {
  try {
    work();
  } catch {
    // Deliberately silent. Every channel available for reporting this — the
    // database, the event stream — is itself bookkeeping and could be the thing
    // that just failed. There is no logging channel in this codebase to fall
    // back to; giving these failures a voice is a tracked follow-up, and a
    // silent loss is still better than a dead proxy.
  }
}

/**
 * {@link neverFatal} at the recording boundary specifically: capturing an
 * exchange, building its record, and handing it to a sink.
 *
 * This exists as a separate name so the boundary stays enumerable —
 * `grep -rn recordSafely src/` lists every place a recording failure is
 * absorbed, and nothing else. `neverFatal` covers work that is not a recording
 * (retention pruning), which is why the two names are not one.
 */
export function recordSafely(record: () => void): void {
  neverFatal(record);
}
