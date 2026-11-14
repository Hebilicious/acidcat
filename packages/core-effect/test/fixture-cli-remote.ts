#!/usr/bin/env node
/**
 * The fixture as a command line that sends each call and each subscription to the HTTP binding of a server:
 * `fixture-cli-remote.ts <url> <arguments of the command line>`. The first argument is the base URL of the server.
 * With `FIXTURE_AUTHORIZATION`, each request has that value in the header `Authorization`.
 */
import * as Http from "../src/Http.ts";
import * as NodeCli from "../src/NodeCli.ts";
import { fixture, fixtureLayer } from "./fixture.ts";

// The command line reads its arguments from `process.argv`, so the URL leaves it first.
const [url] = process.argv.splice(2, 1);
if (url === undefined) {
  console.error("Usage: fixture-cli-remote.ts <url> [arguments]");
  process.exit(2);
}

const authorization = process.env.FIXTURE_AUTHORIZATION;
const headers = authorization === undefined ? {} : { Authorization: authorization };

// The command line opens no session in this process, so it does not use the services. The view of the target `cli`
// still comes from the application in this program.
NodeCli.main(fixture, fixtureLayer, { name: "fixture", version: "0.0.0", remote: Http.client(url, { headers }) });
