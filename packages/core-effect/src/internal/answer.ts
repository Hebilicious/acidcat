import { Cause, Exit } from "effect";

/**
 * The response to a web request, from the exit of its answer. A request whose signal aborted rejects with the reason of
 * the signal, as an aborted `fetch` does. Other failures reject with their cause.
 */
export async function answer<E>(request: Request, answered: Promise<Exit.Exit<Response, E>>): Promise<Response> {
  const exit = await answered;
  if (Exit.isSuccess(exit)) return exit.value;
  if (request.signal.aborted && Cause.hasInterruptsOnly(exit.cause)) throw request.signal.reason;
  throw Cause.squash(exit.cause);
}
