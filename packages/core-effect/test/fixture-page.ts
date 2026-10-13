/** The fixture as a web page with WebMCP tools, for the conformance tests. The tools stay while the page is open. */
import { Effect } from "effect";

import { Session, WebMcp } from "../src/index.ts";
import { fixture, switchLayer } from "./fixture.ts";

Effect.runFork(
  Effect.gen(function* () {
    const session = yield* Session.make(fixture, { target: "app" });
    yield* WebMcp.install(session);
    return yield* Effect.never;
  }).pipe(Effect.scoped, Effect.provide(switchLayer)),
);
