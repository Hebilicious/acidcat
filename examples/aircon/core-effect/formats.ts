import { App, Cli } from "@acid-cat/core-effect";

import { Status, statusChanged, statusGet } from "./aircon.ts";

const statusText = ({ power, mode, fan, targetCelsius, roomCelsius }: typeof Status.Type, ui: Cli.Ui) =>
  `${ui.bold(power ? "on" : "off")} · ${mode} · fan ${fan} · target ${targetCelsius}°C · room ${roomCelsius}°C`;

export const formats = [
  App.format(statusGet, {
    value: statusText,
    failures: { Offline: ({ since }, ui) => `${ui.error("offline")}${since === undefined ? "" : ` since ${since}`}` },
  }),
  App.format(statusChanged, statusText),
];
