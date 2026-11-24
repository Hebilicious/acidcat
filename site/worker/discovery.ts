export const MCP_PATH = "/mcp";
export const API_BASE = "/api";
const SERVER_CARD_PATH = `${MCP_PATH}/server-card`;
const SKILLS_INDEX_PATH = "/.well-known/agent-skills/index.json";

export const linkHeader = (path: string): string =>
  [
    `</.well-known/api-catalog>; rel="api-catalog"`,
    `<${API_BASE}/catalog>; rel="service-desc"; type="application/json"`,
    `<${SERVER_CARD_PATH}>; rel="service-desc"; type="application/mcp-server-card+json"`,
    `</docs/>; rel="service-doc"; type="text/html"`,
    `</llms.txt>; rel="describedby"; type="text/plain"`,
    `<${SKILLS_INDEX_PATH}>; rel="describedby"; type="application/json"`,
    `</sitemap-index.xml>; rel="sitemap"; type="application/xml"`,
    `<${markdownPath(path)}>; rel="alternate"; type="text/markdown"`,
  ].join(", ");

export const markdownPath = (path: string): string => `${path.endsWith("/") ? path : `${path}/`}index.md`;

export const isPagePath = (path: string): boolean => !/\.[a-z0-9]+$/i.test(path) && !path.startsWith("/.well-known/");

const weightsOf = (accept: string): Map<string, number> => {
  const weights = new Map<string, number>();
  for (const part of accept.toLowerCase().split(",")) {
    const [range = "", ...parameters] = part.split(";").map((piece) => piece.trim());
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    const weight = quality === undefined ? 1 : Number(quality.slice(2));
    weights.set(range, Number.isFinite(weight) ? weight : 0);
  }
  return weights;
};

export const prefersMarkdown = (accept: string | null): boolean => {
  if (accept === null) return false;
  const weights = weightsOf(accept);
  const markdown = weights.get("text/markdown") ?? 0;
  return markdown > 0 && markdown >= (weights.get("text/html") ?? 0);
};

/** The API Catalog of RFC 9727. */
export const apiCatalog = (origin: string): object => ({
  linkset: [
    {
      anchor: `${origin}${API_BASE}`,
      "service-desc": [{ href: `${origin}${API_BASE}/catalog`, type: "application/json" }],
      "service-doc": [{ href: `${origin}/spec/bindings/http/`, type: "text/html" }],
    },
    {
      anchor: `${origin}${MCP_PATH}`,
      "service-desc": [{ href: `${origin}${SERVER_CARD_PATH}`, type: "application/mcp-server-card+json" }],
      "service-doc": [{ href: `${origin}/spec/bindings/mcp/`, type: "text/html" }],
    },
  ],
});

/** The AI Catalog of Agentic Resource Discovery. */
export const aiCatalog = (origin: string): object => {
  const host = new URL(origin).hostname;
  return {
    specVersion: "1.0",
    host: { displayName: "AcidCat", identifier: `did:web:${host}` },
    entries: [
      {
        identifier: `urn:air:${host}:server:acidcat-site`,
        displayName: "AcidCat site",
        description: "Read the documentation, the specification and the packages of AcidCat.",
        type: "application/mcp-server-card+json",
        url: `${origin}${SERVER_CARD_PATH}`,
        representativeQueries: ["What is an AcidCat catalog?", "How do I serve a capability over MCP with AcidCat?", "Which AcidCat packages exist?"],
      },
      {
        identifier: `urn:air:${host}:skill:acid-cat`,
        displayName: "acid-cat agent skill",
        description: "Tells a coding agent how to build an application with AcidCat.",
        type: "application/agent-skills+gzip",
        url: `${origin}/.well-known/agent-skills/acid-cat.tar.gz`,
        representativeQueries: ["Add a capability to an AcidCat catalog", "Expose my application to agents through MCP and WebMCP"],
      },
    ],
  };
};
