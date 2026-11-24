# AcidCat

> Describe what your application can do once. Serve it as a CLI, an MCP server, an HTTP API and typed client code.

AcidCat (Application Capability Identification Catalog) is an open specification, at version 0.1 draft. An application describes what it can do in one JSON document, the **catalog**. AcidCat serves the catalog through many **surfaces**:

- a command line;
- an MCP server, for agents;
- WebMCP tools in a web page;
- an HTTP API;
- typed calls from code.

A **core** runs the capabilities and serves the surfaces. The official cores are in TypeScript (`@acid-cat/core-ts`), in Effect (`@acid-cat/core-effect`) and in Rust (`acid-cat-core`). A catalog library writes the catalog in TypeScript, Python, Go, Rust or Pkl. `acid-cat check` checks a catalog, and `acid-cat conform` tests a core from outside.

## Read more

- [Documentation](/docs/): the concepts, the guides and the reference.
- [Quick start](/docs/quick-start/): install AcidCat, write a catalog and serve it.
- [Specification](/spec/): the catalog, invocation, events, the surfaces and conformance.
- [Packages](/packages/): every package that AcidCat publishes.
- [Source](https://github.com/Hebilicious/acidcat): the repository on GitHub.

## For agents

This site serves its own content through AcidCat:

- MCP server: `/mcp` (Server Card at `/mcp/server-card`).
- HTTP API: `/api/capabilities`, and the catalog at `/api/catalog`.
- WebMCP tools in each page, in a browser that supports WebMCP.
- Each page as Markdown: send `Accept: text/markdown`, or add `index.md` to the path of the page.
- An index at `/llms.txt`, and the full text at `/llms-full.txt`.
- The agent skill `acid-cat` at `/.well-known/agent-skills/index.json`.
