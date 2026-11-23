const terminals = [
  {
    name: "provider",
    lines: ["runs the operations"],
    glyph: '<path d="m-4 -16 8 0 1 4 4 2 4 -1 4 6 -3 3v4l3 3 -4 6 -4 -1 -4 2 -1 4h-8l-1 -4 -4 -2 -4 1 -4 -6 3 -3v-4l-3 -3 4 -6 4 1 4 -2Z"/><circle r="7"/><circle r="3"/>',
  },
  {
    name: "bindings",
    lines: ["rules for each surface"],
    glyph: '<g transform="rotate(-32)"><rect x="-18" y="-8" width="36" height="16" rx="1"/><path d="M-12 -8v8m6 -8v5m6 -5v8m6 -8v5m6 -5v8"/></g>',
  },
  {
    name: "clients",
    lines: ["web, mobile, desktop,", "CLI, MCP, API, …"],
    glyph: '<path d="M10 -2v-11h-27v20H0m-7 0v5m-8 1H0m-17 -11H0"/><rect x="4" y="-5" width="12" height="22" rx="2"/><path d="M8 13h4"/>',
  },
];

const diagramStyle = `<style>
  .catalog-flow { margin-inline: 0; container-type: inline-size; }
  .catalog-flow .cf-sheet { width: 100%; height: auto; display: block; margin: 0; background: var(--palette-blueprint-900); }
  .catalog-flow .cf-narrow { display: none; }
  @container (max-width: 34rem) {
    .catalog-flow .cf-wide { display: none; }
    .catalog-flow .cf-narrow { display: block; }
  }
  .cf-grid { fill: none; stroke: color-mix(in oklch, var(--palette-cyan-400) 12%, transparent); }
  .cf-frame, .cf-wire { fill: none; stroke: color-mix(in oklch, var(--palette-cyan-400) 55%, transparent); }
  .cf-wire { stroke-width: 5; }
  .cf-bore { fill: none; stroke: var(--palette-blueprint-900); stroke-width: 3; }
  .cf-current { fill: none; stroke: var(--palette-acid-400); stroke-width: 2; stroke-linecap: round; stroke-dasharray: 6 94; filter: drop-shadow(0 0 2px var(--palette-acid-600)); animation: cf-flow 4s linear infinite; }
  @keyframes cf-flow { to { stroke-dashoffset: -100; } }
  @media (prefers-reduced-motion: reduce) { .cf-current { animation: none; stroke-dashoffset: -52; } }
  .cf-case { fill: var(--palette-brass-950); stroke: var(--palette-brass-400); }
  .cf-plate { fill: var(--palette-blueprint-800); stroke: var(--palette-brass-300); }
  .cf-port { fill: var(--palette-ink-900); stroke: var(--palette-cyan-400); }
  .cf-pin { fill: var(--palette-acid-400); }
  .cf-tool { fill: none; stroke: var(--palette-cream-100); stroke-width: 1.4; stroke-linejoin: round; }
  .cf-gold { stroke: var(--palette-brass-300); }
  .cf-name { font: bold 19px var(--font-family-display); fill: var(--palette-cream-100); }
  .cf-note { font: 13px var(--font-family-mono); fill: var(--palette-cream-400); }
  .catalog-flow .cf-caption { margin: 0; padding: .55em 1em; background: var(--palette-blueprint-800); border-top: 1px solid var(--palette-copper-700); color: var(--palette-cream-400); font: small var(--font-family-label); }
</style>`;

function diagram(narrow: boolean): string {
  const layout = narrow ? "narrow" : "wide";
  const width = narrow ? 344 : 720;
  const height = narrow ? 374 : 306;
  const center = width / 2;
  const grid = `cf-grid-${layout}`;
  const branches = terminals.map(({ name, glyph, lines }, index) => {
    const x = narrow ? 75 : 120 + index * 240;
    const y = narrow ? 151 + index * 84 : 195;
    const path = narrow
      ? `M40 97V${y - 7}l7 7h6`
      : `M${center} 97V124L${center + (index - 1) * 8} 132H${x - (index - 1) * 8}L${x} 140V173`;
    const labelX = narrow ? 35 : 0;
    const labelY = narrow ? -2 : 53;
    return `<path class="cf-wire" d="${path}"/><path class="cf-bore" d="${path}"/><path class="cf-current" d="${path}" pathLength="100"/>
      <g transform="translate(${x} ${y})">
        <circle class="cf-port" r="24"/><circle class="cf-frame" r="20"/>
        <g class="cf-tool" transform="scale(.86)">${glyph}</g>
        <g text-anchor="${narrow ? "start" : "middle"}" transform="translate(${labelX} ${labelY})">
          <text class="cf-name">${name}</text>
          <text class="cf-note">${lines.map((line, i) => `<tspan x="0" y="${21 + 17 * i}">${line}</tspan>`).join(" ")}</text>
        </g>
      </g>`;
  });
  const half = narrow ? 157 : 222;
  const note = narrow
    ? '<tspan x="0">what the application can do,</tspan> <tspan x="0" dy="17">and for whom</tspan>'
    : "what the application can do, and for whom";
  return `<svg xmlns="http://www.w3.org/2000/svg" class="cf-sheet cf-${layout}" viewBox="0 0 ${width} ${height}" role="img" aria-label="The catalog (JSON): what the application can do, and for whom. The provider runs the operations. The bindings give rules for each surface. Clients include web, mobile, desktop, CLI, MCP, API.">
    
    
    ${narrow ? "" : diagramStyle}
    <defs><pattern id="${grid}" width="16" height="16" patternUnits="userSpaceOnUse"><path class="cf-grid" d="M16 0H0V16"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#${grid})"/>
    <rect class="cf-frame" x="7" y="7" width="${width - 14}" height="${height - 14}"/>
    ${branches.join("")}
    <g transform="translate(${center} 18)">
      <path class="cf-case" d="M${-half} 10l9 -9h${2 * half - 18}l9 9v63l-9 9H${9 - half}l-9 -9Z"/>
      <rect class="cf-plate" x="${5 - half}" y="6" width="${2 * half - 10}" height="70" rx="3"/>
      <g class="cf-tool cf-gold" transform="translate(-94 25)">
        <path d="m-17 -3 17 -7 17 7 -17 7Zm0 5 17 7 17 -7m-34 5 17 7 17 -7"/>
      </g>
      <text class="cf-name" x="17" y="32" text-anchor="middle">catalog (JSON)</text>
      <text class="cf-note" y="${narrow ? 51 : 59}" text-anchor="middle">${note}</text>
      <circle class="cf-pin" cx="${narrow ? 40 - center : 0}" cy="81" r="3"/>
    </g>
  </svg>`;
}

export const catalogFlowSvg = `<figure class="catalog-flow">${diagram(false)}${diagram(true)}<figcaption class="cf-caption">The catalog, the provider, the bindings and the clients.</figcaption></figure>`;

const asciiCatalogFlow = /```\n\s*catalog \(JSON\)[\s\S]*?```/;

export const replaceDiagrams = (markdown: string): string => markdown.replace(asciiCatalogFlow, () => catalogFlowSvg.replace(/\n\s*/g, " "));
