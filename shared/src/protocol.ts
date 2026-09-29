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

export const PROTOCOL_VERSION = 1;

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
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

/** Sender → receiver control messages. */
export type SenderMessage =
  | { type: 'manifest'; version: number; files: FileMeta[] }
  /** All bytes of file `index` have been sent; `sha256` is the hex digest of the whole file. */
  | { type: 'file-end'; index: number; sha256: string }
  | { type: 'error'; message: string };

/** Receiver → sender control messages. */
export type ReceiverMessage =
  /** Start (or resume) sending file `index` from byte `offset`. */
  | { type: 'request'; index: number; offset: number }
  /** The receiver has consumed (written to disk) `bytes` bytes of file `index`. Drives flow control. */
  | { type: 'ack'; index: number; bytes: number }
  /** Everything received, verified and saved. */
  | { type: 'done' }
  /** Receiver gave up; stop sending. */
  | { type: 'cancel' };

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

function isIceServer(v: unknown): v is IceServerConfig {
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

const MAX_FILES = 10_000;

function isFileMeta(v: unknown): v is FileMeta {
  return (
    isObj(v) && isStr(v.name, 1024) && v.name.length > 0 && isNat(v.size) && isStr(v.type, 256) && isNat(v.lastModified)
  );
}

export function parseSenderMessage(raw: unknown): SenderMessage | null {
  const m = parseJson(raw);
  if (!m) return null;
  switch (m.type) {
    case 'manifest':
      return isNat(m.version) &&
        Array.isArray(m.files) &&
        m.files.length > 0 &&
        m.files.length <= MAX_FILES &&
        m.files.every(isFileMeta)
        ? { type: 'manifest', version: m.version, files: m.files }
        : null;
    case 'file-end':
      return isNat(m.index) && typeof m.sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.sha256)
        ? { type: 'file-end', index: m.index, sha256: m.sha256 }
        : null;
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
      return isNat(m.index) && isNat(m.offset) ? { type: 'request', index: m.index, offset: m.offset } : null;
    case 'ack':
      return isNat(m.index) && isNat(m.bytes) ? { type: 'ack', index: m.index, bytes: m.bytes } : null;
    case 'done':
      return { type: 'done' };
    case 'cancel':
      return { type: 'cancel' };
    default:
      return null;
  }
}
