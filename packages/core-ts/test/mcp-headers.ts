import { encodeMcpHeaderValue } from "@acid-cat/spec-ts";

export const mcpHeaders = (method: string, params: object): Record<string, string> => {
  const name = "name" in params ? params.name : undefined;
  return { "Mcp-Method": method, ...(typeof name === "string" ? { "Mcp-Name": encodeMcpHeaderValue(name) } : {}) };
};
