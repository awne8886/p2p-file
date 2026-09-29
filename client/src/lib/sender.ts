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
import { shareUrl } from './config';
import { BLOCK_SIZE, CHUNK_SIZE, CONNECT_TIMEOUT_MS, HIGH_WATER, LOW_WATER, WINDOW } from './constants';
import { sha256Hex } from './digest';
import { ChannelClosedError, Notifier, streamBlob, type Credit } from './flow';
import { randomId } from './ids';
import { PeerLink } from './rtc';
import { createSignaling, type Signaling } from './signaling';
import { SpeedMeter } from './speed';

export type ReceiverStatus = 'connecting' | 'connected' | 'receiving' | 'done' | 'disconnected' | 'failed';

export interface ReceiverSnapshot {
  id: string;
  /** 1-based, for "Receiver 2" labels. */
  n: number;
  status: ReceiverStatus;
  /** Bytes of the receiver's current download written to their disk. */
  bytes: number;
  /** Size of the receiver's current download (0 until they start one). */
  total: number;
  speed: number;
  eta: number;
  error: string | null;
}

export type HostStatus = 'connecting' | 'live' | 'reconnecting' | 'expired' | 'stopped' | 'error';

export interface HostSnapshot {
  status: HostStatus;
  code: string | null;
  url: string | null;
  /** Files currently on offer, oldest first. */
  files: FileMeta[];
  totalBytes: number;
  receivers: ReceiverSnapshot[];
  error: string | null;
}

interface Row {
  id: string;
  n: number;
  status: ReceiverStatus;
  bytes: number;
  total: number;
  error: string | null;
  meter: SpeedMeter;
  link: Outgoing | null;
}

interface Entry {
  file: File;
  meta: FileMeta;
  removed: boolean;
}

/**
 * The sending side. Registers a share code with the signaling server, then
 * opens one RTCPeerConnection per receiver and streams the requested files to
 * each of them independently — a receiver dropping out never affects others.
 * Files can be added to (and removed from) the share while it is live.
 */
export class Host {
  private readonly signaling: Signaling;
  /** Every file ever shared, indexed by id. Removed files stay, flagged, so ids are never reused. */
  private readonly entries: Entry[] = [];

  private readonly rows = new Map<string, Row>();
  private readonly links = new Map<string, Outgoing>();
  private rowCounter = 0;

  private code: string | null = null;
  private token: string | null = null;
  private status: HostStatus = 'connecting';
  private error: string | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    files: readonly File[],
    private readonly onChange: (snapshot: HostSnapshot) => void,
  ) {
    this.append(files);
    this.signaling = createSignaling({
      onReady: () => {
        this.signaling.send(
          this.code && this.token !== null
            ? { t: 'host', resume: { code: this.code, token: this.token } }
            : { t: 'host' },
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
    this.status = 'stopped';
    this.emit();
  }

  /** Offer more files. Receivers see them straight away; those who already downloaded can fetch just the new ones. */
  addFiles(files: readonly File[]): void {
    if (files.length === 0 || this.status === 'stopped') return;
    this.append(files);
    this.broadcastManifest();
    this.emit();
  }

  /**
   * Stop offering a file. It disappears from every receiver's list, and a download that still needs it is stopped:
   * a removed file is never sent again. The last file can't be removed (stop sharing instead).
   */
  removeFile(id: number): void {
    const entry = this.entries[id];
    if (!entry || entry.removed || this.manifest().length <= 1) return;
    entry.removed = true;
    for (const link of this.links.values()) link.fileRemoved(id);
    this.broadcastManifest();
    this.emit();
  }

  /** True while at least one receiver is mid-download. */
  get isTransferring(): boolean {
    for (const r of this.rows.values()) if (r.status === 'receiving') return true;
    return false;
  }

  /** The files on offer, in the order they were added. */
  manifest(): FileMeta[] {
    return this.entries.filter((e) => !e.removed).map((e) => e.meta);
  }

  entry(id: number): Entry | undefined {
    return this.entries[id];
  }

  /** ICE servers for a new connection, once any TURN credentials have loaded. */
  async iceServers(): Promise<RTCIceServer[]> {
    await this.signaling.iceReady;
    return this.signaling.iceServers;
  }

  private append(files: readonly File[]): void {
    for (const file of files) {
      const id = this.entries.length;
      this.entries.push({
        file,
        removed: false,
        meta: {
          id,
          name: file.name || 'file',
          size: file.size,
          type: file.type,
          lastModified:
            Number.isSafeInteger(file.lastModified) && file.lastModified >= 0 ? file.lastModified : Date.now(),
        },
      });
    }
  }

  private broadcastManifest(): void {
    for (const link of this.links.values()) link.sendManifest();
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
        this.addPeer(msg.peerId, msg.clientId, msg.attempt);
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

  private addPeer(peerId: string, clientId: string, attempt?: string): void {
    let row = this.rows.get(clientId);
    const current = row?.link;
    if (current && current.peerId === peerId && attempt !== undefined && current.attempt === attempt && current.alive) {
      // The same connection attempt asking again: its join was repeated because a relay may have lost it (or our
      // offer). Starting over would throw away a connection that may be nearly up, so resend the offer instead.
      if (!current.connected) current.resendOffer();
      return;
    }
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
        total: 0,
        error: null,
        meter: new SpeedMeter(),
        link: null,
      };
      this.rows.set(clientId, row);
    }
    const link = new Outgoing(this, row, peerId, attempt, (data) =>
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
    const files = this.manifest();
    const receivers = [...this.rows.values()].map<ReceiverSnapshot>((r) => ({
      id: r.id,
      n: r.n,
      status: r.status,
      bytes: r.bytes,
      total: r.total,
      speed: r.status === 'receiving' ? r.meter.bytesPerSecond : 0,
      eta: r.status === 'receiving' ? r.meter.eta(r.total) : Infinity,
      error: r.error,
    }));
    this.onChange({
      status: this.status,
      code: this.code,
      url: this.code ? shareUrl(this.code, this.signaling.publicUrl) : null,
      files,
      totalBytes: files.reduce((a, f) => a + f.size, 0),
      receivers,
      error: this.error,
    });
  }
}

/** One receiver's peer connection, data channel and send loop. */
class Outgoing {
  private link: PeerLink | null = null;
  /** Names this connection attempt in every signal (see `PeerLink`). */
  private readonly conn = randomId(6);
  private dc: RTCDataChannel | null = null;
  private readonly changed = new Notifier();
  /** Flow control for everything sent on this channel, across files and requests. */
  private readonly credit: Credit = { sent: 0, acked: 0 };
  private abort: AbortController | null = null;
  /** The request being served: its files, and which of them is being sent now. */
  private serving: { seq: number; files: number[]; index: number } | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  connected = false;
  onClosed: (() => void) | null = null;

  constructor(
    private readonly host: Host,
    readonly row: Row,
    /** The receiver's signaling id, and the attempt it joined with (see `Host.addPeer`). */
    readonly peerId: string,
    readonly attempt: string | undefined,
    private readonly sendSignal: (data: SignalPayload) => void,
  ) {}

  /** Not closed or failed. */
  get alive(): boolean {
    return !this.closed;
  }

  start(): void {
    this.connectTimer = setTimeout(() => {
      if (!this.connected) {
        this.fail("Couldn't connect directly to this receiver (a firewall or strict NAT may be in the way).");
      }
    }, CONNECT_TIMEOUT_MS);
    void this.host.iceServers().then((iceServers) => {
      if (!this.closed) this.open(iceServers);
    });
  }

  private open(iceServers: RTCIceServer[]): void {
    const link = new PeerLink(iceServers, this.conn, this.sendSignal);
    this.link = link;
    link.pc.onconnectionstatechange = () => {
      if (link.pc.connectionState === 'failed') this.fail('The connection to this receiver failed.');
    };
    const dc = link.pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onopen = () => {
      clearTimeout(this.connectTimer);
      this.connected = true;
      if (this.row.status !== 'done') this.setStatus('connected');
      this.sendManifest();
    };
    dc.onbufferedamountlow = () => this.changed.notify();
    dc.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      const msg = parseReceiverMessage(ev.data);
      if (msg) this.onMessage(msg);
    };
    dc.onclose = () => this.close();
    this.dc = dc;
    link.offer().catch((err: unknown) => this.fail(`Could not start the connection: ${String(err)}`));
  }

  handleSignal(data: SignalPayload): Promise<void> {
    if (!this.link) return Promise.resolve();
    return this.link.handleSignal(data).catch((err: unknown) => console.warn('[sender] signal error', err));
  }

  /** Send the offer again (the receiver asked again, so it may never have arrived). */
  resendOffer(): void {
    this.link?.resendDescription();
  }

  sendManifest(): void {
    this.sendControl({ type: 'manifest', version: PROTOCOL_VERSION, files: this.host.manifest() });
  }

  /** The sender removed file `id`: if this receiver's download still needs it, stop the download. */
  fileRemoved(id: number): void {
    const s = this.serving;
    if (!s || s.files.indexOf(id, s.index) === -1) return;
    this.refuse(`"${this.host.entry(id)?.meta.name}" was removed by the sender, so this download can't finish.`);
  }

  private onMessage(msg: ReceiverMessage): void {
    switch (msg.type) {
      case 'request':
        void this.serve(msg);
        return;
      case 'ack':
        this.credit.acked = Math.max(this.credit.acked, msg.bytes);
        this.setProgress(msg.written, msg.total);
        this.changed.notify();
        return;
      case 'done':
        this.setProgress(this.row.total, this.row.total);
        this.setStatus('done');
        return;
      case 'cancel':
        this.stopServing();
        this.setStatus('disconnected');
        this.row.error = 'The receiver cancelled the download.';
        return;
    }
  }

  /** Stream the requested files back to back, each block announced with its SHA-256. */
  private async serve(req: Extract<ReceiverMessage, { type: 'request' }>): Promise<void> {
    const dc = this.dc;
    if (!dc) return;

    // Only one send loop per receiver. The previous one checks its signal
    // synchronously before every send(), so aborting it here is enough.
    this.stopServing();
    const ac = new AbortController();
    this.abort = ac;

    const entries = req.files.map((id) => this.host.entry(id));
    const first = entries[0];
    if (
      !first ||
      entries.some((e) => !e) ||
      req.offset > first.file.size ||
      (req.offset % BLOCK_SIZE !== 0 && req.offset !== first.file.size)
    ) {
      this.sendControl({ type: 'error', message: 'Invalid file request.' });
      return;
    }
    const removed = entries.find((e) => e!.removed);
    if (removed) {
      this.refuse(`"${removed.meta.name}" was removed by the sender, so this download can't finish.`);
      return;
    }

    const serving = { seq: req.seq, files: req.files, index: 0 };
    this.serving = serving;
    this.setProgress(req.written, req.total, true);
    this.setStatus('receiving');

    const maxMessage = this.link?.pc.sctp?.maxMessageSize ?? 0;
    const chunkSize = maxMessage > 0 ? Math.min(CHUNK_SIZE, maxMessage) : CHUNK_SIZE;

    for (let i = 0; i < entries.length; i++) {
      const { file, meta } = entries[i]!;
      serving.index = i;
      try {
        await streamBlob({
          source: file,
          channel: dc,
          offset: i === 0 ? req.offset : 0,
          blockSize: BLOCK_SIZE,
          chunkSize,
          highWater: HIGH_WATER,
          window: WINDOW,
          credit: this.credit,
          changed: this.changed,
          signal: ac.signal,
          digest: sha256Hex,
          onBlock: (b) => this.sendControl({ type: 'block', seq: req.seq, id: meta.id, ...b }),
        });
      } catch (err) {
        if (ac.signal.aborted || err instanceof ChannelClosedError || this.closed) return;
        console.error('[sender] read error', err);
        this.sendControl({
          type: 'error',
          message: `The sender couldn't read "${meta.name}". It may have been moved, changed or deleted.`,
        });
        this.fail(`Couldn't read "${meta.name}" from disk.`);
        return;
      }
      if (ac.signal.aborted || dc.readyState !== 'open') return;
      this.sendControl({ type: 'file-end', seq: req.seq, id: meta.id });
    }
    if (this.serving === serving) this.serving = null;
  }

  private stopServing(): void {
    this.abort?.abort();
    this.abort = null;
    this.serving = null;
  }

  /** Stop the current download and tell the receiver why. */
  private refuse(message: string): void {
    this.stopServing();
    this.sendControl({ type: 'error', message });
    if (this.row.link === this) {
      this.row.error = message;
      this.setStatus('failed');
    }
  }

  private sendControl(msg: SenderMessage): void {
    const dc = this.dc;
    if (dc?.readyState !== 'open') return;
    try {
      dc.send(JSON.stringify(msg));
    } catch (err) {
      // The channel is going away (its state lags behind); the receiver reconnects and re-requests.
      console.warn('[sender] could not send', msg.type, err);
    }
  }

  private setStatus(status: ReceiverStatus): void {
    if (this.row.link !== this) return;
    this.row.status = status;
    this.host.emit();
  }

  /**
   * Update the row's progress. Acks only ever move it forward (after a resume
   * they can briefly trail the resume offset); a new request (`rebase`) sets
   * it outright, e.g. when the same receiver starts a second download.
   */
  private setProgress(bytes: number, total: number, rebase = false): void {
    if (this.row.link !== this) return;
    if (rebase && (bytes < this.row.bytes || total !== this.row.total)) this.row.meter.reset();
    this.row.total = total;
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
    this.stopServing();
    this.changed.notify();
    if (this.dc) {
      this.dc.onclose = null;
      this.dc.onmessage = null;
      this.dc.close();
    }
    this.link?.close();
    if (this.row.link === this && (this.row.status === 'receiving' || this.row.status === 'connected')) {
      this.row.status = 'disconnected';
      this.host.emit();
    }
    this.onClosed?.();
  }
}
