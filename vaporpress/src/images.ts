import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import type { Plugin } from "vite";

/** The attributes of an `<img>` element for an image of the site, from an import with `?image`. */
export interface Image {
  readonly src: string;
  readonly srcset: string;
  readonly sizes: string;
  readonly width: number;
  readonly height: number;
}

export interface ImageOptions {
  /** The widths, in pixels, of the WebP files of each image. Only the widths below the width of the image are written, and the image at its own width. */
  readonly widths?: readonly number[];
  /** The quality of the WebP files, from 1 to 100. */
  readonly quality?: number;
}

export const imageQuery = "?image";
const defaultWidths = [480, 800, 1200, 1600, 2400];
const defaultQuality = 80;

/** The files that the image service converts. Other images, such as SVG and GIF, keep their file. */
export const isConvertibleImage = (path: string): boolean => /\.(png|jpe?g|webp|avif|tiff?)$/i.test(path);

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** The widths of the files of an image that is `width` pixels wide. */
export const imageWidths = (width: number, widths: readonly number[] = defaultWidths): number[] => [...new Set([...widths.filter((candidate) => candidate < width), width])].sort((a, b) => a - b);

/**
 * Serves each import that ends with `?image` as the attributes of an `<img>` element: WebP files at several widths in
 * `srcset`, and the `width` and `height` of the image, so that the page keeps its place before the image loads.
 *
 * The files go to `node_modules/.vaporpress/images/` under a name from their content and the options, and Vite
 * imports each one with `?no-inline`, so the build gives them the names of its other assets.
 */
export const imagePlugin = (root: string, options: ImageOptions = {}): Plugin => {
  const directory = join(root, "node_modules/.vaporpress/images");
  const quality = options.quality ?? defaultQuality;
  return {
    name: "vaporpress:images",
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(imageQuery)) return undefined;
      const file = id.slice(0, -imageQuery.length);
      if (!isConvertibleImage(file)) throw new Error(`${file}: an import with ${imageQuery} takes a PNG, JPEG, WebP, AVIF or TIFF file.`);
      this.addWatchFile(file);
      const source = await readFile(file);
      const { width, height } = (await sharp(source).metadata()).autoOrient;
      const widths = imageWidths(width, options.widths);
      const hash = createHash("sha256").update(source).update(JSON.stringify({ widths, quality })).digest("base64url").slice(0, 10);
      const stem = basename(file, extname(file));
      await mkdir(directory, { recursive: true });
      const files = await Promise.all(
        widths.map(async (target) => {
          const path = join(directory, `${stem}-${target}.${hash}.webp`);
          if (!(await exists(path))) await sharp(source).autoOrient().resize({ width: target }).webp({ quality }).toFile(path);
          return { target, path };
        }),
      );
      const imports = files.map(({ path }, index) => `import file${index} from ${JSON.stringify(`${path}?no-inline`)};`);
      const srcset = files.map(({ target }, index) => `\${file${index}} ${target}w`).join(", ");
      return [
        ...imports,
        `export default { src: file${files.length - 1}, srcset: \`${srcset}\`, sizes: ${JSON.stringify(`(min-width: ${width}px) ${width}px, 100vw`)}, width: ${width}, height: ${height} };`,
      ].join("\n");
    },
  };
};
