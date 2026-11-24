import { cores as registry, githubBlob, ownCore } from "./ecosystem.ts";
import { catalogSlot, coreSlot, surfaceSlot } from "./home-slots.ts";
import { catalogSnippets, coreSnippets } from "./snippets.ts";
import { surfaces } from "./surfaces.ts";

export interface CodePanel {
  readonly slot: string;
  readonly code: string;
  readonly language: string;
}

export interface CatalogPanel {
  readonly id: string;
  readonly label: string;
  readonly file: string;
}

export interface CorePanel {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly packageName: string;
  readonly source: string;
}

export interface SurfacePanel {
  readonly id: string;
  readonly name: string;
  readonly who: string;
  readonly text: string;
  readonly spec: string;
}

export interface HomeCode {
  readonly catalog: readonly CatalogPanel[];
  readonly cores: readonly CorePanel[];
  readonly surfaces: readonly SurfacePanel[];
  /** The code of each panel, by the name of the panel. */
  readonly code: readonly CodePanel[];
}

/** The code of the homepage, read from the examples and the READMEs of the cores. */
export const readHomeCode = async (): Promise<HomeCode> => {
  const catalog = await catalogSnippets();
  const snippets = await coreSnippets();
  const official = registry.map((core) => {
    const snippet = snippets.find((candidate) => candidate.id === core.id);
    if (snippet === undefined) throw new Error(`No README example for "${core.id}".`);
    return { panel: { id: core.id, label: core.label, note: core.note, packageName: core.packageName, source: `${githubBlob}/${snippet.source}` }, code: snippet.code, language: snippet.language };
  });
  const yours = {
    panel: { id: ownCore.id, label: ownCore.label, note: ownCore.note, packageName: "acid-cat conform", source: `${githubBlob}/${ownCore.source}` },
    code: [...ownCore.steps.map((step, index) => `# ${index + 1}. ${step}`), ownCore.conform].join("\n"),
    language: "shellscript",
  };
  const cores = [...official, yours];
  return {
    catalog: catalog.map((snippet) => ({ id: snippet.id, label: snippet.label, file: snippet.source.split("/").pop() ?? snippet.source })),
    cores: cores.map(({ panel }) => panel),
    surfaces: surfaces.map(({ id, name, who, text, spec }) => ({ id, name, who, text, spec })),
    code: [
      ...catalog.map((snippet) => ({ slot: catalogSlot(snippet.id), code: snippet.code, language: snippet.language })),
      ...cores.map(({ panel, code, language }) => ({ slot: coreSlot(panel.id), code, language })),
      ...surfaces.map((surface) => ({ slot: surfaceSlot(surface.id), code: surface.code, language: surface.language })),
    ],
  };
};
