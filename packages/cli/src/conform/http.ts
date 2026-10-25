/** Conformance checks for the HTTP binding (spec/bindings/http.md). */
import { isArrayOf, isObject, memberOf, readJson } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { Checks, expect, expectEqual, FORBIDDEN_ORIGIN, idsOf, sorted } from "./check.ts";

const RULE = "spec/bindings/http.md";

/** An entry of the list that `GET /capabilities` gives. */
type Entry = JsonObject & { readonly id: string };

const isEntry = (value: unknown): value is Entry => isObject(value) && typeof value.id === "string";

/** The list that `GET /capabilities` gives. The check fails when it is not a list of entries. */
async function entriesOf(response: Response): Promise<readonly Entry[]> {
  const list = await readJson(response);
  if (!isArrayOf(list, isEntry)) throw new Error(`GET /capabilities must give a list of objects with an id, got ${JSON.stringify(list)}`);
  return list;
}

export async function checkHttp(base: string, options: { readonly maximumBytes: number; readonly deadline: number }): Promise<Checks> {
  const checks = new Checks("http", options.deadline);
  const post = (signal: AbortSignal, id: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/capabilities/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : body instanceof Uint8Array ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
      signal,
    });
  const kindOf = async (response: Response) => memberOf(await readJson(response), "kind");

  await checks.run("GET /capabilities lists the view with availability", `${RULE}#requests`, async (signal) => {
    const list = await entriesOf(await fetch(`${base}/capabilities`, { signal }));
    expectEqual(sorted(list.map((entry) => entry.id)), idsOf("api"), "ids");
    expect(list.every((entry) => typeof entry.available === "boolean"), "each entry must have available");
  });
  await checks.run("a value has the status 200", `${RULE}#requests`, async (signal) => {
    const response = await post(signal, "fixture.echo", { text: "hello" });
    expectEqual(response.status, 200, "status");
    expectEqual(await readJson(response), { ok: true, value: { text: "hello" } }, "body");
  });
  await checks.run("a failure has the status 200 and ok: false", `${RULE}#requests`, async (signal) => {
    const response = await post(signal, "fixture.refuse", {});
    const body = await readJson(response);
    expectEqual(response.status, 200, "status");
    expect(memberOf(body, "ok") === false && memberOf(memberOf(body, "error"), "_tag") === "Refused", `got ${JSON.stringify(body)}`);
  });
  for (const [name, id, input, status, kind] of [
    ["invalid input has the status 422", "fixture.echo", { text: 1 }, 422, "invalid-input"],
    ["a capability outside the view has the status 404", "fixture.hidden", {}, 404, "unknown-capability"],
    ["a defect has the status 500", "fixture.crash", {}, 500, "internal"],
  ] as const) {
    await checks.run(name, `${RULE}#requests`, async (signal) => {
      const response = await post(signal, id, input);
      expectEqual(response.status, status, "status");
      expectEqual(await kindOf(response), kind, "kind");
    });
  }
  await checks.run("an unavailable capability has the status 503", `${RULE}#requests`, async (signal) => {
    await post(signal, "fixture.switch.set", { on: false });
    try {
      const list = await entriesOf(await fetch(`${base}/capabilities`, { signal }));
      const toggle = list.find((entry) => entry.id === "fixture.toggle");
      expect(toggle?.available === false && typeof toggle.reason === "string", "fixture.toggle must be unavailable, with a reason");
      const response = await post(signal, "fixture.toggle", {});
      expectEqual(response.status, 503, "status");
      expectEqual(await kindOf(response), "unavailable", "kind");
    } finally {
      await post(AbortSignal.timeout(options.deadline), "fixture.switch.set", { on: true });
    }
  });

  const status = async (response: Response, expected: number) => expectEqual(response.status, expected, "status");
  await checks.run("a method that is not accepted is rejected with 405", `${RULE}#requests`, async (signal) => {
    await status(await fetch(`${base}/capabilities`, { method: "PUT", signal }), 405);
  });
  await checks.run("an origin that is not allowed is rejected with 403", `${RULE}#requests`, async (signal) => {
    await status(await post(signal, "fixture.echo", { text: "x" }, { Origin: FORBIDDEN_ORIGIN }), 403);
  });
  await checks.run("a media type other than JSON is rejected with 415", `${RULE}#requests`, async (signal) => {
    await status(await post(signal, "fixture.echo", { text: "x" }, { "Content-Type": "text/plain" }), 415);
  });
  await checks.run("a body over the limit is rejected with 413", `${RULE}#requests`, async (signal) => {
    await status(await post(signal, "fixture.echo", " ".repeat(options.maximumBytes + 1)), 413);
  });
  await checks.run("a body that is not UTF-8 is rejected with 400", `${RULE}#requests`, async (signal) => {
    await status(await post(signal, "fixture.echo", new Uint8Array([0x7b, 0xff, 0x7d])), 400);
  });

  return checks;
}
