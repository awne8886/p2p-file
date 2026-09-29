/** Messages between the main thread and `workers/opfs.worker.ts`. */

/** OPFS directory that incoming downloads are staged in. */
export const OPFS_DIR = 'pizzadrop-incoming';

export type OpfsRequest =
  | { type: 'open'; id: number; dir: string; name: string }
  | { type: 'write'; id: number; chunk: Uint8Array }
  | { type: 'close'; id: number }
  | { type: 'abort'; id: number };

export type OpfsResponse = { type: 'ok'; id: number } | { type: 'error'; id: number; message: string };

/** An {@link OpfsRequest} before the caller assigns its id. */
export type OpfsCommand = OpfsRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
