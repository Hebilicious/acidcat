/**
 * Conformance checks for the AppFunctions binding (spec/bindings/appfunctions.md). The checks call the app functions of
 * an Android app through the platform, with `adb shell cmd app_function`. The app serves the target `android` of the
 * fixture.
 */
import { execFile } from "node:child_process";

import { isArrayOf, isObject, memberOf, parseJson } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { Checks, expect, expectEqual, fixture, idsOf, sorted, until } from "./check.ts";

const RULE = "spec/bindings/appfunctions.md";
const TARGET = "android";

/** The name of the app function of a capability: `.` gives `_`, and `-` gives `__`. */
export const functionName = (id: string): string => id.replaceAll("-", "__").replaceAll(".", "_");

/** An app function, as the platform lists it. */
export interface AppFunction {
  readonly functionId: string;
  readonly description: string;
  readonly parameters: readonly { readonly name: string; readonly required: boolean }[];
}

/** The end of one execution: the return value, an error with its code, or the end of the time of the execution. */
export type Execution =
  | { readonly returned: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }
  | { readonly timedOut: true };

/** A device with the app installed. The checks use it to list, call, and examine app functions. */
export interface AppFunctionsDevice {
  list(signal: AbortSignal): Promise<readonly AppFunction[]>;
  /** Execute an app function. With `timeoutSeconds`, the platform cancels the execution after that time. */
  execute(functionId: string, parameters: JsonObject, options: { readonly timeoutSeconds?: number; readonly signal: AbortSignal }): Promise<Execution>;
  isEnabled(functionId: string, signal: AbortSignal): Promise<boolean>;
}

/** The options of the AppFunctions checks. */
export interface AppFunctionsOptions {
  /** The package name of the app, for example `dev.acidcat.fixture`. */
  readonly package: string;
  /** The serial number of the device, as `adb devices` gives it. Without it, adb uses its default device. */
  readonly serial?: string | undefined;
  /** The adb program. The default is `adb`. */
  readonly adb?: string | undefined;
}

/** A text as one word of the shell of the device. */
const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** The app functions of a package on a device, through `adb shell cmd app_function`. */
export function adbDevice(options: AppFunctionsOptions): AppFunctionsDevice {
  const adb = options.adb ?? "adb";
  const target = options.serial === undefined ? [] : ["-s", options.serial];
  const shell = (words: readonly string[], signal: AbortSignal) =>
    new Promise<{ readonly code: number; readonly output: string }>((resolve, reject) => {
      execFile(adb, [...target, "shell", words.map(quote).join(" ")], { signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (signal.aborted) return reject(new Error(`waiting for adb: ${words.join(" ")}`));
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        if (error !== null && typeof error.code !== "number") return reject(error);
        resolve({ code, output: `${stdout}${stderr}` });
      });
    });
  const command = ["cmd", "app_function"];
  return {
    async list(signal) {
      const { output } = await shell([...command, "list-app-functions", "--package", options.package], signal);
      let listed: unknown;
      try {
        listed = parseJson(output);
      } catch {
        throw new Error(`list-app-functions gave text that is not JSON: ${output.trim().slice(0, 500)}`);
      }
      return functionsOf(listed, options.package);
    },
    async execute(functionId, parameters, { timeoutSeconds, signal }) {
      const words = [...command, "execute-app-function", "--package", options.package, "--function", functionId, "--parameters", JSON.stringify(parameters)];
      const { output } = await shell(timeoutSeconds === undefined ? words : [...words, "--timeout-duration", String(timeoutSeconds)], signal);
      return executionOf(output);
    },
    async isEnabled(functionId, signal) {
      const { output } = await shell([...command, "is-enabled", "--package", options.package, "--function", functionId], signal);
      if (output.trim() === "true") return true;
      if (output.trim() === "false") return false;
      throw new Error(`is-enabled gave ${JSON.stringify(output.trim())}`);
    },
  };
}

/** The first item of a member that the platform writes as a list, as AppSearch documents have it. */
const firstOf = (value: unknown, key: string): unknown => {
  const list = memberOf(value, key);
  return Array.isArray(list) ? list[0] : undefined;
};

/** The app functions in the output of `list-app-functions`. */
function functionsOf(output: unknown, packageName: string): readonly AppFunction[] {
  const documents = memberOf(output, packageName);
  if (!Array.isArray(documents)) throw new Error(`list-app-functions gave no app functions for ${packageName}`);
  return documents.flatMap((document): AppFunction[] => {
    const metadata = memberOf(document, `AppFunctionStaticMetadata-${packageName}`);
    if (!isObject(metadata)) return [];
    const functionId = firstOf(metadata, "functionId");
    if (typeof functionId !== "string") throw new Error(`an app function has no functionId: ${JSON.stringify(metadata)}`);
    const description = firstOf(metadata, "description");
    const parameters = memberOf(metadata, "parameters");
    return [
      {
        functionId,
        description: typeof description === "string" ? description : "",
        parameters: (Array.isArray(parameters) ? parameters : []).map((parameter: unknown) => ({
          name: String(firstOf(parameter, "name")),
          required: firstOf(parameter, "isRequired") === true,
        })),
      },
    ];
  });
}

/** The execution that the output of `execute-app-function` tells. */
function executionOf(output: string): Execution {
  if (/^Timed out\b/m.test(output)) return { timedOut: true };
  const failed = /Error executing app function: .*?: (.*) \(code (\d+)\)/s.exec(output);
  if (failed !== null) return { error: { code: Number(failed[2]), message: failed[1] ?? "" } };
  let parsed: unknown;
  try {
    parsed = parseJson(output);
  } catch {
    throw new Error(`execute-app-function gave ${JSON.stringify(output.trim())}`);
  }
  return { returned: firstOf(parsed, "androidAppfunctionsReturnValue") };
}

/** The value of a property of returned data that is not a list. The platform writes it as a list of one item. */
function property(data: unknown, name: string): unknown {
  const list = memberOf(data, name);
  if (!Array.isArray(list) || list.length !== 1) throw new Error(`the returned data has no single value ${name}: ${JSON.stringify(data)}`);
  return list[0];
}

/** The returned data of an execution. The check fails when the execution did not return. */
function returned(execution: Execution, what: string): unknown {
  if ("returned" in execution) return execution.returned;
  throw new Error(`${what} must return, got ${JSON.stringify(execution)}`);
}

/** Fail unless the execution ended with an error that has the code. */
function expectCode(execution: Execution, code: number, what: string): string {
  if ("error" in execution && execution.error.code === code) return execution.error.message;
  throw new Error(`${what} must fail with the code ${code}, got ${JSON.stringify(execution)}`);
}

/** The time of a call that the platform cancels, in seconds. The check sees the call hold before this time ends. */
const CANCEL_SECONDS = 5;

/** The time of a call that the check releases, in seconds. */
const KEPT_SECONDS = 600;

/** The error code of each kind of call failure (spec/bindings/appfunctions.md#outcomes). */
const CODES = { "invalid-input": 1001, unavailable: 1002, "unknown-capability": 1003, internal: 3000 } as const;

/** Run the AppFunctions checks against a device. */
export async function checkAppFunctions(device: AppFunctionsDevice, options: { readonly deadline: number }): Promise<Checks> {
  const checks = new Checks("appfunctions", options.deadline);
  const view = idsOf(TARGET);
  let functions: readonly AppFunction[] = [];
  const idOf = (id: string): string => {
    const found = functions.find((each) => each.functionId.endsWith(`#${functionName(id)}`));
    if (found === undefined) throw new Error(`there is no app function ${functionName(id)}`);
    return found.functionId;
  };
  const call = (id: string, parameters: JsonObject, signal: AbortSignal, timeoutSeconds?: number) =>
    device.execute(idOf(id), parameters, { signal, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) });
  const held = async (signal: AbortSignal): Promise<readonly string[]> => {
    const keys = memberOf(returned(await call("fixture.held", {}, signal), "fixture.held"), "keys");
    if (!isArrayOf(keys, (key): key is string => typeof key === "string")) throw new Error(`fixture.held gave ${JSON.stringify(keys)}`);
    return keys;
  };
  const release = (key: string, signal: AbortSignal) => call("fixture.release", { key }, signal);

  await checks.run("the platform lists one app function for each capability of the view", `${RULE}#names`, async (signal) => {
    // The platform indexes the app functions of an app after it installs the app, so the check waits for the list.
    let problem = "";
    functions = await until(
      "the platform lists the app functions of the package",
      () =>
        device.list(signal).catch((error: unknown) => {
          problem = error instanceof Error ? error.message : String(error);
          return [];
        }),
      (listed) => listed.length > 0,
      signal,
    ).catch((error: unknown) => {
      throw new Error(problem === "" ? String(error) : problem);
    });
    const names = functions.map((each) => each.functionId.slice(each.functionId.lastIndexOf("#") + 1));
    expectEqual(sorted(names), sorted(view.map(functionName)), "the names of the app functions");
  });

  await checks.run("an app function has the description of its capability, and one parameter for each property", `${RULE}#input`, () => {
    const capabilities = fixture.capabilities;
    for (const id of view) {
      const found = functions.find((each) => each.functionId === idOf(id));
      expectEqual(found?.description, capabilities[id]?.description, `the description of ${functionName(id)}`);
    }
    const hold = functions.find((each) => each.functionId === idOf("fixture.hold"));
    expectEqual(
      sorted((hold?.parameters ?? []).map((each) => `${each.name}${each.required ? "" : "?"}`)),
      ["key", "marker?"],
      "the parameters of fixture_hold",
    );
  });

  await checks.run("a value is the return value", `${RULE}#outcomes`, async (signal) => {
    const echo = returned(await call("fixture.echo", { text: "hello" }, signal), "fixture.echo");
    expectEqual(property(echo, "text"), "hello", "the text of fixture.echo");
  });

  await checks.run("a failure is a returned result with ok false and the tag of the failure", `${RULE}#outcomes`, async (signal) => {
    const result = returned(await call("fixture.refuse", {}, signal), "fixture.refuse");
    expectEqual(property(result, "ok"), false, "ok");
    const error = property(result, "error");
    expectEqual(property(error, "tag"), "Refused", "the tag of the failure");
    expectEqual(property(property(error, "refused"), "reason"), "No.", "the reason of the failure");
  });

  await checks.run("a defect fails with the code 3000 and no internal details", `${RULE}#outcomes`, async (signal) => {
    const message = expectCode(await call("fixture.crash", {}, signal), CODES.internal, "fixture.crash");
    expect(!message.includes("secret"), `the message must not show internal details: ${message}`);
  });

  await checks.run("an input that does not agree with its schema fails with the code 1001, and the operation does not start", `${RULE}#outcomes`, async (signal) => {
    expectCode(await call("fixture.echo", { text: 5 }, signal), CODES["invalid-input"], "fixture.echo with a number");
    expectCode(await call("fixture.hold", { marker: "no key" }, signal), CODES["invalid-input"], "fixture.hold with no key");
    expectEqual(await held(signal), [], "the keys that hold");
  });

  await checks.run("a capability outside the view has no app function, and a call fails with the code 1003", `${RULE}#outcomes`, async (signal) => {
    const hidden = idOf("fixture.echo").replace(/#.*$/, `#${functionName("fixture.hidden")}`);
    expectCode(await device.execute(hidden, {}, { signal }), CODES["unknown-capability"], "fixture_hidden");
  });

  await checks.run("an unavailable capability is disabled, and a call fails with the code 1002", `${RULE}#listing`, async (signal) => {
    const toggle = idOf("fixture.toggle");
    try {
      returned(await call("fixture.switch.set", { on: false }, signal), "fixture.switch.set");
      await until("fixture_toggle is disabled", () => device.isEnabled(toggle, signal), (enabled) => !enabled, signal);
      expectCode(await call("fixture.toggle", {}, signal), CODES.unavailable, "fixture.toggle while the switch is off");
    } finally {
      await call("fixture.switch.set", { on: true }, AbortSignal.timeout(options.deadline));
    }
    await until("fixture_toggle is enabled", () => device.isEnabled(toggle, signal), (enabled) => enabled, signal);
    returned(await call("fixture.toggle", {}, signal), "fixture.toggle while the switch is on");
  });

  await checks.run("the platform cancels a call at the end of its time, and the call stops", `${RULE}#cancellation`, async (signal) => {
    const key = `cancel-${Date.now()}`;
    try {
      const execution = call("fixture.hold", { key }, signal, CANCEL_SECONDS);
      await until("the call holds", () => held(signal), (keys) => keys.includes(key), signal);
      expectEqual(await execution, { timedOut: true }, "the end of the call");
      await until("the cancelled call stops holding", () => held(signal), (keys) => !keys.includes(key), signal);
    } finally {
      await release(key, AbortSignal.timeout(options.deadline));
    }
  });

  await checks.run("the cancellation of one call does not change other calls", "spec/invocation.md#cancellation-and-concurrency", async (signal) => {
    const kept = `kept-${Date.now()}`;
    const cancelled = `cancelled-${Date.now()}`;
    try {
      // The other call has a long time, and the check releases it. The deadline of the check stops it if it does not end.
      const keeping = call("fixture.hold", { key: kept }, signal, KEPT_SECONDS);
      const cancelling = call("fixture.hold", { key: cancelled }, signal, CANCEL_SECONDS);
      await until("both calls hold", () => held(signal), (keys) => keys.includes(kept) && keys.includes(cancelled), signal);
      expectEqual(await cancelling, { timedOut: true }, "the end of the cancelled call");
      await until("the cancelled call stops holding", () => held(signal), (keys) => !keys.includes(cancelled), signal);
      expect((await held(signal)).includes(kept), "the other call must still hold");
      await release(kept, signal);
      expectEqual(property(returned(await keeping, "the other call"), "key"), kept, "the key of the other call");
    } finally {
      await release(kept, AbortSignal.timeout(options.deadline));
      await release(cancelled, AbortSignal.timeout(options.deadline));
    }
  });

  await checks.run("concurrent calls each get exactly their own outcome", "spec/invocation.md#cancellation-and-concurrency", async (signal) => {
    const texts = Array.from({ length: 6 }, (_, index) => `text ${index} ${Date.now()}`);
    const echoes = texts.map((text) => call("fixture.echo", { text }, signal));
    const refused = call("fixture.refuse", {}, signal);
    const crashed = call("fixture.crash", {}, signal);
    const values = await Promise.all(echoes);
    values.forEach((execution, index) => expectEqual(property(returned(execution, "fixture.echo"), "text"), texts[index], `echo ${index}`));
    expectEqual(property(returned(await refused, "fixture.refuse"), "ok"), false, "the refused call");
    expectCode(await crashed, CODES.internal, "the crashed call");
  });

  return checks;
}
