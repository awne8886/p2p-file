import {
  DATA_CHANNEL_LABEL,
  PROTOCOL_VERSION,
  parseReceiverMessage,
  type FileMeta,
  type ReceiverMessage,
  type SenderMessage,
  type ServerMessage,
  type SignalPayload,
} from '@pizzadrop/shared';
import { CHUNK_SIZE, CONNECT_TIMEOUT_MS, HIGH_WATER, LOW_WATER, READ_SIZE, WINDOW } from './constants';
import { ChannelClosedError, Notifier, streamBlob } from './flow';
import { FileHasher } from './hasher';
import { PeerLink } from './rtc';
import { SignalingClient } from './signaling';
import { SpeedMeter } from './speed';

export type ReceiverStatus = 'connecting' | 'connected' | 'receiving' | 'done' | 'disconnected' | 'failed';

export interface ReceiverSnapshot {
  id: string;
  /** 1-based, for "Receiver 2" labels. */
  n: number;
  status: ReceiverStatus;
  /** Bytes the receiver has confirmed writing, across all files. */
  bytes: number;
  total: number;
  speed: number;
  eta: number;
  fileIndex: number;
  error: string | null;
}

export type HostStatus = 'connecting' | 'live' | 'reconnecting' | 'expired' | 'stopped' | 'error';

export interface HostSnapshot {
  status: HostStatus;
  code: string | null;
  url: string | null;
  files: FileMeta[];
  totalBytes: number;
  hashedBytes: number;
  receivers: ReceiverSnapshot[];
  error: string | null;
}

interface Row {
  id: string;
  n: number;
  status: ReceiverStatus;
  bytes: number;
  fileIndex: number;
  error: string | null;
  meter: SpeedMeter;
  link: Outgoing | null;
}

/**
 * The sending side. Registers a share code with the signaling server, then
 * opens one RTCPeerConnection per receiver and streams the requested files to
 * each of them independently — a receiver dropping out never affects others.
 */
export class Host {
  private readonly signaling: SignalingClient;
  readonly hasher: FileHasher;
  readonly meta: FileMeta[];
  /** prefix[i] = total size of files before i. */
  private readonly prefix: number[];
  readonly totalBytes: number;

  private readonly rows = new Map<string, Row>();
  private readonly links = new Map<string, Outgoing>();
  private rowCounter = 0;

  private code: string | null = null;
  private token: string | null = null;
  private status: HostStatus = 'connecting';
  private error: string | null = null;
  private hashedBytes = 0;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly files: readonly File[],
    private readonly onChange: (snapshot: HostSnapshot) => void,
  ) {
    this.meta = files.map((f) => ({
      name: f.name || 'file',
      size: f.size,
      type: f.type,
      lastModified: Number.isSafeInteger(f.lastModified) && f.lastModified >= 0 ? f.lastModified : Date.now(),
    }));
    this.prefix = [];
    let acc = 0;
    for (const f of files) {
      this.prefix.push(acc);
      acc += f.size;
    }
    this.totalBytes = acc;

    this.hasher = new FileHasher(files, (bytes) => {
      this.hashedBytes = bytes;
      this.emitSoon();
    });

    this.signaling = new SignalingClient({
      onReady: () => {
        this.signaling.send(
          this.code && this.token ? { t: 'host', resume: { code: this.code, token: this.token } } : { t: 'host' },
        );
      },
      onMessage: (msg) => this.onSignal(msg),
      onDisconnect: (retrying) => {
        if (retrying && (this.status === 'live' || this.status === 'connecting')) {
          this.status = this.code ? 'reconnecting' : 'connecting';
          this.emit();
        }
      },
    });
  }

  start(): void {
    this.signaling.connect();
    this.emit();
  }

  /** Stop sharing: releases the code and closes every connection. */
  stop(): void {
    if (this.status === 'stopped') return;
    this.signaling.send({ t: 'close' });
    this.signaling.close();
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.hasher.terminate();
    this.status = 'stopped';
    this.emit();
  }

  /** True while at least one receiver is mid-download. */
  get isTransferring(): boolean {
    for (const r of this.rows.values()) if (r.status === 'receiving') return true;
    return false;
  }

  bytesBefore(index: number): number {
    return this.prefix[index] ?? 0;
  }

  // ─── Signaling ───────────────────────────────────────────────────────────

  private onSignal(msg: ServerMessage): void {
    switch (msg.t) {
      case 'hosted':
        this.code = msg.code;
        this.token = msg.token;
        this.status = 'live';
        this.error = null;
        for (const p of msg.peers) if (!this.links.has(p.peerId)) this.addPeer(p.peerId, p.clientId);
        this.emit();
        return;
      case 'peer-joined':
        this.addPeer(msg.peerId, msg.clientId);
        return;
      case 'peer-left': {
        // Only the receiver's signaling socket is gone. An established
        // peer connection keeps going; one still being set up is abandoned.
        const link = this.links.get(msg.peerId);
        if (link && !link.connected) {
          link.close();
          this.links.delete(msg.peerId);
          const row = link.row;
          if (row.link === link && row.status === 'connecting') {
            this.rows.delete(row.id);
          }
          this.emit();
        }
        return;
      }
      case 'signal':
        if (msg.from) void this.links.get(msg.from)?.handleSignal(msg.data);
        return;
      case 'expired':
        this.status = 'expired';
        this.signaling.close();
        this.emit();
        return;
      case 'error':
        if (msg.code === 'unknown-peer') return;
        if (!this.code) {
          this.status = 'error';
          this.error = msg.message;
          this.emit();
        }
        return;
      default:
        return;
    }
  }

  private addPeer(peerId: string, clientId: string): void {
    let row = this.rows.get(clientId);
    if (row) {
      // Same browser tab reconnecting (e.g. after a network blip): replace its old connection.
      row.link?.close();
      if (row.status !== 'done') row.status = 'connecting';
      row.error = null;
    } else {
      row = {
        id: clientId,
        n: ++this.rowCounter,
        status: 'connecting',
        bytes: 0,
        fileIndex: 0,
        error: null,
        meter: new SpeedMeter(),
        link: null,
      };
      this.rows.set(clientId, row);
    }
    const link = new Outgoing(this, row, this.signaling.iceServers, (data) =>
      this.signaling.send({ t: 'signal', to: peerId, data }),
    );
    row.link = link;
    this.links.set(peerId, link);
    link.onClosed = () => {
      if (this.links.get(peerId) === link) this.links.delete(peerId);
    };
    link.start();
    this.emit();
  }

  // ─── Snapshots ───────────────────────────────────────────────────────────

  /** Coalesce frequent progress updates into ≤ 10 renders/second. */
  emitSoon(): void {
    if (this.emitTimer !== undefined) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit();
    }, 100);
  }

  emit(): void {
    const origin = this.signaling.publicUrl ?? location.origin;
    const receivers = [...this.rows.values()].map<ReceiverSnapshot>((r) => ({
      id: r.id,
      n: r.n,
      status: r.status,
      bytes: r.bytes,
      total: this.totalBytes,
      speed: r.status === 'receiving' ? r.meter.bytesPerSecond : 0,
      eta: r.status === 'receiving' ? r.meter.eta(this.totalBytes) : Infinity,
      fileIndex: r.fileIndex,
      error: r.error,
    }));
    this.onChange({
      status: this.status,
      code: this.code,
      url: this.code ? `${origin}/${this.code}` : null,
      files: this.meta,
      totalBytes: this.totalBytes,
      hashedBytes: this.hashedBytes,
      receivers,
      error: this.error,
    });
  }
}

/** One receiver's peer connection, data channel and send loop. */
class Outgoing {
  private readonly link: PeerLink;
  private dc: RTCDataChannel | null = null;
  private readonly changed = new Notifier();
  private acked = 0;
  private index = -1;
  private abort: AbortController | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  connected = false;
  onClosed: (() => void) | null = null;

  constructor(
    private readonly host: Host,
    readonly row: Row,
    iceServers: RTCIceServer[],
    sendSignal: (data: SignalPayload) => void,
  ) {
    this.link = new PeerLink(iceServers, sendSignal);
    this.link.pc.onconnectionstatechange = () => {
      if (this.link.pc.connectionState === 'failed') this.fail('The connection to this receiver failed.');
    };
  }

  start(): void {
    const dc = this.link.pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onopen = () => {
      clearTimeout(this.connectTimer);
      this.connected = true;
      if (this.row.status !== 'done') this.setStatus('connected');
      this.sendControl({ type: 'manifest', version: PROTOCOL_VERSION, files: this.host.meta });
    };
    dc.onbufferedamountlow = () => this.changed.notify();
    dc.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      const msg = parseReceiverMessage(ev.data);
      if (msg) this.onMessage(msg);
    };
    dc.onclose = () => this.close();
    this.dc = dc;

    this.connectTimer = setTimeout(() => {
      if (!this.connected) {
        this.fail("Couldn't connect directly to this receiver (a firewall or strict NAT may be in the way).");
      }
    }, CONNECT_TIMEOUT_MS);

    this.link.offer().catch((err: unknown) => this.fail(`Could not start the connection: ${String(err)}`));
  }

  handleSignal(data: SignalPayload): Promise<void> {
    return this.link.handleSignal(data).catch((err: unknown) => console.warn('[sender] signal error', err));
  }

  private onMessage(msg: ReceiverMessage): void {
    switch (msg.type) {
      case 'request':
        void this.sendFile(msg.index, msg.offset);
        return;
      case 'ack':
        if (msg.index !== this.index) return;
        this.acked = msg.bytes;
        this.setBytes(this.host.bytesBefore(msg.index) + msg.bytes);
        this.changed.notify();
        return;
      case 'done':
        this.abort?.abort();
        this.setBytes(this.host.totalBytes);
        this.setStatus('done');
        return;
      case 'cancel':
        this.abort?.abort();
        this.setStatus('disconnected');
        this.row.error = 'The receiver cancelled the download.';
        return;
    }
  }

  private async sendFile(index: number, offset: number): Promise<void> {
    const file = this.host.files[index];
    const dc = this.dc;
    if (!file || !dc || offset > file.size) {
      this.sendControl({ type: 'error', message: 'Invalid file request.' });
      return;
    }

    // Only one send loop per receiver. The previous one checks its signal
    // synchronously before every send(), so aborting it here is enough.
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;

    this.index = index;
    this.acked = offset;
    this.row.fileIndex = index;
    this.setBytes(this.host.bytesBefore(index) + offset, true);
    this.setStatus('receiving');

    const maxMessage = this.link.pc.sctp?.maxMessageSize ?? 0;
    const chunkSize = maxMessage > 0 ? Math.min(CHUNK_SIZE, maxMessage) : CHUNK_SIZE;

    try {
      await streamBlob({
        source: file,
        channel: dc,
        offset,
        chunkSize,
        readSize: READ_SIZE,
        highWater: HIGH_WATER,
        window: WINDOW,
        acked: () => this.acked,
        changed: this.changed,
        signal: ac.signal,
      });
      const sha256 = await abortable(this.host.hasher.digest(index), ac.signal);
      if (ac.signal.aborted || dc.readyState !== 'open') return;
      this.sendControl({ type: 'file-end', index, sha256 });
    } catch (err) {
      if (ac.signal.aborted || err instanceof ChannelClosedError || this.closed) return;
      console.error('[sender] read error', err);
      this.sendControl({
        type: 'error',
        message: `The sender couldn't read "${file.name}". It may have been moved, changed or deleted.`,
      });
      this.fail(`Couldn't read "${file.name}" from disk.`);
    }
  }

  private sendControl(msg: SenderMessage): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg));
  }

  private setStatus(status: ReceiverStatus): void {
    if (this.row.link !== this) return;
    this.row.status = status;
    this.host.emit();
  }

  /**
   * Update the row's progress. Acks only ever move it forward (after a resume
   * they can briefly trail the resume offset); a new request (`rebase`) sets
   * it outright, e.g. when the same receiver downloads a second time.
   */
  private setBytes(bytes: number, rebase = false): void {
    if (this.row.link !== this) return;
    if (rebase && bytes < this.row.bytes) this.row.meter.reset();
    this.row.bytes = rebase ? bytes : Math.max(this.row.bytes, bytes);
    this.row.meter.push(this.row.bytes);
    this.host.emitSoon();
  }

  private fail(message: string): void {
    if (this.row.link === this && this.row.status !== 'done') {
      this.row.error = message;
      this.row.status = 'failed';
      this.host.emit();
    }
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    this.abort?.abort();
    this.changed.notify();
    if (this.dc) {
      this.dc.onclose = null;
      this.dc.onmessage = null;
      this.dc.close();
    }
    this.link.close();
    if (this.row.link === this && (this.row.status === 'receiving' || this.row.status === 'connected')) {
      this.row.status = 'disconnected';
      this.host.emit();
    }
    this.onClosed?.();
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
