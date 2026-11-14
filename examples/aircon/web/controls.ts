/**
 * The controls of the web page of the air conditioner, in the browser. Both TypeScript cores use them: each page gives
 * the actions and the values of its own session, and these functions show them in the elements of `markup` in
 * `page.ts`. The page has no dependency on a core.
 */
import type { CallFailure, Outcome } from "@acid-cat/spec-ts";

export interface Status {
  readonly power: boolean;
  readonly mode: string;
  readonly fan: string;
  readonly targetCelsius: number;
  readonly roomCelsius: number;
}

/** The status of the WebMCP tools, as both cores give it. */
export interface ToolStatus {
  readonly phase: string;
  readonly message: string | null;
}

/** The availability of one capability of the view. While it is available, the page has a WebMCP tool for it. */
export interface Tool {
  readonly id: string;
  readonly available: boolean;
  readonly reason?: string | undefined;
}

/** What the controls do. Each action calls one capability through the session of the page, and gives its outcome. */
export interface Actions {
  readonly power: (on: boolean) => Promise<Outcome<unknown, unknown>>;
  readonly mode: (mode: string) => Promise<Outcome<unknown, unknown>>;
  readonly temperature: (celsius: number) => Promise<Outcome<unknown, unknown>>;
  readonly fan: (speed: string) => Promise<Outcome<unknown, unknown>>;
  readonly firmware: () => Promise<Outcome<unknown, unknown>>;
  /** Connect or disconnect the simulated unit. This is not a capability: it simulates the network. */
  readonly online: (online: boolean) => void;
}

/** What the page shows. */
export interface View {
  readonly showStatus: (status: Status) => void;
  /** Show the status of the WebMCP tools, or `undefined` when the browser has no WebMCP host. */
  readonly showToolStatus: (status: ToolStatus | undefined) => void;
  readonly showTools: (tools: readonly Tool[]) => void;
}

/** The element with this id, of this kind. The page throws if the markup does not have it. */
function find<T extends HTMLElement>(id: string, kind: { new (): T; prototype: T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof kind)) throw new Error(`The page has no ${kind.name} with the id ${id}.`);
  return element;
}

/** The outcome of a call that rejects with a call failure, for example a `CallFailureError`. */
export function callFailureOf(error: unknown): CallFailure {
  const kind = typeof error === "object" && error !== null && "kind" in error ? error.kind : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return { kind: kind === "cancelled" || kind === "unknown-capability" || kind === "unavailable" || kind === "invalid-input" ? kind : "internal", message };
}

/** A line of text that tells the outcome of a call. */
function describe(outcome: Outcome<unknown, unknown>): string {
  if ("kind" in outcome) return `Call failure ${outcome.kind}: ${outcome.message}`;
  if (outcome.ok) return "Done.";
  const tag = typeof outcome.error === "object" && outcome.error !== null && "_tag" in outcome.error ? String(outcome.error._tag) : "unknown";
  return `Failure ${tag}.`;
}

/** Connect the controls of the page to the actions, and give the functions that show the values of the session. */
export function bindPage(core: string, actions: Actions): View {
  find("core", HTMLElement).textContent = core;
  const result = find("result", HTMLOutputElement);
  const power = find("power", HTMLButtonElement);
  const mode = find("mode", HTMLSelectElement);
  const celsius = find("celsius", HTMLInputElement);
  const fan = find("fan", HTMLSelectElement);
  const online = find("online", HTMLInputElement);
  let on = false;

  const run = (action: () => Promise<Outcome<unknown, unknown>>) => {
    void action().then(
      (outcome) => (result.textContent = describe(outcome)),
      (error: unknown) => (result.textContent = describe(callFailureOf(error))),
    );
  };
  power.addEventListener("click", () => run(() => actions.power(!on)));
  mode.addEventListener("change", () => run(() => actions.mode(mode.value)));
  find("set-temperature", HTMLButtonElement).addEventListener("click", () => run(() => actions.temperature(celsius.valueAsNumber)));
  fan.addEventListener("change", () => run(() => actions.fan(fan.value)));
  find("firmware", HTMLButtonElement).addEventListener("click", () => run(() => actions.firmware()));
  online.addEventListener("change", () => actions.online(online.checked));

  return {
    showStatus(status) {
      on = status.power;
      find("status-power", HTMLElement).textContent = status.power ? "on" : "off";
      find("status-mode", HTMLElement).textContent = status.mode;
      find("status-fan", HTMLElement).textContent = status.fan;
      find("status-target", HTMLElement).textContent = `${status.targetCelsius} °C`;
      find("status-room", HTMLElement).textContent = `${status.roomCelsius} °C`;
      power.textContent = status.power ? "Turn off" : "Turn on";
      mode.value = status.mode;
      fan.value = status.fan;
      if (document.activeElement !== celsius) celsius.valueAsNumber = status.targetCelsius;
    },
    showToolStatus(status) {
      find("webmcp-phase", HTMLElement).textContent = status?.phase ?? "no host";
      find("webmcp-message", HTMLElement).textContent =
        status === undefined ? "This browser has no document.modelContext or navigator.modelContext." : (status.message ?? "");
    },
    showTools(tools) {
      const items = tools.map((tool) => {
        const item = document.createElement("li");
        item.dataset.id = tool.id;
        item.dataset.available = String(tool.available);
        item.textContent = tool.available ? `${tool.id}: available` : `${tool.id}: unavailable (${tool.reason ?? "no reason"})`;
        return item;
      });
      find("tools", HTMLUListElement).replaceChildren(...items);
    },
  };
}
