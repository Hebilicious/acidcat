export interface Face {
  readonly family: string;
  readonly weight: number;
}

export interface RouteFace extends Face {
  /** The media query of the windows whose first view draws the face. */
  readonly media?: string;
}

const wide = "(min-width: 768px)";

/**
 * The faces that the first view of each route draws, at a phone width and at a desktop width. A face with `media` is
 * only in the first view of a window that matches it. The faces of the rest of a page load when its text is laid out.
 */
export const routeFaces: Readonly<Record<"home" | "docs", readonly RouteFace[]>> = {
  home: [
    { family: "Monaspace Xenon", weight: 400 },
    { family: "Monaspace Argon", weight: 400 },
    { family: "Monaspace Krypton", weight: 400 },
    { family: "Monaspace Krypton", weight: 500 },
    { family: "Monaspace Xenon", weight: 700 },
  ],
  docs: [
    { family: "Monaspace Xenon", weight: 700 },
    { family: "Monaspace Argon", weight: 400 },
    { family: "Monaspace Argon", weight: 500 },
    { family: "Monaspace Neon", weight: 400 },
    { family: "Monaspace Krypton", weight: 400 },
    { family: "Monaspace Krypton", weight: 500, media: wide },
  ],
};

/** The face in the syntax of the `font` property, as `document.fonts.load` takes it. */
export const cssFont = (face: Face): string => `${face.weight} 1em "${face.family}"`;
