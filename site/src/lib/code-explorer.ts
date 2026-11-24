const hashPrefix = "#file=";

const narrow = (): boolean => matchMedia("(max-width: 50rem)").matches;

const isFragment = (value: unknown): value is { html: string } =>
  typeof value === "object" && value !== null && "html" in value && typeof value.html === "string";

export const fileFromHash = (hash: string): string | undefined => (hash.startsWith(hashPrefix) ? decodeURIComponent(hash.slice(hashPrefix.length)) : undefined);

const items = (tree: HTMLElement): HTMLElement[] => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];

const isVisible = (item: HTMLElement, tree: HTMLElement): boolean => {
  for (let parent = item.parentElement?.closest<HTMLElement>('[role="treeitem"]'); parent !== null && parent !== undefined && tree.contains(parent); parent = parent.parentElement?.closest<HTMLElement>('[role="treeitem"]')) {
    if (parent.getAttribute("aria-expanded") !== "true") return false;
  }
  return true;
};

const parentItem = (item: HTMLElement): HTMLElement | null => item.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? null;

const isFolder = (item: HTMLElement): boolean => item.hasAttribute("aria-expanded");

export const initExplorer = (root: HTMLElement, signal: AbortSignal): void => {
  const tree = root.querySelector<HTMLElement>("[data-tree]");
  const source = root.querySelector<HTMLElement>("[data-source]");
  const path = root.querySelector<HTMLElement>("[data-current-path]");
  const github = root.querySelector<HTMLAnchorElement>("[data-github-link]");
  const treeToggle = root.querySelector<HTMLButtonElement>("[data-tree-toggle]");
  const fullscreen = root.querySelector<HTMLButtonElement>("[data-fullscreen]");
  if (tree === null || source === null || path === null || github === null || treeToggle === null || fullscreen === null) return;

  const fragments = root.dataset["fragments"] ?? "";
  const githubBase = root.dataset["github"] ?? "";
  const sourceBase = root.dataset["prefix"] ?? "";
  const cache = new Map<string, string>();
  let request = 0;

  const fileItem = (file: string): HTMLElement | undefined => items(tree).find((item) => item.dataset["file"] !== undefined && item.dataset["path"] === file);

  const setTabStop = (item: HTMLElement): void => {
    for (const other of items(tree)) other.tabIndex = -1;
    item.tabIndex = 0;
  };

  const focusItem = (item: HTMLElement): void => {
    setTabStop(item);
    item.focus();
  };

  const setTree = (open: boolean): void => {
    root.dataset["tree"] = open ? "open" : "closed";
    treeToggle.setAttribute("aria-expanded", String(open));
  };

  const load = async (file: string): Promise<string> => {
    const cached = cache.get(file);
    if (cached !== undefined) return cached;
    const response = await fetch(`${fragments}${file.split("/").map(encodeURIComponent).join("/")}.json`);
    if (!response.ok) throw new Error(`${file}: ${response.status}`);
    const body: unknown = await response.json();
    if (!isFragment(body)) throw new Error(`${file}: the fragment has no html.`);
    cache.set(file, body.html);
    return body.html;
  };

  const select = async (file: string, options: { readonly focus: boolean; readonly updateHash: boolean }): Promise<void> => {
    const item = fileItem(file);
    if (item === undefined) return;
    for (let parent = parentItem(item); parent !== null; parent = parentItem(parent)) parent.setAttribute("aria-expanded", "true");
    for (const other of items(tree)) if (other.dataset["file"] !== undefined) other.setAttribute("aria-selected", String(other === item));
    if (options.focus) focusItem(item);
    else setTabStop(item);
    if (options.updateHash) history.replaceState(history.state, "", `${hashPrefix}${file}`);
    if (root.dataset["current"] === file) return;
    root.dataset["current"] = file;
    path.textContent = `${sourceBase}${file}`;
    github.href = `${githubBase}${file}`;
    const current = ++request;
    source.setAttribute("aria-busy", "true");
    try {
      const html = await load(file);
      if (current !== request) return;
      source.innerHTML = html;
    } catch {
      if (current !== request) return;
      source.textContent = `Could not load ${file}. Open it on GitHub.`;
      root.dataset["current"] = "";
    } finally {
      if (current === request) source.setAttribute("aria-busy", "false");
    }
  };

  const activate = (item: HTMLElement): void => {
    if (isFolder(item)) {
      item.setAttribute("aria-expanded", String(item.getAttribute("aria-expanded") !== "true"));
      focusItem(item);
      return;
    }
    const file = item.dataset["path"];
    if (file === undefined) return;
    void select(file, { focus: true, updateHash: true });
    if (narrow()) {
      setTree(false);
      treeToggle.focus();
    }
  };

  tree.addEventListener("click", (event) => {
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="treeitem"]') : null;
    if (item !== null) activate(item);
  });

  tree.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && tree.contains(event.relatedTarget)) return;
    const selected = tree.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]');
    if (selected !== null && isVisible(selected, tree)) setTabStop(selected);
  });

  tree.addEventListener("keydown", (event) => {
    const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="treeitem"]') : null;
    if (item === null) return;
    const visible = items(tree).filter((candidate) => isVisible(candidate, tree));
    const index = visible.indexOf(item);
    const move = (target: HTMLElement | undefined | null): void => {
      if (target !== undefined && target !== null) focusItem(target);
    };
    switch (event.key) {
      case "ArrowDown":
        move(visible[index + 1]);
        break;
      case "ArrowUp":
        move(visible[index - 1]);
        break;
      case "Home":
        move(visible[0]);
        break;
      case "End":
        move(visible.at(-1));
        break;
      case "ArrowRight":
        if (!isFolder(item)) return;
        if (item.getAttribute("aria-expanded") === "true") move(item.querySelector<HTMLElement>('[role="treeitem"]'));
        else item.setAttribute("aria-expanded", "true");
        break;
      case "ArrowLeft":
        if (isFolder(item) && item.getAttribute("aria-expanded") === "true") item.setAttribute("aria-expanded", "false");
        else move(parentItem(item));
        break;
      case "Enter":
      case " ":
        activate(item);
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  treeToggle.addEventListener("click", () => {
    const open = root.dataset["tree"] === "closed" || (root.dataset["tree"] === "auto" && narrow());
    setTree(open);
    if (open && narrow()) tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
  });

  const expanded = (): boolean => document.fullscreenElement === root || root.hasAttribute("data-expanded");
  fullscreen.addEventListener("click", () => {
    if (document.fullscreenEnabled) {
      if (document.fullscreenElement === root) void document.exitFullscreen();
      else void root.requestFullscreen();
      return;
    }
    root.toggleAttribute("data-expanded");
    fullscreen.setAttribute("aria-pressed", String(expanded()));
  });
  document.addEventListener("fullscreenchange", () => fullscreen.setAttribute("aria-pressed", String(expanded())), { signal });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.hasAttribute("data-expanded")) {
      root.removeAttribute("data-expanded");
      fullscreen.setAttribute("aria-pressed", "false");
      fullscreen.focus();
    }
  });

  treeToggle.setAttribute("aria-expanded", String(!narrow()));
  root.dataset["current"] = root.dataset["open"] ?? "";

  const fromHash = (scroll: boolean): void => {
    const file = fileFromHash(location.hash);
    if (file === undefined || fileItem(file) === undefined) return;
    void select(file, { focus: false, updateHash: false });
    if (scroll) root.scrollIntoView({ block: "nearest" });
  };
  fromHash(false);
  addEventListener("hashchange", () => fromHash(true), { signal });
};
