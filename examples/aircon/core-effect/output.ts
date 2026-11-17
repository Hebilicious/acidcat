import { App, Cli } from "@acid-cat/core-effect";

import type * as Types from "../catalog/aircon.types.ts";
import { statusChanged, statusGet } from "./aircon.ts";

const statusText = ({ power, mode, fan, targetCelsius, roomCelsius }: Types.Status, ui: Cli.Ui) =>
  `${ui.bold(power ? "on" : "off")} · ${mode} · fan ${fan} · target ${targetCelsius}°C · room ${roomCelsius}°C`;

export const output: Cli.Output = {
  default: "auto",
  flags: [
    { names: ["--output", "-o"], values: { human: "human", json: "json" } },
    { names: ["--json"], form: "json" },
  ],
  formats: [
    App.format(statusGet, {
      value: statusText,
      failures: { Offline: ({ since }, ui) => `${ui.error("offline")}${since === undefined ? "" : ` since ${since}`}` },
    }),
    App.format(statusChanged, statusText),
  ],
};
