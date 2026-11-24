import { capabilitiesFor, defineApp, fail, ok } from "@acid-cat/core-ts";
import type { ToJsonSchema } from "@acid-cat/core-ts";
import * as z from "zod/mini";
import { normalizePath, Package, PageSummary, search, Section } from "./content.ts";
import type { SiteContext } from "./content.ts";

export const TARGET = "agents";

const capability = capabilitiesFor<SiteContext>();

const NotFound = z.object({ _tag: z.literal("NotFound"), path: z.string() });

export const pagesList = capability({
  id: "site.pages.list",
  description: "List the pages of the site, or the pages of one section.",
  audience: [TARGET],
  readOnly: true,
  idempotent: true,
  input: z.object({ section: z.optional(Section).check(z.describe("Only the pages of this section.")) }),
  output: z.object({ pages: z.array(PageSummary) }),
  run: async ({ section }, { context }) => {
    const { pages } = await context.content();
    return ok({ pages: pages.filter((page) => section === undefined || page.section === section).map(({ markdown: _markdown, ...summary }) => summary) });
  },
});

export const pageRead = capability({
  id: "site.pages.read",
  description: "Give the content of one page of the site as Markdown.",
  audience: [TARGET],
  readOnly: true,
  idempotent: true,
  input: z.object({ path: z.string().check(z.minLength(1), z.describe("The path or the URL of the page, for example /spec/catalog/.")) }),
  output: z.object({ path: z.string(), title: z.string(), markdown: z.string() }),
  failures: { NotFound },
  run: async ({ path }, { context }) => {
    const wanted = normalizePath(path);
    const page = (await context.content()).pages.find((candidate) => candidate.path === wanted);
    return page === undefined ? fail({ _tag: "NotFound", path: wanted }) : ok({ path: page.path, title: page.title, markdown: page.markdown });
  },
});

export const pagesSearch = capability({
  id: "site.pages.search",
  description: "Find the pages of the site that contain each word of a query.",
  audience: [TARGET],
  readOnly: true,
  idempotent: true,
  input: z.object({
    query: z.string().check(z.minLength(1), z.maxLength(200), z.describe("One or more words.")),
    limit: z.optional(z.int().check(z.gte(1), z.lte(20))).check(z.describe("The maximum number of results. The default is 5.")),
  }),
  output: z.object({ results: z.array(z.object({ path: z.string(), title: z.string(), excerpt: z.string() })) }),
  run: async ({ query, limit }, { context }) => ok({ results: search((await context.content()).pages, query, limit ?? 5) }),
});

export const packagesList = capability({
  id: "site.packages.list",
  description: "List the packages that AcidCat publishes, with their registry, their version and the command that installs them.",
  audience: [TARGET],
  readOnly: true,
  idempotent: true,
  output: z.object({ packages: z.array(Package) }),
  run: async (_input, { context }) => ok({ packages: (await context.content()).packages }),
});

export const site = defineApp<SiteContext>({
  title: "AcidCat site",
  description: "Read the documentation, the specification and the packages of AcidCat.",
  targets: {
    [TARGET]: { surfaces: ["http", "mcp", "webmcp"], description: "Agents that read the site: MCP clients, HTTP clients and WebMCP hosts in a browser." },
  },
  capabilities: [pagesList, pageRead, pagesSearch, packagesList],
});

export const toJsonSchema: ToJsonSchema = (schema) => {
  if (!(schema instanceof z.ZodMiniType)) throw new Error("The site has only Zod schemas.");
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
};
