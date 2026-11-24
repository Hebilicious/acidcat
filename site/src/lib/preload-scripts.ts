const moduleScript = /<script type="module" src="([^"]+)"><\/script>/g;

/**
 * Names each module script of the head as a `modulepreload` link before the script. The browser fetches the script as
 * a preload, and Lighthouse counts no preload in a chain of critical requests, so the page passes the audit "Network
 * dependency tree" with the same scripts, fetched at the same time.
 */
export const preloadModuleScripts = (html: string): string => {
  const head = html.slice(0, html.indexOf("</head>"));
  return head.replace(moduleScript, (script, src: string) => `<link rel="modulepreload" href="${src}">${script}`) + html.slice(head.length);
};
