import { httpHandler, mcpHandler, mcpHandshake } from "@acid-cat/core-ts";
import { site, TARGET, toJsonSchema } from "../src/lib/agent/app.ts";
import { siteContext } from "../src/lib/agent/content.ts";
import type { SiteContext } from "../src/lib/agent/content.ts";
import sitePackage from "../package.json" with { type: "json" };
import { aiCatalog, API_BASE, apiCatalog, isPagePath, markdownPath, MCP_PATH, linkHeader, prefersMarkdown } from "./discovery.ts";

export interface Assets {
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface Env {
  readonly ASSETS: Assets;
}

type Handler = (request: Request) => Promise<Response>;

export interface SiteHandlers {
  readonly mcp: Handler;
  readonly http: Handler;
}

export const siteHandlers = (context: SiteContext): SiteHandlers => ({
  mcp: mcpHandshake(mcpHandler(site, { name: "acidcat-site", version: sitePackage.version, target: TARGET, allowedOrigins: [], toJsonSchema, context })),
  http: httpHandler(site, { target: TARGET, base: API_BASE, allowedOrigins: [], toJsonSchema, context }),
});

const json = (body: object, contentType: string): Response =>
  new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: { "Content-Type": contentType, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
  });

const withHeaders = (response: Response, headers: Record<string, string>): Response => {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
  return copy;
};

const page = async (request: Request, url: URL, assets: Assets): Promise<Response> => {
  if (prefersMarkdown(request.headers.get("Accept"))) {
    const markdown = await assets.fetch(new Request(new URL(markdownPath(url.pathname), url), { method: request.method }));
    if (markdown.ok) return withHeaders(markdown, { Vary: "Accept", Link: linkHeader(url.pathname), "Content-Type": "text/markdown; charset=utf-8" });
  }
  const html = await assets.fetch(request);
  return withHeaders(html, html.status === 200 ? { Vary: "Accept", Link: linkHeader(url.pathname) } : { Vary: "Accept" });
};

const isRead = (request: Request): boolean => request.method === "GET" || request.method === "HEAD";

export const handle = (handlers: () => SiteHandlers, assets: Assets) => {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === MCP_PATH || path.startsWith(`${MCP_PATH}/`)) return handlers().mcp(request);
    if (isRead(request) && (path === API_BASE || path === `${API_BASE}/`)) return Response.redirect(new URL(`${API_BASE}/capabilities`, url).href, 302);
    if (path.startsWith(`${API_BASE}/`)) return handlers().http(request);
    if (path === "/.well-known/mcp/server-card.json") return handlers().mcp(new Request(new URL(`${MCP_PATH}/server-card`, url), request));
    if (path === "/.well-known/api-catalog") return json(apiCatalog(url.origin), "application/linkset+json");
    if (path === "/.well-known/ai-catalog.json") return json(aiCatalog(url.origin), "application/ai-catalog+json");
    if (isRead(request) && isPagePath(path)) return page(request, url, assets);
    return assets.fetch(request);
  };
};

let served: ((request: Request) => Promise<Response>) | undefined;
let handlers: SiteHandlers | undefined;

export default {
  fetch: (request: Request, env: Env): Promise<Response> => {
    served ??= handle(() => (handlers ??= siteHandlers(siteContext((path) => env.ASSETS.fetch(new Request(new URL(path, request.url)))))), env.ASSETS);
    return served(request);
  },
};
