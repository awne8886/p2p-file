/**
 * Messages between the page and the download service worker (`sw/sw.ts`).
 *
 * The page registers a download over a MessageChannel, then navigates a
 * hidden iframe to `<app base>/SW_DOWNLOAD_PATH<id>`. The service worker answers that
 * request with a streaming `Response` whose body is fed chunk-by-chunk from
 * the page, so the browser writes the download straight to disk.
 *
 * NOTE: `sw/sw.ts` must stay free of runtime imports (it is served as a
 * classic script), so it keeps its own copy of the path constant.
 */
export const SW_DOWNLOAD_PATH = '__pizzadrop/dl/';

/** page → SW (via `ServiceWorker.postMessage`, with one MessagePort attached) */
export interface SwRegisterMessage {
  type: 'register';
  id: string;
  name: string;
  size: number | null;
  mime: string;
}

export interface SwPingMessage {
  type: 'ping';
}

/** page → SW over the MessagePort */
export type PagePortMessage =
  { type: 'chunk'; chunk: Uint8Array } | { type: 'end' } | { type: 'abort'; reason: string };

/** SW → page over the MessagePort */
export type SwPortMessage =
  | { type: 'registered' }
  /** The browser requested the download URL; bytes may now flow. */
  | { type: 'started' }
  /** The browser has consumed `bytes` bytes in total (drives flow control). */
  | { type: 'ack'; bytes: number }
  /** The user cancelled the download in the browser UI. */
  | { type: 'cancel' };
