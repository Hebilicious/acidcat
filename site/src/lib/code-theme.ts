const color = {
  ink: "#05070b",
  inkPanel: "#0b0e14",
  cream: "#f2e6c9",
  creamDim: "#b9b09a",
  brass: "#ecc965",
  copper: "#e0a274",
  acid: "#b6ff3b",
  cyan: "#3be8ff",
  nixie: "#ff8a3d",
} as const;

export const codeTheme = {
  name: "acidcat",
  type: "dark",
  colors: {
    "editor.background": color.ink,
    "editor.foreground": color.cream,
    "editor.selectionBackground": "#2a2408",
    "terminal.background": color.ink,
    "terminal.foreground": color.cream,
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: color.creamDim, fontStyle: "italic" } },
    { scope: ["string", "string.quoted", "markup.inline.raw"], settings: { foreground: color.acid } },
    { scope: ["constant", "constant.numeric", "constant.language", "support.constant"], settings: { foreground: color.nixie } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control"], settings: { foreground: color.brass } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: color.cyan } },
    { scope: ["variable.parameter", "entity.name.type", "support.type", "entity.name.class"], settings: { foreground: color.copper } },
    { scope: ["support.type.property-name", "meta.object-literal.key", "variable.other.property"], settings: { foreground: color.cream } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: color.creamDim } },
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: color.brass, fontStyle: "bold" } },
  ],
};
