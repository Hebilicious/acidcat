import { build } from "esbuild";

/**
 * Bundles a module and its imports into one inline `<script>` element, for the head of a page. The script runs while
 * the HTML parses, before any module script, so a control that it starts answers before the app hydrates. Give it to
 * `headHtml`, or add it to some pages with `transformHtml`.
 */
export const inlineScript = async (file: string): Promise<string> => {
  const result = await build({ entryPoints: [file], bundle: true, minify: true, format: "iife", target: "es2022", write: false });
  const code = result.outputFiles[0]?.text.trim();
  if (code === undefined) throw new Error(`esbuild wrote no code for ${file}.`);
  return `<script>${code}</script>`;
};
