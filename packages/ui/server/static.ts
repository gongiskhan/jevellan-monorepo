// The web app's files (brief section 7): packages/ui/dist/web as Vite builds it, served with the right types and a
// content security policy that a Vite React build and the A2UI renderer work under.
//
// - A path that names a file of the build is that file; a path under /assets/ or with a static file extension that
//   names none is a 404; every other path is index.html, so client-side routing works (/p/<name>, /t/<id>, ...).
//   manifest.webmanifest and icon.svg are plain files of the build (the phone installs the app; no service worker).
// - Every segment must be a plain name and the file's real path must stay inside the build folder.
// - /assets/ files carry content hashes (Vite), so they are cached for a year; everything else is revalidated.
// - Without a build (no dist/web/index.html) every page is a small plain page that says how to build it.
// - Content security policy: everything from this origin only; no inline or evaluated scripts; images also from
//   data: and blob: URLs, fonts also from data: URLs (Vite inlines assets under 4 KB). Inline style elements are
//   refused. Inline style attributes are allowed (style-src-attr 'unsafe-inline') because the A2UI basic catalog's
//   Text element sets `style="flex: N"` through setAttribute when a component has a weight; React's style props and
//   the renderer's adopted stylesheets need nothing (CSSOM writes and constructed stylesheets are not inline styles).
//   Browsers without style-src-attr fall back to style-src 'self' and only lose those weights.

import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { isInside } from 'jevellan-core/paths';
import { decoded, send } from './http.js';

export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** For responses that are not pages (JSON, evidence images, plain text). */
export const NONE_CSP = "default-src 'none'; frame-ancestors 'none'";

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export const NOT_BUILT_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Jevellan</title></head>',
  '<body>',
  '<h1>Jevellan</h1>',
  '<p>The web app is not built. Run <code>npm run build</code> in the jevellan-monorepo checkout, then reload this page.</p>',
  '<p>The JSON API under /api/ works without it.</p>',
  '</body>',
  '</html>',
  '',
].join('\n');

const IMMUTABLE = 'public, max-age=31536000, immutable';

export interface StaticFiles {
  dir: string;
  /** Whether the build exists (checked on every request, so a build made while the server runs is picked up). */
  built(): boolean;
  serve(req: IncomingMessage, res: ServerResponse, pathname: string, head: boolean): void;
}

function plainSegments(pathname: string): string[] | undefined {
  const out: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    const seg = decoded(raw);
    if (seg === undefined || seg === '.' || seg === '..' || /[/\\\0]/.test(seg)) return undefined;
    out.push(seg);
  }
  return out;
}

export function staticFiles(dir: string): StaticFiles {
  const indexFile = join(dir, 'index.html');

  function notFound(res: ServerResponse, head: boolean): void {
    send(res, 404, 'text/plain; charset=utf-8', 'Not found\n', head, { 'Content-Security-Policy': NONE_CSP });
  }

  function file(req: IncomingMessage, res: ServerResponse, path: string, head: boolean, cache: string): void {
    const st = statSync(path);
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const headers: Record<string, string> = { ETag: etag, 'Cache-Control': cache, 'Content-Security-Policy': PAGE_CSP };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': String(st.size) });
    if (head) {
      res.end();
      return;
    }
    const stream = createReadStream(path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  function index(req: IncomingMessage, res: ServerResponse, head: boolean): void {
    file(req, res, indexFile, head, 'no-cache');
  }

  return {
    dir,
    built: () => existsSync(indexFile),
    serve(req, res, pathname, head) {
      if (!existsSync(indexFile)) {
        send(res, 503, 'text/html; charset=utf-8', NOT_BUILT_HTML, head, { 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP });
        return;
      }
      const segments = plainSegments(pathname);
      if (!segments) return notFound(res, head);
      if (segments.length === 0) return index(req, res, head);
      const candidate = join(dir, ...segments);
      let isFile = false;
      try {
        isFile = statSync(candidate).isFile();
      } catch {
        isFile = false;
      }
      if (isFile) {
        let real: string;
        try {
          real = realpathSync(candidate);
          if (!isInside(real, realpathSync(dir))) return notFound(res, head);
        } catch {
          return notFound(res, head);
        }
        if (real === realpathSync(indexFile)) return index(req, res, head);
        return file(req, res, real, head, segments[0] === 'assets' ? IMMUTABLE : 'no-cache');
      }
      const ext = extname(segments.at(-1)!).toLowerCase();
      if (segments[0] === 'assets' || (ext !== '' && ext in CONTENT_TYPES)) return notFound(res, head);
      return index(req, res, head);
    },
  };
}
