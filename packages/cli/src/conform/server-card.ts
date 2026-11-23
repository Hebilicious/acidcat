import { isCidr, MCP_EVENTS_EXTENSION, MCP_SERVER_CARD_CACHE_CONTROL, MCP_SERVER_CARD_MEDIA_TYPE, MCP_SERVER_CARD_PATH } from "@acid-cat/spec-ts";
import { Result, Schema, SchemaIssue, SchemaRepresentation } from "effect";
import type { JsonSchema } from "effect";

import cardJsonSchema from "../../conformance/server-card.schema.json" with { type: "json" };
import { isObject, isStringArray, memberOf, parseJson } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { expect, expectEqual } from "./check.ts";
import type { Checks } from "./check.ts";
import type { Channel } from "./mcp.ts";

const RULE = "spec/bindings/mcp.md#server-card";

const decodeCard = (() => {
  const definitions: JsonSchema.Definitions = cardJsonSchema.$defs;
  const schema = SchemaRepresentation.fromJsonSchemaDocument({ dialect: "draft-2020-12", schema: { $ref: "#/$defs/ServerCard" }, definitions }, { patterns: "apply" });
  return Schema.decodeUnknownResult(Schema.toType(schema));
})();

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
  "Access-Control-Expose-Headers": "ETag",
  "Cache-Control": MCP_SERVER_CARD_CACHE_CONTROL,
};

function expectHeaders(response: Response, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) expectEqual(response.headers.get(name), value, name);
}

export function signingKeysOf(card: JsonObject): readonly JsonObject[] {
  const remotes: unknown = card.remotes;
  const remote: unknown = Array.isArray(remotes) ? remotes[0] : undefined;
  const webhooks = memberOf(memberOf(memberOf(remote, "extensionsInfo"), MCP_EVENTS_EXTENSION), "webhooks");
  const keys = memberOf(memberOf(webhooks, "signingKeys"), "keys");
  return Array.isArray(keys) ? keys.filter(isObject) : [];
}

export async function checkServerCard(checks: Checks, url: string, channel: Channel): Promise<JsonObject | undefined> {
  const cardUrl = `${url}${MCP_SERVER_CARD_PATH}`;
  const first = await fetch(cardUrl, { headers: { Accept: MCP_SERVER_CARD_MEDIA_TYPE }, signal: AbortSignal.timeout(checks.deadline) }).catch(() => undefined);
  if (first !== undefined && first.status !== 200) return undefined;
  let card: JsonObject | undefined;

  await checks.run("GET of the URL of the server and /server-card gives a card that the JSON Schema of the Server Card extension accepts", RULE, async (signal) => {
    const response = first ?? (await fetch(cardUrl, { signal }));
    expectEqual(response.status, 200, "status");
    expectEqual(response.headers.get("Content-Type"), MCP_SERVER_CARD_MEDIA_TYPE, "Content-Type");
    const body = parseJson(await response.text());
    const decoded = decodeCard(body);
    if (Result.isFailure(decoded)) {
      const problems = formatIssues(decoded.failure.issue).issues.map((issue) => `${(issue.path ?? []).map((key) => `[${JSON.stringify(key)}]`).join("")}: ${issue.message}`);
      throw new Error(`the JSON Schema of the Server Card extension refuses the card: ${problems.join("; ")}`);
    }
    expect(isObject(body), "the card must be an object");
    card = body;
  });
  if (card === undefined) return undefined;
  const served = card;

  await checks.run("the card has one remote with the URL of the server, the version of server/discover, and the revisions that the server serves", RULE, async (signal) => {
    const remotes = served.remotes;
    expect(Array.isArray(remotes) && remotes.length === 1, `the card must have one remote, got ${JSON.stringify(remotes)}`);
    const remote: unknown = remotes[0];
    expectEqual(memberOf(remote, "type"), "streamable-http", "the type of the remote");
    expectEqual(memberOf(remote, "url"), url, "the URL of the remote");
    const discovered = memberOf(await channel.request("server/discover", {}, signal), "result");
    expectEqual(served.version, memberOf(memberOf(memberOf(discovered, "_meta"), "io.modelcontextprotocol/serverInfo"), "version"), "the version of the card and of server/discover");
    const versions = memberOf(remote, "supportedProtocolVersions");
    const discoveredVersions = memberOf(discovered, "supportedVersions");
    expect(isStringArray(versions) && isStringArray(discoveredVersions), `supportedProtocolVersions and supportedVersions must be lists of text, got ${JSON.stringify([versions, discoveredVersions])}`);
    for (const version of discoveredVersions) expect(versions.includes(version), `supportedProtocolVersions must have ${version} of server/discover, got ${JSON.stringify(versions)}`);
    for (const version of versions.filter((each) => !discoveredVersions.includes(each))) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "acid-cat-conform", version: "0.1.0" } } }),
        signal,
      });
      const result = memberOf(parseJson(await response.text()), "result");
      expectEqual(memberOf(result, "protocolVersion"), version, `the revision that initialize gives for ${version} of supportedProtocolVersions`);
    }
  });

  await checks.run("the card has the CORS and cache headers and an ETag, If-None-Match with the ETag gets 304 with the same headers and ETag, and OPTIONS gets 204 with no ETag", RULE, async (signal) => {
    const response = await fetch(cardUrl, { signal });
    await response.body?.cancel();
    expectHeaders(response, CORS_HEADERS);
    const etag = response.headers.get("ETag");
    expect(etag !== null && etag !== "", "the card must have an ETag");
    const unchanged = await fetch(cardUrl, { headers: { "If-None-Match": etag }, signal });
    expectEqual(unchanged.status, 304, "the status of a GET with If-None-Match");
    expectEqual(await unchanged.text(), "", "the body of a 304");
    expectHeaders(unchanged, { ...CORS_HEADERS, ETag: etag });
    const preflight = await fetch(cardUrl, { method: "OPTIONS", signal });
    expectEqual(preflight.status, 204, "the status of OPTIONS");
    expectHeaders(preflight, CORS_HEADERS);
    expectEqual(preflight.headers.get("ETag"), null, "the ETag of OPTIONS");
  });

  await checks.run("the signing keys of the card are public Ed25519 keys with a kid, and its egress ranges are CIDR text", RULE, () => {
    const keys = signingKeysOf(served);
    for (const key of keys) {
      expect(key.kty === "OKP" && key.crv === "Ed25519" && typeof key.kid === "string" && typeof key.x === "string", `a signing key must have kty OKP, crv Ed25519, a kid and x, got ${JSON.stringify(key)}`);
      const secrets = PRIVATE_JWK_MEMBERS.filter((member) => member in key);
      expect(secrets.length === 0, `a signing key of the card must have no private member, got ${secrets.join(", ")}`);
    }
    const remotes: unknown = served.remotes;
    const remote: unknown = Array.isArray(remotes) ? remotes[0] : undefined;
    const ranges = memberOf(memberOf(memberOf(memberOf(remote, "extensionsInfo"), MCP_EVENTS_EXTENSION), "webhooks"), "egressIpRanges");
    if (ranges === undefined) return;
    expect(isStringArray(ranges) && ranges.every(isCidr), `egressIpRanges must be a list of CIDR text, got ${JSON.stringify(ranges)}`);
  });
  return served;
}
