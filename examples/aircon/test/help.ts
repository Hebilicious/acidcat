import assert from "node:assert/strict";

import type { Run } from "./run.ts";

const POWER_SET = "aircon aircon power set --on";
const STATUS_GET = "aircon aircon status get";
const STATUS_EXPORT = "aircon aircon status export --path <string>";
const EVERY_COMMAND = [
  STATUS_GET,
  POWER_SET,
  "aircon aircon mode set --mode <cool|heat|dry|fan|auto>",
  "aircon aircon temperature set --celsius <number>",
  "aircon aircon fan set --speed <auto|low|medium|high>",
  "aircon aircon schedule set --days <mon|tue|wed|thu|fri|sat|sun>... [--hours <integer>...]",
  STATUS_EXPORT,
];

const commandList = (usages: readonly string[]): string => ["Commands:", ...usages.map((usage) => `  ${usage}`), ""].join("\n");

export async function assertHelp(cli: (...args: string[]) => Promise<Run>): Promise<void> {
  assert.deepEqual(await cli("aircon", "power", "set", "--help"), { code: 0, stdout: `Usage: ${POWER_SET}\n\nTurn the unit on or off.\n`, stderr: "" });
  assert.deepEqual(await cli("aircon", "power", "--help"), { code: 0, stdout: commandList([POWER_SET]), stderr: "" });
  assert.deepEqual(await cli("aircon", "status", "--help"), { code: 0, stdout: commandList([STATUS_GET, STATUS_EXPORT]), stderr: "" });
  assert.deepEqual(await cli("aircon", "--help"), { code: 0, stdout: commandList(EVERY_COMMAND), stderr: "" });
  assert.deepEqual(await cli("aircon", "power"), { code: 2, stdout: "", stderr: commandList([POWER_SET]) });
  const unknown = await cli("nope");
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stdout, "");
}
