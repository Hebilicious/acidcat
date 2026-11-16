import { createSession, installWebMcp } from "../src/index.ts";
import { fixture, options } from "./fixture.ts";

installWebMcp(createSession(fixture, { target: "app", ...options() }));
