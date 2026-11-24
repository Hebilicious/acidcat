/** The five surfaces of Fig. 3 on the homepage: who uses each one, what it does, and an example. */
export interface Surface {
  readonly id: string;
  readonly name: string;
  readonly who: string;
  readonly text: string;
  readonly language: string;
  readonly code: string;
  readonly spec: string;
}

export const surfaces: readonly Surface[] = [
  {
    id: "cli",
    name: "Command line",
    who: "People and scripts",
    text: "The words of the id become the command, and each input property becomes a flag. The catalog can give short aliases. In a pipe, the program writes each result as one line of JSON.",
    language: "shellscript",
    code: "$ home aircon power set --on\n$ home --on\n$ home list",
    spec: "spec/surfaces/cli.md",
  },
  {
    id: "mcp",
    name: "MCP server",
    who: "AI agents",
    text: "tools/list gives one tool for each available capability. The name of the tool is the id. destructive and idempotent become hints, so an agent knows when to ask first.",
    language: "json",
    code: '{\n  "name": "aircon.power.set",\n  "description": "Turn the unit on or off.",\n  "annotations": { "destructiveHint": true, "idempotentHint": true }\n}',
    spec: "spec/surfaces/mcp.md",
  },
  {
    id: "webmcp",
    name: "WebMCP",
    who: "Agents in the browser",
    text: "The page registers a tool for each available capability with registerTool. A browser agent calls it with the session of the signed-in user.",
    language: "json",
    code: '{\n  "name": "aircon.power.set",\n  "inputSchema": {\n    "type": "object",\n    "properties": { "on": { "type": "boolean" } },\n    "required": ["on"]\n  }\n}',
    spec: "spec/surfaces/webmcp.md",
  },
  {
    id: "http",
    name: "HTTP API",
    who: "Other programs",
    text: "A POST to /capabilities/{id} with the input as the body gives the outcome. A POST to /events/{id} streams the occurrences as server-sent events.",
    language: "http",
    code: 'POST /capabilities/aircon.power.set\nContent-Type: application/json\n\n{ "on": true }',
    spec: "spec/surfaces/http.md",
  },
  {
    id: "ts",
    name: "Programmatic access",
    who: "Your own code",
    text: "A session gives a handle for each capability. execute returns a result: the value, or a failure with its tag. An AbortSignal cancels the call.",
    language: "typescript",
    code: 'const result = await handle.execute({ on: true });\nif (!result.ok && result.error._tag === "Offline") {\n  showOffline();\n}',
    spec: "spec/surfaces/programmatic.md",
  },
];
