export interface Face {
  readonly family: string;
  readonly weight: number;
}

/** The faces that the first view of each route draws. */
export const routeFaces: Readonly<Record<"home" | "docs", readonly Face[]>> = {
  home: [
    { family: "Monaspace Xenon", weight: 400 },
    { family: "Monaspace Xenon", weight: 700 },
    { family: "Monaspace Radon", weight: 500 },
    { family: "Monaspace Argon", weight: 400 },
    { family: "Monaspace Krypton", weight: 400 },
    { family: "Monaspace Krypton", weight: 500 },
    { family: "Monaspace Neon", weight: 400 },
  ],
  docs: [
    { family: "Monaspace Xenon", weight: 400 },
    { family: "Monaspace Xenon", weight: 700 },
    { family: "Monaspace Argon", weight: 400 },
    { family: "Monaspace Argon", weight: 500 },
    { family: "Monaspace Krypton", weight: 400 },
    { family: "Monaspace Krypton", weight: 500 },
    { family: "Monaspace Neon", weight: 400 },
    { family: "Monaspace Neon", weight: 500 },
  ],
};

/** The face in the syntax of the `font` property, as `document.fonts.load` takes it. */
export const cssFont = (face: Face): string => `${face.weight} 1em "${face.family}"`;
