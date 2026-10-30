import assert from "node:assert/strict";
import { test } from "node:test";

import { conform, functionName } from "../src/conform/index.ts";
import type { AppFunction, AppFunctionsDevice, Execution } from "../src/conform/index.ts";
import type { JsonObject } from "../src/json.ts";

const SERVICE = "dev.acidcat.fixture.FixtureFunctions";

/** The platform writes each property of returned data as a list. */
const data = (members: { readonly [name: string]: unknown }): JsonObject =>
  Object.fromEntries(Object.entries(members).map(([name, value]) => [name, Array.isArray(value) ? value : [value]]));

/**
 * A device in memory, with the fixture as app functions, as the AppFunctions binding serves it. `broken` changes one
 * behavior, so that the checks can be seen to fail.
 */
function fakeDevice(broken?: "cancellation" | "failure"): AppFunctionsDevice {
  let on = true;
  const holding = new Map<string, () => void>();
  const declared: readonly (readonly [string, AppFunction["parameters"]])[] = [
    ["fixture.crash", []],
    ["fixture.echo", [{ name: "text", required: true }]],
    ["fixture.held", []],
    ["fixture.hold", [{ name: "key", required: true }, { name: "marker", required: false }]],
    ["fixture.refuse", []],
    ["fixture.release", [{ name: "key", required: true }]],
    ["fixture.switch.set", [{ name: "on", required: true }]],
    ["fixture.toggle", []],
  ];
  const functions: AppFunction[] = declared.map(([id, parameters]) => ({
    functionId: `${SERVICE}#${functionName(id)}`,
    description: descriptions[id] ?? "",
    parameters,
  }));

  const execute = async (name: string, parameters: JsonObject, timeoutSeconds: number | undefined): Promise<Execution> => {
    switch (name) {
      case "fixture_echo":
        return typeof parameters.text === "string" ? { returned: data({ text: parameters.text }) } : { error: { code: 1001, message: "text" } };
      case "fixture_refuse":
        return broken === "failure"
          ? { error: { code: 3000, message: "Refused" } }
          : { returned: data({ ok: false, error: data({ tag: "Refused", refused: data({ reason: "No." }) }) }) };
      case "fixture_crash":
        return { error: { code: 3000, message: "The capability failed." } };
      case "fixture_held":
        return { returned: { keys: [...holding.keys()] } };
      case "fixture_release":
        holding.get(String(parameters.key))?.();
        return { returned: undefined };
      case "fixture_switch_set":
        on = parameters.on === true;
        return { returned: undefined };
      case "fixture_toggle":
        return on ? { returned: undefined } : { error: { code: 1002, message: "The app function is disabled" } };
      case "fixture_hold": {
        if (typeof parameters.key !== "string") return { error: { code: 1001, message: "key" } };
        const key = parameters.key;
        return new Promise<Execution>((resolve) => {
          holding.set(key, () => {
            holding.delete(key);
            resolve({ returned: data({ key }) });
          });
          if (timeoutSeconds !== undefined) {
            setTimeout(() => {
              if (broken !== "cancellation") holding.delete(key);
              resolve({ timedOut: true });
              // The fake device ends the time of a call 100 times faster than a device.
            }, timeoutSeconds * 10);
          }
        });
      }
      default:
        return { error: { code: 1003, message: "App function not found." } };
    }
  };

  return {
    list: () => Promise.resolve(functions),
    execute: (functionId, parameters, { timeoutSeconds }) => execute(functionId.slice(functionId.indexOf("#") + 1), parameters, timeoutSeconds),
    isEnabled: (functionId) => Promise.resolve(!functionId.endsWith("#fixture_toggle") || on),
  };
}

const descriptions: { readonly [id: string]: string } = {
  "fixture.crash": "Always fail with a defect.",
  "fixture.echo": "Return the input text.",
  "fixture.held": "Return the keys of the calls to fixture.hold that hold now.",
  "fixture.hold":
    "Hold until fixture.release releases the key, then return the key. While the call holds, fixture.held gives the key. With a marker, the call writes a file at that path when it starts to hold.",
  "fixture.refuse": "Always return the failure Refused.",
  "fixture.release": "Release the calls to fixture.hold that hold the key.",
  "fixture.switch.set": "Turn the switch on or off. The switch controls the availability of fixture.toggle.",
  "fixture.toggle": "Available only while the switch is on.",
};

test("a function name comes from the id, and two ids never give the same name", () => {
  assert.equal(functionName("aircon.power.set"), "aircon_power_set");
  assert.equal(functionName("a-b.c"), "a__b_c");
  assert.equal(functionName("a.b-c"), "a_b__c");
});

test("a device that serves the AppFunctions binding passes every check", async () => {
  const results = await conform({ appfunctions: fakeDevice(), deadline: 5_000 });
  const failed = results.filter((result) => !result.passed);
  assert.deepEqual(failed, [], failed.map((result) => `${result.name}: ${result.detail}`).join("\n"));
  assert.ok(results.length >= 11);
});

test("the checks fail when a failure is an error, or when a cancelled call keeps holding", async () => {
  const failure = await conform({ appfunctions: fakeDevice("failure"), deadline: 2_000 });
  assert.ok(failure.some((result) => !result.passed && result.name.startsWith("a failure is a returned result")));
  const cancellation = await conform({ appfunctions: fakeDevice("cancellation"), deadline: 2_000 });
  assert.ok(cancellation.some((result) => !result.passed && result.name.startsWith("the platform cancels a call")));
});
