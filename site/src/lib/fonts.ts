import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HeadConfig } from "vitepress";
import subsetFont from "subset-font";

type CodeRange = readonly [number, number];

export interface Face {
  readonly family: string;
  readonly weight: number;
}

export const faces: readonly Face[] = [
  { family: "Monaspace Xenon", weight: 400 },
  { family: "Monaspace Xenon", weight: 700 },
  { family: "Monaspace Radon", weight: 400 },
  { family: "Monaspace Radon", weight: 500 },
  { family: "Monaspace Argon", weight: 400 },
  { family: "Monaspace Argon", weight: 500 },
  { family: "Monaspace Krypton", weight: 400 },
  { family: "Monaspace Krypton", weight: 500 },
  { family: "Monaspace Neon", weight: 400 },
  { family: "Monaspace Neon", weight: 500 },
];

export const coreRanges: readonly CodeRange[] = [
  [0x0000, 0x007f],
  [0x00a0, 0x00a0],
  [0x00b0, 0x00b0],
  [0x00b7, 0x00b7],
  [0x00d7, 0x00d7],
  [0x00fc, 0x00fc],
  [0x2013, 0x2014],
  [0x2018, 0x2019],
  [0x201c, 0x201d],
  [0x2022, 0x2022],
  [0x2026, 0x2026],
  [0x2190, 0x2199],
  [0x2318, 0x2318],
  [0x25e6, 0x25e6],
];

const lastCodePoint = 0x10ffff;

export const complement = (ranges: readonly CodeRange[]): CodeRange[] => {
  const gaps: CodeRange[] = [];
  let next = 0;
  for (const [first, last] of ranges) {
    if (first > next) gaps.push([next, first - 1]);
    next = last + 1;
  }
  if (next <= lastCodePoint) gaps.push([next, lastCodePoint]);
  return gaps;
};

const hex = (codePoint: number) => codePoint.toString(16).toUpperCase().padStart(4, "0");

export const unicodeRange = (ranges: readonly CodeRange[]): string =>
  ranges.map(([first, last]) => (first === last ? `U+${hex(first)}` : `U+${hex(first)}-${hex(last)}`)).join(", ");

const printable = (codePoint: number) => codePoint >= 0x20 && codePoint !== 0x7f;

export const coreText = (): string =>
  coreRanges
    .flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, index) => first + index))
    .filter(printable)
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join("");

const slug = (face: Face) => face.family.toLowerCase().replaceAll(" ", "-");

export const fontFile = (face: Face, part: "core" | "rest") => `${slug(face)}-${face.weight}-${part}.woff2`;

const fontFace = (face: Face, part: "core" | "rest", ranges: readonly CodeRange[]) => `@font-face {
  font-family: "${face.family}";
  font-style: normal;
  font-display: swap;
  font-weight: ${face.weight};
  src: url("./${fontFile(face, part)}") format("woff2");
  unicode-range: ${unicodeRange(ranges)};
}
`;

export const fontFaceCss = (): string =>
  faces.map((face) => fontFace(face, "core", coreRanges) + fontFace(face, "rest", complement(coreRanges))).join("");

const source = (face: Face) => fileURLToPath(import.meta.resolve(`@fontsource/${slug(face)}/files/${slug(face)}-latin-${face.weight}-normal.woff2`));

export const writeFonts = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
  const text = coreText();
  await Promise.all(
    faces.map(async (face) => {
      const core = await subsetFont(await readFile(source(face)), text, { targetFormat: "woff2" });
      await writeFile(join(directory, fontFile(face, "core")), core);
      await copyFile(source(face), join(directory, fontFile(face, "rest")));
    }),
  );
  await writeFile(join(directory, "fonts.css"), fontFaceCss());
};

const preloaded: Readonly<Record<"home" | "docs", readonly Face[]>> = {
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

/** A preload link for the core file of each face that the first view of the page draws, so that the browser lays out the text once. */
export const fontPreloads = (page: "home" | "docs", assets: readonly string[]): HeadConfig[] =>
  preloaded[page].map((face) => {
    const stem = fontFile(face, "core").replace(/\.woff2$/, "");
    const href = assets.find((asset) => asset.split("/").pop()?.startsWith(`${stem}.`) === true && asset.endsWith(".woff2"));
    if (href === undefined) throw new Error(`The build has no file for ${stem}.woff2.`);
    return ["link", { rel: "preload", as: "font", type: "font/woff2", href, crossorigin: "" }];
  });
