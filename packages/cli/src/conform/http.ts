/** Conformance checks for the HTTP binding (spec/bindings/http.md). */
import { Checks, expect, expectEqual, FORBIDDEN_ORIGIN, idsOf, sorted } from "./check.ts";

const RULE = "spec/bindings/http.md";

export async function checkHttp(base: string, options: { readonly maximumBytes: number; readonly deadline: number }): Promise<Checks> {
  const checks = new Checks("http", options.deadline);
  const post = (signal: AbortSignal | null, id: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/capabilities/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body),
      signal,
    });
  const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

  await checks.run("GET /capabilities lists the view with availability", `${RULE}#requests`, async (signal) => {
    const list = (await (await fetch(`${base}/capabilities`, { signal })).json()) as { id: string; available: boolean }[];
    expectEqual(sorted(list.map((entry) => entry.id)), idsOf("api"), "ids");
    expect(list.every((entry) => typeof entry.available === "boolean"), "each entry must have available");
  });
  await checks.run("a value has the status 200", `${RULE}#requests`, async (signal) => {
    const response = await post(signal, "fixture.echo", { text: "hello" });
    expectEqual(response.status, 200, "status");
    expectEqual(await json(response), { ok: true, value: { text: "hello" } }, "body");
  });
  await checks.run("a failure has the status 200 and ok: false", `${RULE}#requests`, async (signal) => {
    const response = await post(signal, "fixture.refuse", {});
    const body = (await json(response)) as { ok?: boolean; error?: { _tag?: string } };
    expectEqual(response.status, 200, "status");
    expect(body.ok === false && body.error?._tag === "Refused", `got ${JSON.stringify(body)}`);
  });
  for (const [name, id, input, status, kind] of [
    ["invalid input has the status 422", "fixture.echo", { text: 1 }, 422, "invalid-input"],
    ["a capability outside the view has the status 404", "fixture.hidden", {}, 404, "unknown-capability"],
    ["a defect has the status 500", "fixture.crash", {}, 500, "internal"],
  ] as const) {
    await checks.run(name, `${RULE}#requests`, async (signal) => {
      const response = await post(signal, id, input);
      expectEqual(response.status, status, "status");
      expectEqual((await json(response)).kind, kind, "kind");
    });
  }
  await checks.run("an unavailable capability has the status 503", `${RULE}#requests`, async (signal) => {
    await post(signal, "fixture.switch.set", { on: false });
    try {
      const list = (await (await fetch(`${base}/capabilities`, { signal })).json()) as { id: string; available: boolean; reason?: string }[];
      const toggle = list.find((entry) => entry.id === "fixture.toggle");
      expect(toggle?.available === false && typeof toggle.reason === "string", "fixture.toggle must be unavailable, with a reason");
      const response = await post(signal, "fixture.toggle", {});
      expectEqual(response.status, 503, "status");
      expectEqual((await json(response)).kind, "unavailable", "kind");
    } finally {
      await post(null, "fixture.switch.set", { on: true });
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
