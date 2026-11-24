const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
const asText = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const parts = (version: string) => version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
const newer = (a: string, b: string) => {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

const latestVersion = (registry: string, body: unknown): string | undefined => {
  if (registry === "npm") return asText(field(body, "version"));
  if (registry === "crates.io") return asText(field(body, "crate", "max_stable_version")) ?? asText(field(body, "crate", "newest_version"));
  if (registry === "PyPI") return asText(field(body, "info", "version"));
  if (registry === "Go") return asText(field(body, "Version"))?.replace(/^v/, "");
  if (registry === "Pkl" && Array.isArray(body)) {
    const versions = body.map((entry) => asText(field(entry, "ref"))?.split("@").pop()).filter((entry): entry is string => entry !== undefined);
    return versions.reduce<string | undefined>((best, entry) => (best === undefined || newer(entry, best) ? entry : best), undefined);
  }
  return undefined;
};

/** Copies the install command of a card when the reader clicks its button. */
export const copyInstallCommands = (root: HTMLElement, signal: AbortSignal): void => {
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    const label = button.querySelector<HTMLElement>("[data-copy-label]");
    button.addEventListener(
      "click",
      () => {
        navigator.clipboard.writeText(button.dataset["copy"] ?? "").then(
          () => {
            button.dataset["copied"] = "";
            if (label !== null) label.textContent = "Copied";
            window.setTimeout(() => {
              delete button.dataset["copied"];
              if (label !== null) label.textContent = "Copy";
            }, 1600);
          },
          () => undefined,
        );
      },
      { signal },
    );
  }
};

/** Asks each registry for the latest version of each package, and shows it on its card. */
export const showLiveVersions = (root: HTMLElement, signal: AbortSignal): void => {
  for (const card of root.querySelectorAll<HTMLElement>(".package-card")) {
    const url = card.dataset["latest"];
    const registry = card.dataset["registry"] ?? "";
    const version = card.dataset["version"] ?? "";
    const label = card.querySelector<HTMLElement>("[data-live-version]");
    const status = card.querySelector<HTMLElement>("[data-live-status]");
    if (url === undefined || label === null || status === null) continue;
    fetch(url, { headers: { Accept: "application/json" }, priority: "low", signal })
      .then(async (response) => (response.ok ? latestVersion(registry, await response.json()) : undefined))
      .then((latest) => {
        if (latest === undefined) return;
        label.textContent = `v${latest}`;
        status.textContent = newer(latest, version) ? `Newer on ${registry}` : `Live on ${registry}`;
      })
      .catch(() => {
        status.textContent = "";
      });
  }
};
