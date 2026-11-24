import { siteUrl } from "../src/lib/social.ts";
import { MCP_PATH } from "../worker/discovery.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const ADVERTISING_DOCUMENTS = ["/llms.txt", "/.well-known/agent-skills/index.json", "/.well-known/api-catalog", "/.well-known/ai-catalog.json", "/.well-known/mcp/server-card.json"];

const expectedTypes: readonly { readonly suffix: string; readonly type: string }[] = [
  { suffix: ".md", type: "text/markdown" },
  { suffix: ".txt", type: "text/plain" },
  { suffix: ".tar.gz", type: "application/gzip" },
];

const stringsOf = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsOf);
  return [];
};

export const advertisedPaths = (document: string, contentType: string, origin: string): string[] => {
  const candidates = contentType.includes("json") ? stringsOf(JSON.parse(document)) : (document.match(/https?:\/\/[^\s)<>"]+/g) ?? []).map((url) => url.replace(/[.,;:]+$/, ""));
  const paths = candidates.flatMap((candidate) => {
    if (candidate.startsWith("/") && !candidate.startsWith("//")) return [candidate];
    if (!/^https?:\/\//.test(candidate)) return [];
    const url = new URL(candidate);
    return url.origin === siteUrl || url.origin === origin ? [`${url.pathname}${url.search}`] : [];
  });
  return [...new Set(paths)];
};

export const linkTargets = (header: string): string[] => [...header.matchAll(/<([^>]+)>/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

export interface Advertised {
  readonly path: string;
  readonly listedBy: string;
}

export const collectAdvertised = async (origin: string, fetcher: Fetch): Promise<Advertised[]> => {
  const found = new Map<string, string>();
  for (const document of ADVERTISING_DOCUMENTS) {
    const response = await fetcher(`${origin}${document}`);
    if (!response.ok) throw new Error(`${document} answers ${response.status}.`);
    for (const path of advertisedPaths(await response.text(), response.headers.get("Content-Type") ?? "", origin)) if (!found.has(path)) found.set(path, document);
  }
  const home = await fetcher(`${origin}/`, { headers: { Accept: "text/html" } });
  for (const path of linkTargets(home.headers.get("Link") ?? "")) if (!found.has(path)) found.set(path, "Link header of /");
  return [...found].map(([path, listedBy]) => ({ path, listedBy }));
};

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acid-cat-site-check", version: "0.0.0" } } });

export interface Checked extends Advertised {
  readonly status: number;
  readonly contentType: string;
  readonly problem: string | undefined;
}

/** Fetch a path as an agent does: GET, or an MCP `initialize` request for the MCP endpoint, which answers only POST. */
export const checkPath = async (origin: string, advertised: Advertised, fetcher: Fetch): Promise<Checked> => {
  const pathname = new URL(advertised.path, origin).pathname;
  const response =
    pathname === MCP_PATH
      ? await fetcher(`${origin}${advertised.path}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: initialize })
      : await fetcher(`${origin}${advertised.path}`);
  await response.body?.cancel();
  const contentType = response.headers.get("Content-Type") ?? "";
  const expected = expectedTypes.find(({ suffix }) => pathname.endsWith(suffix))?.type;
  const problem = response.status !== 200 ? `status ${response.status}` : expected !== undefined && !contentType.startsWith(expected) ? `type ${contentType}, not ${expected}` : undefined;
  return { ...advertised, status: response.status, contentType, problem };
};

export const checkAdvertised = async (origin: string, fetcher: Fetch): Promise<Checked[]> =>
  Promise.all((await collectAdvertised(origin, fetcher)).map((advertised) => checkPath(origin, advertised, fetcher)));
