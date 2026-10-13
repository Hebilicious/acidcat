/** The fixture as a web page with WebMCP tools, for the conformance tests. */
import { createSession, installWebMcp } from "../src/index.ts";
import { fixture, options } from "./fixture.ts";

installWebMcp(createSession(fixture, { target: "app", ...options() }));
