/**
 * The media type of each kind of file in the build, as Cloudflare serves it. The servers of the tests and of the
 * Lighthouse run use this table, so they send each file as production does.
 */
export const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xml": "application/xml",
  ".gz": "application/gzip",
};

/** Files of the build that configure Cloudflare. Cloudflare reads them, and serves neither. */
export const configFiles: readonly string[] = ["_headers", "_redirects"];

const extension = (path: string): string => /\.[^./]+$/.exec(path)?.[0] ?? "";

export const contentType = (path: string): string | undefined => contentTypes[extension(path)];
