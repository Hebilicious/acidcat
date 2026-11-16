#!/usr/bin/env node
import * as Http from "../src/Http.ts";
import * as NodeCli from "../src/NodeCli.ts";
import { fixture, fixtureLayer } from "./fixture.ts";

// `effect/cli` reads the arguments from `process.argv`, so the URL leaves it first.
const [url] = process.argv.splice(2, 1);
if (url === undefined) {
  console.error("Usage: fixture-cli-remote.ts <url> [arguments]");
  process.exit(2);
}

const authorization = process.env.FIXTURE_AUTHORIZATION;
const headers = authorization === undefined ? {} : { Authorization: authorization };

NodeCli.main(fixture, fixtureLayer, { name: "fixture", version: "0.0.0", remote: Http.client(url, { headers }) });
