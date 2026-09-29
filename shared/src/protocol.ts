/**
 * Wire protocol.
 *
 * Two layers:
 *  1. Signaling (JSON over WebSocket, browser ⇄ server). The server only
 *     issues share codes and relays WebRTC session descriptions / ICE
 *     candidates. It never sees file names, sizes or bytes.
 *  2. Peer (over an ordered, reliable RTCDataChannel, sender ⇄ receiver).
 *     Control messages are JSON strings; file bytes are binary messages.
 */

/**
 * Version of the peer protocol, announced in the manifest. 2 added per-block SHA-256, batch requests and file ids.
 */
export const PROTOCOL_VERSION = 2;

/** Path the WebSocket signaling endpoint is served on. */
export const SIGNAL_PATH = '/ws';

/** Label of the data channel that carries a transfer. */
export const DATA_CHANNEL_LABEL = 'pizzadrop';

// ─── Signaling ────────────────────────────────────────────────────────────

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SessionDescriptionPayload {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

export type SignalPayload =
  | { kind: 'description'; description: SessionDescriptionPayload }
  | { kind: 'candidate'; candidate: IceCandidatePayload | null };

export interface PeerInfo {
  peerId: string;
  clientId: string;
}

export type ErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'room-full'
  | 'rate-limited'
  | 'already-hosting'
  | 'not-in-room'
  | 'unknown-peer'
  | 'server-error';

/** Browser → server. */
export type ClientMessage =
  /** Sender asks for a share code, or reclaims one after a dropped socket. */
  | { t: 'host'; resume?: { code: string; token: string } }
  /** Receiver asks to be introduced to the sender behind `code`. */
  | { t: 'join'; code: string; clientId: string }
  /** Relay a WebRTC payload. Senders must set `to`; receivers always talk to their sender. */
  | { t: 'signal'; to?: string; data: SignalPayload }
  /** Sender stops sharing: the code is released immediately. */
  | { t: 'close' }
  /** Receiver leaves the room. */
  | { t: 'leave' };

/** Server → browser. */
export type ServerMessage =
  | { t: 'hello'; version: number; iceServers: IceServerConfig[]; publicUrl: string | null }
  | { t: 'hosted'; code: string; token: string; expiresAt: number; peers: PeerInfo[] }
  | { t: 'joined'; peerId: string }
  | { t: 'peer-joined'; peerId: string; clientId: string }
  | { t: 'peer-left'; peerId: string }
  | { t: 'signal'; from?: string; data: SignalPayload }
  /** Sent to receivers when the sender's code is gone (tab closed, stopped, or expired). */
  | { t: 'host-left' }
  /** Sent to the sender when the idle TTL elapses. */
  | { t: 'expired' }
  | { t: 'error'; code: ErrorCode; message: string };

// ─── Peer (data channel) ───────────────────────────────────────────────────

export interface FileMeta {
  /** Stable id of the file within a share. Ids are never reused, so they survive files being added or removed. */
  id: number;
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

/** Sender → receiver control messages. */
export type SenderMessage =
  /** Everything currently on offer. Sent when the channel opens and again whenever the sender adds or removes files. */
  | { type: 'manifest'; version: number; files: FileMeta[] }
  /**
   * The next `size` binary bytes on the channel are bytes `offset..offset+size` of file `id`, and their SHA-256 is
   * `sha256`. `seq` is the request this block answers, so bytes from a superseded request can be told apart.
   */
  | { type: 'block'; seq: number; id: number; offset: number; size: number; sha256: string }
  /** Every block of file `id` has been sent. */
  | { type: 'file-end'; seq: number; id: number }
  | { type: 'error'; message: string };

/** Receiver → sender control messages. */
export type ReceiverMessage =
  /**
   * Send files `files` back to back, starting the first one at byte `offset` (a block boundary) and the rest from
   * the beginning. Supersedes any earlier request. `written` and `total` describe the whole download, for the
   * sender's progress display.
   */
  | { type: 'request'; seq: number; files: number[]; offset: number; written: number; total: number }
  /**
   * Flow control: `bytes` is how many binary bytes received on this channel the receiver has finished with (written
   * to disk, or discarded). `written` / `total` is the download's progress.
   */
  | { type: 'ack'; bytes: number; written: number; total: number }
  /** The current download is received, verified and saved. The receiver may start another one later. */
  | { type: 'done' }
  /** Receiver gave up; stop sending. */
  | { type: 'cancel' };

/** Largest block a sender may announce; the receiver allocates a buffer this size for it. */
export const MAX_BLOCK_SIZE = 16 * 1024 * 1024;

// ─── Validation ────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length <= max;
const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function parseJson(raw: unknown): Obj | null {
  if (typeof raw !== 'string') return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** SDP is a few KB in practice; anything much larger is abuse. */
const MAX_SDP = 32 * 1024;

export function isSignalPayload(v: unknown): v is SignalPayload {
  if (!isObj(v)) return false;
  if (v.kind === 'description') {
    const d = v.description;
    return isObj(d) && (d.type === 'offer' || d.type === 'answer') && isStr(d.sdp, MAX_SDP);
  }
  if (v.kind === 'candidate') {
    const c = v.candidate;
    if (c === null) return true;
    return (
      isObj(c) &&
      isStr(c.candidate, 2048) &&
      (c.sdpMid === null || isStr(c.sdpMid, 64)) &&
      (c.sdpMLineIndex === null || isNat(c.sdpMLineIndex)) &&
      (c.usernameFragment === null || isStr(c.usernameFragment, 256))
    );
  }
  return false;
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  const m = parseJson(raw);
  if (!m) return null;
  switch (m.t) {
    case 'host': {
      if (m.resume === undefined) return { t: 'host' };
      const r = m.resume;
      if (isObj(r) && isStr(r.code, 16) && isStr(r.token, 128)) {
        return { t: 'host', resume: { code: r.code, token: r.token } };
      }
      return null;
    }
    case 'join':
      return isStr(m.code, 16) && isStr(m.clientId, 64) && m.clientId.length > 0
        ? { t: 'join', code: m.code, clientId: m.clientId }
        : null;
    case 'signal':
      if (!isSignalPayload(m.data)) return null;
      if (m.to === undefined) return { t: 'signal', data: m.data };
      return isStr(m.to, 64) ? { t: 'signal', to: m.to, data: m.data } : null;
    case 'close':
      return { t: 'close' };
    case 'leave':
      return { t: 'leave' };
    default:
      return null;
  }
}

export function isIceServer(v: unknown): v is IceServerConfig {
  if (!isObj(v)) return false;
  const urlsOk = isStr(v.urls) || (Array.isArray(v.urls) && v.urls.every((u) => isStr(u)));
  return (
    urlsOk && (v.username === undefined || isStr(v.username)) && (v.credential === undefined || isStr(v.credential))
  );
}

export function parseServerMessage(raw: unknown): ServerMessage | null {
  const m = parseJson(raw);
  if (!m) return null;
  switch (m.t) {
    case 'hello':
      return isNat(m.version) &&
        Array.isArray(m.iceServers) &&
        m.iceServers.every(isIceServer) &&
        (m.publicUrl === null || isStr(m.publicUrl))
        ? { t: 'hello', version: m.version, iceServers: m.iceServers, publicUrl: m.publicUrl }
        : null;
    case 'hosted':
      return isStr(m.code) &&
        isStr(m.token) &&
        isNat(m.expiresAt) &&
        Array.isArray(m.peers) &&
        m.peers.every((p) => isObj(p) && isStr(p.peerId) && isStr(p.clientId))
        ? { t: 'hosted', code: m.code, token: m.token, expiresAt: m.expiresAt, peers: m.peers as PeerInfo[] }
        : null;
    case 'joined':
      return isStr(m.peerId) ? { t: 'joined', peerId: m.peerId } : null;
    case 'peer-joined':
      return isStr(m.peerId) && isStr(m.clientId) ? { t: 'peer-joined', peerId: m.peerId, clientId: m.clientId } : null;
    case 'peer-left':
      return isStr(m.peerId) ? { t: 'peer-left', peerId: m.peerId } : null;
    case 'signal':
      if (!isSignalPayload(m.data)) return null;
      if (m.from === undefined) return { t: 'signal', data: m.data };
      return isStr(m.from) ? { t: 'signal', from: m.from, data: m.data } : null;
    case 'host-left':
      return { t: 'host-left' };
    case 'expired':
      return { t: 'expired' };
    case 'error':
      return isStr(m.code) && isStr(m.message) ? { t: 'error', code: m.code as ErrorCode, message: m.message } : null;
    default:
      return null;
  }
}

export const MAX_FILES = 10_000;

const isSha256 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

function isFileMeta(v: unknown): v is FileMeta {
  return (
    isObj(v) &&
    isNat(v.id) &&
    isStr(v.name, 1024) &&
    v.name.length > 0 &&
    isNat(v.size) &&
    isStr(v.type, 256) &&
    isNat(v.lastModified)
  );
}

export function parseSenderMessage(raw: unknown): SenderMessage | null {
  const m = parseJson(raw);
  if (!m) return null;
  switch (m.type) {
    case 'manifest': {
      if (!isNat(m.version)) return null;
      // Another protocol version: pass the version through so the receiver can say so.
      if (m.version !== PROTOCOL_VERSION) return { type: 'manifest', version: m.version, files: [] };
      if (!Array.isArray(m.files) || m.files.length > MAX_FILES || !m.files.every(isFileMeta)) return null;
      const files = m.files as FileMeta[];
      if (new Set(files.map((f) => f.id)).size !== files.length) return null;
      return { type: 'manifest', version: m.version, files };
    }
    case 'block':
      return isNat(m.seq) &&
        isNat(m.id) &&
        isNat(m.offset) &&
        isNat(m.size) &&
        m.size > 0 &&
        m.size <= MAX_BLOCK_SIZE &&
        isSha256(m.sha256)
        ? { type: 'block', seq: m.seq, id: m.id, offset: m.offset, size: m.size, sha256: m.sha256 }
        : null;
    case 'file-end':
      return isNat(m.seq) && isNat(m.id) ? { type: 'file-end', seq: m.seq, id: m.id } : null;
    case 'error':
      return isStr(m.message) ? { type: 'error', message: m.message } : null;
    default:
      return null;
  }
}

export function parseReceiverMessage(raw: unknown): ReceiverMessage | null {
  const m = parseJson(raw);
  if (!m) return null;
  switch (m.type) {
    case 'request':
      return isNat(m.seq) &&
        Array.isArray(m.files) &&
        m.files.length > 0 &&
        m.files.length <= MAX_FILES &&
        m.files.every(isNat) &&
        isNat(m.offset) &&
        isNat(m.written) &&
        isNat(m.total)
        ? {
            type: 'request',
            seq: m.seq,
            files: m.files as number[],
            offset: m.offset,
            written: m.written,
            total: m.total,
          }
        : null;
    case 'ack':
      return isNat(m.bytes) && isNat(m.written) && isNat(m.total)
        ? { type: 'ack', bytes: m.bytes, written: m.written, total: m.total }
        : null;
    case 'done':
      return { type: 'done' };
    case 'cancel':
      return { type: 'cancel' };
    default:
      return null;
  }
}
