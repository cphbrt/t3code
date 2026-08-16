/**
 * Process-wide record that a shutdown signal has arrived.
 *
 * Provider CLIs are spawned into the server's process group, so a SIGTERM aimed
 * at the server (desktop quit, service restart, Ctrl+C) reaches them at the same
 * instant. Their streams therefore break *before* any Effect finalizer can mark
 * sessions stopped, and an adapter that only consults its own session state
 * reads that breakage as a provider failure.
 *
 * The flag is set synchronously from the signal handler, so the knowledge
 * exists before the first broken provider stream can be observed: the child's
 * death only reaches us as a later-tick stream event, while `markShutdown` runs
 * during signal dispatch itself.
 *
 * Termination remains owned by `NodeRuntime.runMain`, which installs its own
 * SIGINT/SIGTERM handlers before any layer builds and interrupts the main
 * fiber. These listeners only observe.
 *
 * @module processShutdown
 */
import * as Effect from "effect/Effect";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

let shutdownRequested = false;

/** Whether this process has received a shutdown signal. */
export const isShutdownRequested = (): boolean => shutdownRequested;

/**
 * Record that shutdown has begun. Idempotent, safe to call from a signal
 * handler, and never reset: a process that starts shutting down does not
 * return to serving.
 */
export const markShutdownRequested = (): void => {
  shutdownRequested = true;
};

/**
 * Observe SIGINT/SIGTERM for the life of the enclosing scope. Added to the
 * server layer so every server surface (desktop backend, `npx t3`, managed
 * service child) records shutdown the moment it is requested.
 */
export const watchShutdownSignals = Effect.acquireRelease(
  Effect.sync(() => {
    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, markShutdownRequested);
    }
  }),
  () =>
    Effect.sync(() => {
      for (const signal of SHUTDOWN_SIGNALS) {
        process.off(signal, markShutdownRequested);
      }
    }),
);
