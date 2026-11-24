import type { APIRoute, GetStaticPaths } from "astro";
import { exampleFiles, exampleNames } from "../../lib/example-files.ts";
import { highlightExampleFile } from "../../lib/example-highlight.ts";

export const getStaticPaths: GetStaticPaths = () =>
  exampleNames().flatMap((example) => exampleFiles(example).map((file) => ({ params: { path: `${example}/${file}` }, props: { example, file } })));

export const GET: APIRoute = async ({ props }) => {
  const { example, file } = props;
  if (typeof example !== "string" || typeof file !== "string") throw new Error("An example file needs its example and its path.");
  return new Response(JSON.stringify({ html: await highlightExampleFile(example, file) }), { headers: { "content-type": "application/json" } });
};
