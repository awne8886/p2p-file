const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Largest binary data-channel message we send. The real size is the smaller of this and the connection's negotiated
 * `sctp.maxMessageSize`: 256 KiB between Chromium/Firefox/current Safari, 64 KiB with older Safari. Bigger messages
 * mean 4× fewer `send()` calls and `message` events per byte, which is most of the per-byte JavaScript cost.
 */
export const CHUNK_SIZE = 256 * KiB;

/**
 * Integrity unit. The sender reads the file one block at a time and hashes each block with the browser's native
 * SHA-256 (WebCrypto); the receiver checks every block before a single byte of it reaches the disk. A block that
 * fails is simply fetched again, so corruption costs one block rather than the whole download. It is also the read
 * size on the sender and the write size on the receiver: big, infrequent disk I/O is cheaper than small writes.
 */
export const BLOCK_SIZE = 4 * MiB;

/** How many times one block may fail its check before the download is abandoned. */
export const MAX_BLOCK_RETRIES = 3;

/**
 * Sender-side back-pressure: stop calling `send()` while the channel's `bufferedAmount` is above HIGH_WATER, resume
 * on `bufferedamountlow` (fired at LOW_WATER). LOW_WATER is kept high enough that the SCTP stack still has several
 * megabytes queued while JavaScript refills the buffer (at 1 Gbit/s, 1 MiB drains in 8 ms). Chrome closes a channel
 * whose buffer exceeds 16 MiB, so HIGH_WATER + one chunk stays well below that.
 */
export const HIGH_WATER = 8 * MiB;
export const LOW_WATER = 4 * MiB;

/**
 * End-to-end flow control: the sender never has more than WINDOW bytes on this connection that the receiver hasn't
 * yet written to disk (or thrown away). Without this a slow disk on the receiving side would make the receiver
 * buffer the whole file in RAM (WebRTC has no receive-side back-pressure). It has to cover the sender's own buffer,
 * the network's bandwidth × round trip, and the receiver's block being assembled and checked.
 */
export const WINDOW = 48 * MiB;

/** Receiver acknowledges finished bytes at least every ACK_EVERY bytes. */
export const ACK_EVERY = 1 * MiB;

/** Above this, the in-memory Blob fallback shows a warning before starting. */
export const BLOB_WARN_BYTES = 500 * 1000 * 1000;

/** Sender gives up on a receiver whose peer connection hasn't opened after this long. */
export const CONNECT_TIMEOUT_MS = 25_000;

/*
 * Receiver: connecting to the sender goes through phases, each with its own limit, so it always ends in either a
 * connection or an error that says which step failed. Limits count time while the page is visible (a phone that
 * locks its screen mid-connection shouldn't come back to an error), and repeating a step never resets them.
 */

/** Reaching a signaling server (or any relay). */
export const SIGNALING_TIMEOUT_MS = 20_000;
/** Waiting for the sender to answer a join. The sender replies at once when its tab is open and awake. */
export const LOOKING_TIMEOUT_MS = 12_000;
/** The same, when reconnecting mid-download: the sender's own connection may be recovering too. */
export const RELOOKING_TIMEOUT_MS = 30_000;
/** Repeat an unanswered join this often: a relay may have lost it. */
export const JOIN_RETRY_MS = 3_000;
/** One peer connection getting from offer to open data channel (and the file list). */
export const NEGOTIATE_TIMEOUT_MS = 20_000;
/** Fresh peer connections tried before concluding the two browsers can't reach each other. */
export const MAX_CONNECT_ATTEMPTS = 2;
/** The same mid-download, where the network may still be settling (e.g. Wi-Fi handing over to mobile data). */
export const MAX_RECONNECT_ATTEMPTS = 4;
/** Everything together, however the phases went: a hard stop (doubled when reconnecting mid-download). */
export const CONNECT_BUDGET_MS = 90_000;

/** Reconnection attempts after a receiver's connection drops mid-transfer. */
export const MAX_RECONNECTS = 5;

/**
 * A download that makes no progress at all (nothing received, nothing written) for this long is presumed stuck,
 * e.g. a network path that died without the connection noticing: the receiver reconnects and resumes from the last
 * verified block.
 */
export const STALL_MS = 20_000;

/** Stall recoveries in a row, without any bytes written in between, before the download is given up. */
export const MAX_STALL_RECOVERIES = 3;
