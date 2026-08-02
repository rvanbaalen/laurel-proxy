/**
 * Collects everything that reaches Node's process-level error channels while
 * `run` executes, so that "the process would have died here" becomes an
 * assertable value.
 *
 * Process death cannot be observed from inside the process that dies: a test
 * that kills the test runner reports nothing at all, not a failure. What *can*
 * be observed is the escape that causes the death. Node terminates on an
 * uncaught exception, and on an unhandled rejection too — `--unhandled-
 * rejections=throw` is the Node 22 default — unless a listener for the matching
 * event is installed. Laurel installs neither; `grep -rn 'uncaughtException\|
 * unhandledRejection' src/` finds nothing. So in production every event this
 * helper captures is a process exit.
 *
 * Installing the listeners for the duration of the window is what makes the
 * escape survivable and therefore reportable. An empty result is the assertion:
 * the guarded code never got as far as the thing that would have killed the
 * proxy.
 */
export async function watchProcessErrors(run: () => Promise<void>): Promise<string[]> {
  const escaped: string[] = [];
  const record = (error: unknown): void => {
    escaped.push(String(error));
  };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  try {
    await run();
    // A dropped rejection is reported a turn after the promise settles, so the
    // window has to outlive the work it wraps or it would miss the escape it
    // exists to catch.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return escaped;
  } finally {
    process.off('uncaughtException', record);
    process.off('unhandledRejection', record);
  }
}
