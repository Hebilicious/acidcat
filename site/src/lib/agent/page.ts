import { createSession, installWebMcp } from "@acid-cat/core-ts";
import { site, TARGET, toJsonSchema } from "./app.ts";
import { siteContext } from "./content.ts";

const session = createSession(site, { target: TARGET, context: siteContext((path) => fetch(path)), toJsonSchema });
installWebMcp(session);
