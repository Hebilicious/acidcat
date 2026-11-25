import { build } from "esbuild";

export const inlineScript = async (file: string): Promise<string> => {
  const result = await build({ entryPoints: [file], bundle: true, minify: true, format: "iife", target: "es2022", write: false });
  const code = result.outputFiles[0]?.text.trim();
  if (code === undefined) throw new Error(`esbuild wrote no code for ${file}.`);
  return `<script>${code}</script>`;
};
