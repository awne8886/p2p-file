/**
 * Where the app lives. Vite's `base` makes it work both at the root of a domain (`/`) and under a path, e.g. a
 * GitHub Pages project site (`/p2p-file/`). Always ends in `/`.
 */
export const BASE_PATH: string = import.meta.env.BASE_URL;

/** Absolute path of something inside the app, e.g. `appPath('sw.js')` → `/p2p-file/sw.js`. */
export function appPath(path = ''): string {
  return BASE_PATH + path.replace(/^\/+/, '');
}

/** The share code in `pathname`, `''` for the app's home page, or `null` if the path isn't the app's. */
export function pathSegment(pathname: string, basePath: string = BASE_PATH): string | null {
  const base = basePath.replace(/\/+$/, '');
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  return pathname.slice(base.length).replace(/^\/+|\/+$/g, '');
}

/** The link a receiver opens: `https://<origin><base><code>`. */
export function shareUrl(code: string, publicOrigin: string | null): string {
  return `${publicOrigin ?? location.origin}${BASE_PATH}${code}`;
}
