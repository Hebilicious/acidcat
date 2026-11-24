export interface Fence {
  readonly section: string;
  readonly language: string;
  readonly code: string;
}

export const fences = (markdown: string): Fence[] => {
  const found: Fence[] = [];
  let section = "";
  let open: { readonly language: string; readonly lines: string[] } | undefined;
  for (const line of markdown.split("\n")) {
    if (open !== undefined) {
      if (line.startsWith("```")) {
        found.push({ section, language: open.language, code: open.lines.join("\n") });
        open = undefined;
      } else open.lines.push(line);
      continue;
    }
    const start = /^```([^\s,]*)/.exec(line);
    if (start !== null) open = { language: start[1] ?? "", lines: [] };
    else section = /^#{1,6}\s+(.+)$/.exec(line)?.[1]?.trim() ?? section;
  }
  return found;
};

const commands = (code: string): string[][] =>
  code.split("\n").reduce<string[][]>((groups, line) => {
    const last = groups.at(-1);
    if (last?.at(-1)?.endsWith("\\") === true) last.push(line);
    else groups.push([line]);
    return groups;
  }, []);

export interface FenceQuery {
  readonly section: string;
  readonly language?: string | undefined;
  readonly match?: string | undefined;
}

export const pickFence = (markdown: string, query: FenceQuery, where: string): Fence => {
  const candidates = fences(markdown).filter((fence) => fence.section === query.section && (query.language === undefined || fence.language === query.language));
  const [first] = candidates;
  if (first === undefined) throw new Error(`${where} has no ${query.language ?? ""} code block under the heading "${query.section}".`);
  if (query.match === undefined) {
    if (candidates.length > 1) throw new Error(`${where} has ${candidates.length} code blocks under the heading "${query.section}". Give a language or a match.`);
    return first;
  }
  const { match } = query;
  const lines = candidates.flatMap((fence) => commands(fence.code)).filter((command) => command.some((line) => line.includes(match)));
  if (lines.length === 0) throw new Error(`${where} has no line with "${match}" under the heading "${query.section}".`);
  return { section: query.section, language: first.language, code: lines.flat().join("\n") };
};
