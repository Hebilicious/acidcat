import assert from "node:assert/strict";

import type { Run } from "./run.ts";

const STATUS_COMMANDS = ["Commands:", "  aircon aircon status get", "  aircon aircon status export --path <string>", ""].join("\n");

export async function assertHelp(cli: (...args: string[]) => Promise<Run>): Promise<void> {
  assert.deepEqual(await cli("aircon", "status", "--help"), { code: 0, stdout: STATUS_COMMANDS, stderr: "" });
}
