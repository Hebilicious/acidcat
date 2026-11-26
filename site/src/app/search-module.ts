export const searchModuleMeta = "acidcat:search-module";

export const searchModuleHref = (): string | undefined => document.querySelector<HTMLMetaElement>(`meta[name="${searchModuleMeta}"]`)?.content;
