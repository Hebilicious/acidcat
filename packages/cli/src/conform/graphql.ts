/** Conformance checks for the GraphQL binding (spec/bindings/graphql.md). */
import { Checks, expect, expectEqual, FORBIDDEN_ORIGIN, idsOf, sorted } from "./check.ts";

const RULE = "spec/bindings/graphql.md";

interface Answer {
  readonly data?: Record<string, any> | null;
  readonly errors?: readonly { readonly message: string; readonly extensions?: { readonly kind?: string } }[];
}

export async function checkGraphql(url: string): Promise<Checks> {
  const checks = new Checks("graphql");
  const query = async (source: string, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ query: source }) });
    expectEqual(response.status, 200, "status");
    return (await response.json()) as Answer;
  };

  await checks.run("acidcatCapabilities lists the view with availability", `${RULE}#schema`, async () => {
    const answer = await query("{ acidcatCapabilities { id available reason } }");
    expectEqual(sorted((answer.data?.acidcatCapabilities as { id: string }[]).map((entry) => entry.id)), idsOf("graphql"), "ids");
  });
  await checks.run("a read-only capability is a query, and its value is the value type", `${RULE}#schema`, async () => {
    const answer = await query('{ fixtureEcho(input: { text: "hello" }) { __typename ... on FixtureEchoValue { text } } }');
    expectEqual(answer.data?.fixtureEcho, { __typename: "FixtureEchoValue", text: "hello" }, "fixtureEcho");
  });
  await checks.run("a failure is a failure type of the union", `${RULE}#schema`, async () => {
    const answer = await query("mutation { fixtureRefuse { __typename ... on FixtureRefuseRefused { _tag reason } } }");
    const value = answer.data?.fixtureRefuse as { __typename?: string; _tag?: string };
    expect(value?.__typename === "FixtureRefuseRefused" && value._tag === "Refused", `got ${JSON.stringify(answer)}`);
  });
  await checks.run("a value that is not an object is in the value field", `${RULE}#schema`, async () => {
    const answer = await query("mutation { fixtureSwitchSet(input: { on: true }) { __typename ... on FixtureSwitchSetValue { value } } }");
    expectEqual(answer.data?.fixtureSwitchSet, { __typename: "FixtureSwitchSetValue", value: null }, "fixtureSwitchSet");
  });
  await checks.run("a call failure is an error with its kind, and the field is null", `${RULE}#schema`, async () => {
    const answer = await query("mutation { fixtureCrash { __typename } }");
    expect(answer.data?.fixtureCrash === null, "the field must be null");
    expectEqual(answer.errors?.[0]?.extensions?.kind, "internal", "extensions.kind");
  });
  await checks.run("acidcatInvoke gives each outcome in its JSON form", `${RULE}#schema`, async () => {
    const answer = await query(
      'mutation { a: acidcatInvoke(id: "fixture.echo", input: { text: 1 }) b: acidcatInvoke(id: "fixture.hidden") c: acidcatInvoke(id: "fixture.echo", input: { text: "x" }) }',
    );
    expectEqual((answer.data?.a as { kind?: string }).kind, "invalid-input", "invalid input");
    expectEqual((answer.data?.b as { kind?: string }).kind, "unknown-capability", "a capability outside the view");
    expectEqual(answer.data?.c, { ok: true, value: { text: "x" } }, "a value");
  });
  await checks.run("a capability outside the view has no field", `${RULE}#schema`, async () => {
    const answer = await query("mutation { fixtureHidden { __typename } }");
    expect((answer.errors?.length ?? 0) > 0, "a query for fixtureHidden must fail");
  });
  await checks.run("requests are rejected as remote bindings tell", "spec/bindings/README.md#remote-bindings", async () => {
    expectEqual((await fetch(url)).status, 405, "GET");
    expectEqual((await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415, "media type");
    expectEqual((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: FORBIDDEN_ORIGIN }, body: "{}" })).status, 403, "origin");
  });

  return checks;
}
