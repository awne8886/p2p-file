/** Messages between the main thread and `workers/hash.worker.ts`. */

export type HashRequest =
  /** Streaming mode (receiver): append bytes to the running hash. */
  | { type: 'update'; data: ArrayBuffer }
  /** Streaming mode: finish the running hash, reply with its digest, and start a fresh one. */
  | { type: 'digest'; id: number }
  /** File mode (sender): hash a whole File/Blob by reading it in slices. */
  | { type: 'hash-file'; id: number; file: Blob };

export type HashResponse =
  | { type: 'digest'; id: number; hex: string }
  | { type: 'progress'; id: number; bytes: number }
  | { type: 'error'; id: number; message: string };
