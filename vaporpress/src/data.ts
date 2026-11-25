import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";

/**
 * A module of data that the build reads once. Its file name ends with `.data.ts`, its default export is the loader,
 * and it declares the type of the data that it gives: `export declare const data: LoadedData<typeof loader>`.
 */
export interface DataLoader<Data> {
  /** Reads the data at build time. The result must be JSON. */
  readonly load: () => Data | Promise<Data>;
  /** The files that the data comes from, as absolute paths, so the dev server reads the data again when one changes. */
  readonly watch?: readonly string[];
}

/** The data that a loader gives, for the type of the module that imports it. */
export type LoadedData<Loader> = Loader extends DataLoader<infer Data> ? Awaited<Data> : never;

export const defineLoader = <Data>(loader: DataLoader<Data>): DataLoader<Data> => loader;

const isLoader = (value: unknown): value is DataLoader<unknown> =>
  typeof value === "object" && value !== null && "load" in value && typeof value.load === "function";

/** Replaces each `.data.ts` module with `export const data`, the JSON that its loader gives at build time. The browser gets the data, not the loader. */
export const dataPlugin = (): Plugin => ({
  name: "vaporpress:data",
  enforce: "pre",
  async load(id) {
    if (!id.endsWith(".data.ts")) return undefined;
    const module: unknown = await import(`${pathToFileURL(id).href}?t=${Date.now()}`);
    const loader: unknown = typeof module === "object" && module !== null && "default" in module ? module.default : undefined;
    if (!isLoader(loader)) throw new Error(`${id} must export a loader from defineLoader as its default export.`);
    this.addWatchFile(id);
    for (const file of loader.watch ?? []) this.addWatchFile(file);
    return `export const data = ${JSON.stringify(await loader.load())};`;
  },
});
