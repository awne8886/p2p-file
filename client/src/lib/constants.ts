const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Size of each binary data-channel message. 64 KiB is the largest size every
 * browser pair accepts (older Safari advertises a 64 KiB SCTP max-message-size).
 */
export const CHUNK_SIZE = 64 * KiB;

/** How much of the file is read from disk per `Blob.slice().arrayBuffer()` call (then split into chunks). */
export const READ_SIZE = 1 * MiB;

/**
 * Sender-side back-pressure: stop calling `send()` while the channel's
 * `bufferedAmount` is above HIGH_WATER, resume on `bufferedamountlow`
 * (fired when it drops to LOW_WATER). Chrome closes a channel whose buffer
 * exceeds 16 MiB, so HIGH_WATER + one chunk must stay well below that.
 */
export const HIGH_WATER = 4 * MiB;
export const LOW_WATER = 1 * MiB;

/**
 * End-to-end flow control: the sender never has more than WINDOW bytes of a
 * file in flight that the receiver hasn't yet written to disk. Without this a
 * slow disk on the receiving side would make the receiver buffer the whole
 * file in RAM (WebRTC has no receive-side back-pressure).
 */
export const WINDOW = 16 * MiB;

/** Receiver acknowledges consumed bytes every ACK_EVERY bytes. */
export const ACK_EVERY = 1 * MiB;

/** Above this, the in-memory Blob fallback shows a warning before starting. */
export const BLOB_WARN_BYTES = 500 * 1000 * 1000;

/** Receiver gives up connecting to the sender after this long. */
export const CONNECT_TIMEOUT_MS = 25_000;

/** Reconnection attempts after a receiver's connection drops mid-transfer. */
export const MAX_RECONNECTS = 5;
