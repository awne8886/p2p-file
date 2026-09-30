import { makeZip, predictLength } from 'client-zip';
import {
  parseSenderMessage,
  PROTOCOL_VERSION,
  type FileMeta,
  type ReceiverMessage,
  type SenderMessage,
  type ServerMessage,
  type SignalPayload,
} from '@pizzadrop/shared';
import {
  ACK_EVERY,
  CONNECT_BUDGET_MS,
  JOIN_RETRY_MS,
  LOOKING_TIMEOUT_MS,
  MAX_BLOCK_RETRIES,
  MAX_CONNECT_ATTEMPTS,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECTS,
  MAX_STALL_RECOVERIES,
  NEGOTIATE_TIMEOUT_MS,
  RELOOKING_TIMEOUT_MS,
  SIGNALING_TIMEOUT_MS,
  STALL_MS,
} from './constants';
import { sha256Hex } from './digest';
import { Notifier } from './flow';
import { randomId } from './ids';
import { sanitizeName, uniqueNames } from './names';
import { PeerLink } from './rtc';
import { createSignaling, type Signaling } from './signaling';
import type { Sink, SinkKind } from './sinks';
import { SpeedMeter } from './speed';

export type ReceiveStatus = 'connecting' | 'ready' | 'receiving' | 'reconnecting' | 'finishing' | 'done' | 'error';

export type ReceiveErrorKind =
  'not-found' | 'no-sender' | 'host-left' | 'unreachable' | 'integrity' | 'sender' | 'save' | 'network' | 'cancelled';

/**
 * Where connecting to the sender has got to: reaching a signaling server, waiting for the sender to answer, then
 * opening the direct connection between the two browsers.
 */
export type ConnectPhase = 'signaling' | 'looking' | 'negotiating';

export interface BatchSnapshot {
  /** 1 for the first download from this share, 2 for the next… */
  n: number;
  files: FileMeta[];
  /** Name the download is saved under (the file itself, or a .zip for several). */
  saveName: string;
  total: number;
  bytes: number;
  /** Position (in `files`) of the file currently arriving. */
  fileIndex: number;
  /** Files received, verified and handed to the save. */
  verified: number;
}

export interface ReceiveSnapshot {
  status: ReceiveStatus;
  /** Everything the sender offers right now. */
  files: FileMeta[] | null;
  /** Offered files that haven't been downloaded yet: what the download button fetches. */
  pending: FileMeta[];
  pendingBytes: number;
  /** How many files have been saved so far, across downloads. */
  downloadedCount: number;
  /** The download in progress, or the last one. */
  batch: BatchSnapshot | null;
  speed: number;
  eta: number;
  sinkKind: SinkKind | null;
  /** Blocks that failed their SHA-256 check and were fetched again. */
  repaired: number;
  /** The sender stopped sharing after we finished (not an error: everything we asked for arrived). */
  hostGone: boolean;
  /** While (re)connecting: the current step, and which fresh connection attempt this is (1, 2…). */
  connect: { phase: ConnectPhase; attempt: number } | null;
  error: { kind: ReceiveErrorKind; message: string } | null;
}

/** What {@link Receiver.planDownload} will fetch, and how to save it. */
export interface DownloadPlan {
  files: FileMeta[];
  name: string;
  /** Exact byte length of the saved file (the zip's, for several files). */
  size: number;
  mime: string;
}

const UNREACHABLE =
  'Found the sender, but your two browsers couldn’t open a direct connection. Some networks block this (guest or office Wi-Fi, VPNs, some mobile carriers). Try again, or put one device on a different network, e.g. mobile data. The site owner can make this always work by adding a TURN relay.';

/** Stable per-tab id so the sender can recognise us when we reconnect. */
function tabClientId(): string {
  const key = 'pizzadrop:client-id';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = randomId(16);
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return randomId(16);
  }
}

/** One download: a fixed list of files saved as one file (or one zip). */
interface Batch {
  n: number;
  files: FileMeta[];
  saveName: string;
  total: number;
  incoming: Map<number, IncomingFile>;
  /** Position of the file whose blocks are arriving. */
  cursor: number;
  /** Files completely verified and ended (always a prefix of `files`). */
  done: number;
  /** Bytes handed to the sink. */
  written: number;
  /** Bytes received for this download (verified, or in blocks still arriving / being checked). */
  progress: number;
}

/** A block being assembled from the chunks that follow its header. */
interface Assembly {
  /** From a superseded request: its bytes are counted and dropped. */
  stale: boolean;
  seq: number;
  /** Data channel it arrived on (flow-control credit is per channel). */
  conn: number;
  pos: number;
  offset: number;
  size: number;
  sha256: string;
  buf: Uint8Array<ArrayBuffer> | null;
  filled: number;
}

/**
 * The receiving side: connects to the sender behind `code`, shows what's on
 * offer, and on {@link start} streams the chosen files into a sink.
 *
 * Integrity: every block arrives with the SHA-256 the sender computed as it
 * read the file. A block is checked before any of it is written, so nothing
 * unverified ever reaches the disk, and a block that fails is simply fetched
 * again. If the connection drops, the receiver reconnects and resumes from the
 * last verified block.
 */
export class Receiver {
  private readonly signaling: Signaling;
  private readonly clientId = tabClientId();
  private link: PeerLink | null = null;
  private dc: RTCDataChannel | null = null;
  private readonly meter = new SpeedMeter();

  private status: ReceiveStatus = 'connecting';
  private error: ReceiveSnapshot['error'] = null;
  private manifest: FileMeta[] | null = null;
  private readonly downloaded = new Set<number>();
  private batch: Batch | null = null;
  private sinkKind: SinkKind | null = null;
  private repaired = 0;
  private hostGone = false;
  private destroyed = false;

  // Per data channel: flow-control counters and the block being assembled.
  private conn = 0;
  private rx = 0;
  private released = 0;
  private lastAck = 0;
  private awaitingManifest = false;
  private block: Assembly | null = null;
  /** Current request; blocks from earlier ones are dropped. */
  private seq = 0;
  /** Block checks, resolved in arrival order. */
  private verifying: Promise<void> = Promise.resolve();
  private readonly retries = new Map<string, number>();

  // Connecting (see ConnectPhase and the limits in constants.ts).
  private connecting = false;
  private phase: ConnectPhase = 'signaling';
  /** Visible time spent in this phase / in this whole (re)connection. */
  private phaseMs = 0;
  private episodeMs = 0;
  private rejoining = false;
  /** Fresh peer connections tried in this (re)connection, and the id of the current one. */
  private attempts = 0;
  private attempt = '';
  private lastJoinAt = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  /** An offer we're answering while ICE servers load. */
  private linkPending: string | null = null;
  /** Candidates for a connection whose offer hasn't arrived yet: relays can deliver out of order. */
  private early: SignalPayload[] = [];
  private reconnects = 0;
  private readonly onVisible = () => {
    // Back in the foreground: don't wait for the next retry to ask again.
    if (document.visibilityState === 'visible' && this.connecting && this.phase === 'looking') this.sendJoin();
  };
  /** Bumped by anything that counts as progress: a chunk arriving, a check finishing, a write. */
  private activity = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private stall = { activity: -1, since: 0, recoveries: 0, written: 0 };
  private emitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly code: string,
    private readonly onChange: (snapshot: ReceiveSnapshot) => void,
  ) {
    this.signaling = createSignaling({
      onReady: () => {
        // Only (re)join when we actually need a peer connection: re-joining
        // while the data channel is healthy would make the sender replace it.
        if (this.isChannelOpen || this.isFinal || this.hostGone) return;
        if (!this.connecting) this.beginConnect(false);
        if (this.phase === 'signaling' && this.signaling.isOpen) this.setPhase('looking');
        // Sent even before a relay is up: it goes out as soon as one is.
        this.sendJoin();
      },
      onMessage: (msg) => this.onSignal(msg),
    });
  }

  connect(): void {
    document.addEventListener('visibilitychange', this.onVisible);
    this.beginConnect(false);
    this.signaling.connect();
    this.emit();
  }

  /** The files the download button would fetch now, and the name/size/type to save them under. */
  planDownload(): DownloadPlan | null {
    if (this.busy) return null;
    const files = this.pending();
    if (files.length === 0) return null;
    const n = (this.batch?.n ?? 0) + 1;
    if (files.length === 1) {
      const f = files[0]!;
      return { files, name: sanitizeName(f.name), size: f.size, mime: f.type || 'application/octet-stream' };
    }
    const names = uniqueNames(files.map((f) => sanitizeName(f.name)));
    return {
      files,
      name: n === 1 ? `pizzadrop-${this.code}.zip` : `pizzadrop-${this.code}-${n}.zip`,
      size: Number(predictLength(files.map((f, i) => ({ name: names[i]!, size: f.size })))),
      mime: 'application/zip',
    };
  }

  /** Download `plan`'s files into `sink`. False if a download can't start now (the caller should abort the sink). */
  start(sink: Sink, plan: DownloadPlan): boolean {
    if (this.busy || this.isFinal || !this.manifest || plan.files.length === 0) return false;
    const batch: Batch = {
      n: (this.batch?.n ?? 0) + 1,
      files: plan.files,
      saveName: plan.name,
      total: plan.files.reduce((a, f) => a + f.size, 0),
      incoming: new Map(),
      cursor: 0,
      done: 0,
      written: 0,
      progress: 0,
    };
    this.batch = batch;
    this.sinkKind = sink.kind;
    this.status = 'receiving';
    this.meter.reset();

    const source =
      batch.files.length === 1
        ? this.file(batch, 0).readable
        : makeZip(this.zipEntries(batch), { buffersAreUTF8: true });

    this.request(batch);
    this.watch(batch);
    source.pipeTo(sink.writable).then(
      () => this.finish(batch),
      (err: unknown) => {
        if (this.status === 'error') return;
        const message = err instanceof Error ? err.message : String(err);
        this.fail('save', `Saving failed: ${message}`);
      },
    );
    this.emit();
    return true;
  }

  /** Stop the download (the partial file is discarded where the sink allows it). */
  cancel(): void {
    if (this.isFinal || !this.busy) return;
    this.sendControl({ type: 'cancel' });
    this.fail('cancelled', 'Download cancelled.');
  }

  /** Tear everything down (component unmount). */
  destroy(): void {
    this.destroyed = true;
    document.removeEventListener('visibilitychange', this.onVisible);
    clearInterval(this.watchdog);
    this.endConnect();
    clearTimeout(this.emitTimer);
    this.signaling.send({ t: 'leave' });
    this.signaling.close();
    this.closeLink();
    this.batch?.incoming.forEach((f) => f.fail(new DOMException('closed', 'AbortError')));
  }

  /** A download is under way. */
  private get busy(): boolean {
    return this.status === 'receiving' || this.status === 'reconnecting' || this.status === 'finishing';
  }

  private get isChannelOpen(): boolean {
    return this.dc?.readyState === 'open';
  }

  private get isFinal(): boolean {
    return this.status === 'error' || this.destroyed;
  }

  private pending(): FileMeta[] {
    if (!this.manifest) return [];
    const inFlight = this.busy && this.batch ? new Set(this.batch.files.map((f) => f.id)) : null;
    return this.manifest.filter((f) => !this.downloaded.has(f.id) && !inFlight?.has(f.id));
  }

  // ─── Signaling / connection ─────────────────────────────────────────────

  /**
   * Start a (re)connection. It ends when the sender's file list arrives over a fresh data channel, or with an error
   * (see {@link tick}): never open-ended.
   */
  private beginConnect(rejoining: boolean): void {
    this.connecting = true;
    this.rejoining = rejoining;
    this.episodeMs = 0;
    this.attempts = 1;
    this.attempt = randomId(6);
    this.phase = this.signaling?.isOpen ? 'looking' : 'signaling';
    this.phaseMs = 0;
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  private endConnect(): void {
    this.connecting = false;
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private setPhase(phase: ConnectPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseMs = 0;
    this.emit();
  }

  /**
   * Ask the sender for a connection. Repeating it is safe: the same `attempt` never makes the sender start over,
   * it only resends its offer.
   */
  private sendJoin(): void {
    if (this.isFinal) return;
    this.lastJoinAt = Date.now();
    this.signaling.send({ t: 'join', code: this.code, clientId: this.clientId, attempt: this.attempt });
  }

  /** Ask again if the last join (or the offer it asked for) may have been lost on the way. */
  private rejoinIfDue(): void {
    if (!this.signaling.reliable && Date.now() - this.lastJoinAt >= JOIN_RETRY_MS) this.sendJoin();
  }

  /** Once a second while connecting: move on, repeat, retry or give up. */
  private tick(): void {
    if (!this.connecting || this.isFinal) return this.endConnect();
    if (document.visibilityState === 'hidden') return; // timers are throttled and nothing can happen anyway
    this.episodeMs += 1000;
    this.phaseMs += 1000;
    switch (this.phase) {
      case 'signaling':
        if (this.signaling.isOpen) {
          this.setPhase('looking');
          this.rejoinIfDue();
        } else if (this.phaseMs >= SIGNALING_TIMEOUT_MS) {
          return this.giveUp(
            'network',
            'Couldn’t reach the signaling servers that introduce you to the sender. Check your internet connection, then try again.',
          );
        }
        break;
      case 'looking':
        if (!this.signaling.isOpen) {
          this.setPhase('signaling');
        } else if (this.phaseMs >= (this.rejoining ? RELOOKING_TIMEOUT_MS : LOOKING_TIMEOUT_MS)) {
          return this.rejoining && this.batch
            ? this.giveUp(
                'host-left',
                'Lost the sender: their tab was closed or went offline before the transfer finished.',
              )
            : this.giveUp(
                'no-sender',
                'The link may have expired, or the sender’s PizzaDrop tab was closed or has gone to sleep (phones pause background tabs). Ask them to keep it open on screen, then try again.',
              );
        } else {
          this.rejoinIfDue();
        }
        break;
      case 'negotiating':
        if (this.phaseMs >= NEGOTIATE_TIMEOUT_MS) this.retryConnection('the direct connection didn’t open in time');
        // No offer yet: the sender resends it when asked again with the same attempt.
        else if (!this.link && !this.linkPending) this.rejoinIfDue();
        break;
    }
    if (this.connecting && this.episodeMs >= CONNECT_BUDGET_MS * (this.rejoining ? 2 : 1)) {
      this.giveUp(
        this.phase === 'negotiating' ? 'unreachable' : 'network',
        this.phase === 'negotiating' ? UNREACHABLE : 'Couldn’t connect to the sender. Try again in a moment.',
      );
    }
  }

  /** The peer connection failed or never opened: try once more with a fresh one, then give up. */
  private retryConnection(reason: string): void {
    if (this.attempts >= (this.rejoining ? MAX_RECONNECT_ATTEMPTS : MAX_CONNECT_ATTEMPTS)) {
      return this.giveUp('unreachable', UNREACHABLE);
    }
    this.attempts++;
    this.attempt = randomId(6);
    console.warn(`[receiver] ${reason}; trying a fresh connection (attempt ${this.attempts})`);
    this.closeLink();
    this.phase = this.signaling.isOpen ? 'looking' : 'signaling';
    this.phaseMs = 0;
    this.sendJoin();
    this.emit();
  }

  private giveUp(kind: ReceiveErrorKind, message: string): void {
    this.endConnect();
    if (this.status === 'done') return this.senderGone(); // everything asked for already arrived
    this.fail(kind, message);
  }

  private onSignal(msg: ServerMessage): void {
    if (this.isFinal) return;
    switch (msg.t) {
      case 'signal':
        this.onRemoteSignal(msg.data);
        return;
      case 'joined':
        // The sender (or the server, for it) knows we're here: an offer is on its way.
        if (this.connecting && this.phase !== 'negotiating') this.setPhase('negotiating');
        return;
      case 'error':
        if (msg.code === 'not-found') {
          if (this.status === 'done') return this.senderGone();
          this.fail(
            this.batch ? 'host-left' : 'not-found',
            this.batch
              ? 'The sender closed their tab before the transfer finished.'
              : 'This link has expired or never existed.',
          );
        } else if (msg.code === 'room-full' || msg.code === 'rate-limited' || msg.code === 'server-error') {
          this.fail('network', msg.message);
        }
        return;
      case 'host-left':
        // If the data channel is still up, let it finish/close on its own.
        if (this.status === 'done') return this.senderGone();
        if (!this.isChannelOpen) {
          this.fail(
            'host-left',
            this.batch ? 'The sender closed their tab before the transfer finished.' : 'The sender stopped sharing.',
          );
        }
        return;
      default:
        return;
    }
  }

  private onRemoteSignal(data: SignalPayload): void {
    if (data.kind === 'description' && data.description.type === 'offer') {
      if (data.conn !== undefined && (this.link?.conn === data.conn || this.linkPending === data.conn)) {
        // The sender resent the offer we're answering: our answer may have been lost, so send it again.
        this.link?.resendDescription();
        return;
      }
      // A fresh offer means a fresh connection (first contact, or the sender re-offering).
      this.closeLink();
      const conn = data.conn ?? randomId(6);
      this.linkPending = conn;
      if (this.connecting) this.setPhase('negotiating');
      void this.signaling.iceReady.then(() => {
        if (this.isFinal || this.linkPending !== conn) return;
        this.linkPending = null;
        const link = new PeerLink(this.signaling.iceServers, conn, (d) =>
          this.signaling.send({ t: 'signal', data: d }),
        );
        this.link = link;
        link.pc.ondatachannel = (ev) => this.setupChannel(ev.channel);
        link.pc.onconnectionstatechange = () => {
          if (this.link === link && link.pc.connectionState === 'failed') this.onConnectionLost();
        };
        const early = this.early.filter((e) => e.conn === conn);
        this.early = [];
        for (const d of [data, ...early]) {
          void link.handleSignal(d).catch((err: unknown) => console.warn('[receiver] signal error', err));
        }
      });
      return;
    }
    if (this.link?.owns(data)) {
      void this.link.handleSignal(data).catch((err: unknown) => console.warn('[receiver] signal error', err));
    } else if (data.conn !== undefined && this.early.length < 64) {
      this.early.push(data);
    }
  }

  private senderGone(): void {
    this.endConnect();
    this.hostGone = true;
    this.emit();
  }

  private setupChannel(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    // A new channel starts a new flow-control account; any half-received block is dropped.
    this.conn++;
    this.rx = 0;
    this.released = 0;
    this.lastAck = 0;
    this.block = null;
    this.awaitingManifest = true;
    dc.onmessage = (ev: MessageEvent) => {
      if (this.isFinal) return;
      if (typeof ev.data === 'string') {
        const msg = parseSenderMessage(ev.data);
        if (msg) this.onControl(msg);
      } else if (ev.data instanceof ArrayBuffer) {
        this.onChunk(ev.data);
      }
    };
    dc.onclose = () => {
      if (this.dc === dc) this.onConnectionLost();
    };
    this.dc = dc;
  }

  private onConnectionLost(): void {
    if (this.isFinal) return;
    // Still setting the connection up: that attempt failed, so make a fresh one (or give up).
    if (this.connecting) return this.retryConnection('the connection failed while opening');
    this.closeLink();
    if (this.status === 'finishing' || this.hostGone) return; // every byte is already here
    if (++this.reconnects > MAX_RECONNECTS) {
      if (this.status === 'done') return this.senderGone();
      this.fail('network', 'Lost the connection to the sender and could not get it back.');
      return;
    }
    if (this.status === 'receiving') this.status = 'reconnecting';
    else if (this.status === 'ready') this.status = 'connecting';
    this.beginConnect(true);
    // A new attempt id: the sender replaces its side of the broken connection instead of resending its offer.
    this.sendJoin();
    this.emit();
  }

  private closeLink(): void {
    this.linkPending = null;
    if (this.dc) {
      this.dc.onclose = null;
      this.dc.onmessage = null;
      this.dc.close();
      this.dc = null;
    }
    this.link?.close();
    this.link = null;
  }

  // ─── Data channel protocol ──────────────────────────────────────────────

  private onControl(msg: SenderMessage): void {
    switch (msg.type) {
      case 'manifest':
        return this.onManifest(msg.version, msg.files);
      case 'block':
        return this.onBlock(msg);
      case 'file-end':
        return this.onFileEnd(msg.seq, msg.id);
      case 'error':
        return this.fail('sender', msg.message);
    }
  }

  private onManifest(version: number, files: FileMeta[]): void {
    if (version !== PROTOCOL_VERSION) {
      this.fail(
        'sender',
        'The sender is on a different version of PizzaDrop. Ask them to reload their page and share again.',
      );
      return;
    }
    this.manifest = files;
    const reconnected = this.awaitingManifest;
    this.awaitingManifest = false;
    if (reconnected) {
      // Connected: the file list arriving is what proves the new channel works end to end.
      this.endConnect();
      this.reconnects = 0;
      if (this.status === 'connecting') this.status = 'ready';
      if (this.busy && this.batch) {
        // Back after a drop: make sure it's the same share, then resume from the last verified block.
        const offered = new Map(files.map((f) => [f.id, f]));
        const same = this.batch.files.every((f) => {
          const o = offered.get(f.id);
          return o && o.name === f.name && o.size === f.size;
        });
        if (!same) {
          this.fail('sender', 'The files being shared changed. Reload to download the new ones.');
          return;
        }
        if (this.status === 'reconnecting') this.status = 'receiving';
        this.request(this.batch);
      }
    }
    this.emit();
  }

  /** (Re)request the batch from its first unverified byte, superseding any earlier request. */
  private request(batch: Batch): void {
    this.seq++;
    const a = this.block;
    if (a && !a.stale) {
      this.releaseFrom(a.conn, a.filled);
      a.stale = true;
      a.buf = null;
    }
    const pos = batch.done;
    for (const [p, f] of batch.incoming) if (p >= pos) f.assembled = f.verified;
    batch.cursor = pos;
    const resumeAt = batch.incoming.get(pos)?.verified ?? 0;
    batch.progress = batch.files.slice(0, pos).reduce((a, f) => a + f.size, 0) + resumeAt;
    this.meter.reset();
    if (pos >= batch.files.length) return;
    this.sendControl({
      type: 'request',
      seq: this.seq,
      files: batch.files.slice(pos).map((f) => f.id),
      offset: resumeAt,
      written: batch.written,
      total: batch.total,
    });
  }

  private onBlock(msg: Extract<SenderMessage, { type: 'block' }>): void {
    const prev = this.block;
    if (prev && !prev.stale) {
      this.fail('sender', 'The sender started a new block before finishing the last one.');
      return;
    }
    const batch = this.batch;
    if (!batch || msg.seq !== this.seq || !this.busy) {
      // Answer to a request we've since replaced: count its bytes as they arrive and drop them.
      this.block = { ...msg, stale: true, conn: this.conn, pos: -1, buf: null, filled: 0 };
      return;
    }
    const pos = batch.cursor;
    const meta = batch.files[pos];
    const file = this.file(batch, pos);
    if (!meta || msg.id !== meta.id) {
      this.fail('sender', 'The sender sent files out of order.');
      return;
    }
    if (msg.offset !== file.assembled || msg.offset + msg.size > meta.size) {
      this.fail('sender', 'The sender sent a block out of order.');
      return;
    }
    file.assembled += msg.size;
    this.block = { ...msg, stale: false, conn: this.conn, pos, buf: new Uint8Array(msg.size), filled: 0 };
  }

  private onChunk(buf: ArrayBuffer): void {
    const n = buf.byteLength;
    this.rx += n;
    this.activity++;
    const a = this.block;
    if (!a) {
      this.fail('sender', 'The sender sent data it hadn’t announced.');
      return;
    }
    if (a.filled + n > a.size) {
      this.fail('sender', 'The sender sent more data than announced.');
      return;
    }
    a.filled += n;
    if (a.stale || !a.buf) {
      this.release(n);
    } else {
      a.buf.set(new Uint8Array(buf), a.filled - n);
      this.batch!.progress += n;
      this.meter.push(this.batch!.progress);
      this.emitSoon();
    }
    if (a.filled === a.size) {
      this.block = null;
      if (!a.stale) this.check(a);
    }
  }

  /** Verify a complete block, then hand it to the sink — in arrival order, while later blocks keep arriving. */
  private check(a: Assembly): void {
    const batch = this.batch!;
    const bytes = a.buf!;
    const digest = sha256Hex(bytes);
    digest.catch(() => undefined);
    this.afterChecks(async () => {
      const actual = await digest;
      if (this.isFinal) return;
      if (a.seq !== this.seq || this.batch !== batch) {
        this.releaseFrom(a.conn, a.size);
        return;
      }
      if (actual !== a.sha256) {
        this.releaseFrom(a.conn, a.size);
        this.onBadBlock(batch, a);
        return;
      }
      this.activity++;
      const file = this.file(batch, a.pos);
      file.verified += a.size;
      file.push(bytes, a.conn);
    });
  }

  private onBadBlock(batch: Batch, a: Assembly): void {
    const meta = batch.files[a.pos]!;
    const key = `${batch.n}:${a.pos}:${a.offset}`;
    const tries = (this.retries.get(key) ?? 0) + 1;
    this.retries.set(key, tries);
    if (tries > MAX_BLOCK_RETRIES) {
      this.fail(
        'integrity',
        `"${meta.name}" kept failing its integrity check (SHA-256 mismatch), so the download was stopped and discarded.`,
      );
      return;
    }
    this.repaired++;
    console.warn(`[receiver] block at ${a.offset} of "${meta.name}" failed its SHA-256 check; fetching it again`);
    this.request(batch);
    this.emit();
  }

  private onFileEnd(seq: number, id: number): void {
    const batch = this.batch;
    if (!batch || seq !== this.seq || !this.busy) return; // from a superseded request
    if (this.block && !this.block.stale) {
      this.fail('sender', 'The sender ended a file in the middle of a block.');
      return;
    }
    this.block = null;
    const pos = batch.cursor;
    const meta = batch.files[pos];
    if (!meta || meta.id !== id) {
      this.fail('sender', 'The sender sent files out of order.');
      return;
    }
    const file = this.file(batch, pos);
    if (file.assembled !== meta.size) {
      this.fail('integrity', `"${meta.name}" arrived with the wrong size.`);
      return;
    }
    batch.cursor++;
    this.afterChecks(() => {
      // A failed block in this file restarts the request, and this end is then moot.
      if (this.isFinal || seq !== this.seq || this.batch !== batch) return;
      file.end();
      batch.done++;
      if (batch.done === batch.files.length) {
        this.status = 'finishing';
        this.emit();
      }
    });
  }

  /** Watch a download for stalls (see {@link STALL_MS}). */
  private watch(batch: Batch): void {
    clearInterval(this.watchdog);
    this.stall = { activity: -1, since: 0, recoveries: 0, written: batch.written };
    this.watchdog = setInterval(() => this.checkStall(batch), STALL_MS / 4);
  }

  private checkStall(batch: Batch): void {
    const now = performance.now();
    const s = this.stall;
    // Only a download that should be flowing counts: not while reconnecting, not once every byte is in.
    if (this.status !== 'receiving' || this.batch !== batch || !this.isChannelOpen || s.activity !== this.activity) {
      s.activity = this.activity;
      s.since = now;
      return;
    }
    if (now - s.since < STALL_MS) return;
    if (batch.written > s.written) {
      s.written = batch.written;
      s.recoveries = 0;
    }
    if (++s.recoveries > MAX_STALL_RECOVERIES) {
      this.fail('network', 'The download stopped making progress. Try again.');
      return;
    }
    console.warn(
      `[receiver] no progress for ${STALL_MS / 1000} s; reconnecting to resume from the last verified block`,
    );
    s.activity = -1;
    // Start the checks afresh: whatever was pending belongs to the old request and is dropped when it settles.
    this.verifying = Promise.resolve();
    this.onConnectionLost();
  }

  /**
   * Run `step` after every earlier check, in arrival order. An exception becomes a visible error: left alone, one
   * rejected step would silently skip every later one and stall the download.
   */
  private afterChecks(step: () => void | Promise<void>): void {
    this.verifying = this.verifying.then(step).catch((err: unknown) => {
      console.error('[receiver] block check failed', err);
      this.fail('integrity', `Couldn't check the download: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Count `n` bytes of channel `conn` as finished with (written or dropped), and ack when due. */
  private releaseFrom(conn: number, n: number): void {
    if (conn === this.conn) this.release(n);
  }

  private release(n: number): void {
    this.released += n;
    if (this.released - this.lastAck >= ACK_EVERY || this.released === this.rx) {
      this.lastAck = this.released;
      this.sendControl({
        type: 'ack',
        bytes: this.released,
        written: this.batch?.written ?? 0,
        total: this.batch?.total ?? 0,
      });
    }
  }

  private sendControl(msg: ReceiverMessage): void {
    const dc = this.dc;
    if (dc?.readyState !== 'open') return;
    try {
      dc.send(JSON.stringify(msg));
    } catch (err) {
      // The channel is going away (its state lags behind); reconnecting takes it from here.
      console.warn('[receiver] could not send', msg.type, err);
    }
  }

  // ─── Files / sink ───────────────────────────────────────────────────────

  private file(batch: Batch, pos: number): IncomingFile {
    let f = batch.incoming.get(pos);
    if (!f) {
      f = new IncomingFile((bytes, conn) => {
        batch.written += bytes;
        this.activity++;
        this.releaseFrom(conn, bytes);
      });
      batch.incoming.set(pos, f);
    }
    return f;
  }

  private async *zipEntries(batch: Batch) {
    const names = uniqueNames(batch.files.map((f) => sanitizeName(f.name)));
    for (let i = 0; i < batch.files.length; i++) {
      const meta = batch.files[i]!;
      yield {
        name: names[i]!,
        size: meta.size,
        lastModified: new Date(meta.lastModified),
        input: this.file(batch, i).readable,
      };
      // Resumed only once file i has been fully zipped: release it so memory
      // stays flat even with thousands of files.
      batch.incoming.delete(i);
    }
  }

  private finish(batch: Batch): void {
    if (this.isFinal || this.batch !== batch) return;
    clearInterval(this.watchdog);
    for (const f of batch.files) this.downloaded.add(f.id);
    this.status = 'done';
    // Stay connected: the sender may add more files later.
    this.sendControl({ type: 'done' });
    this.emit();
  }

  private fail(kind: ReceiveErrorKind, message: string): void {
    if (this.isFinal) return;
    clearInterval(this.watchdog);
    this.endConnect();
    this.status = 'error';
    this.error = { kind, message };
    const reason = new Error(message);
    this.batch?.incoming.forEach((f) => f.fail(reason));
    this.emit();
    if (kind !== 'save' && kind !== 'integrity') return;
    this.sendControl({ type: 'cancel' });
  }

  // ─── Snapshots ──────────────────────────────────────────────────────────

  private emitSoon(): void {
    if (this.emitTimer !== undefined) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit();
    }, 100);
  }

  private emit(): void {
    const active = this.status === 'receiving';
    const batch = this.batch;
    const pending = this.pending();
    this.onChange({
      status: this.status,
      files: this.manifest,
      pending,
      pendingBytes: pending.reduce((a, f) => a + f.size, 0),
      downloadedCount: this.downloaded.size,
      batch: batch && {
        n: batch.n,
        files: batch.files,
        saveName: batch.saveName,
        total: batch.total,
        bytes: batch.progress,
        fileIndex: Math.min(batch.cursor, batch.files.length - 1),
        verified: batch.done,
      },
      speed: active ? this.meter.bytesPerSecond : 0,
      eta: active && batch ? this.meter.eta(batch.total) : Infinity,
      sinkKind: this.sinkKind,
      repaired: this.repaired,
      hostGone: this.hostGone,
      connect: this.connecting ? { phase: this.phase, attempt: this.attempts } : null,
      error: this.error,
    });
  }
}

/**
 * One incoming file as a pull-based ReadableStream of verified blocks: a
 * block is handed to the sink only when it asks for more, and each hand-off is
 * reported so the sender can be acknowledged (end-to-end flow control).
 */
class IncomingFile {
  /** Bytes announced and accepted for this file (including blocks still arriving or being checked). */
  assembled = 0;
  /** Bytes that passed their check. */
  verified = 0;
  private queue: Array<{ bytes: Uint8Array; conn: number }> = [];
  private ended = false;
  private error: Error | null = null;
  private readonly changed = new Notifier();
  readonly readable: ReadableStream<Uint8Array>;

  constructor(onConsumed: (bytes: number, conn: number) => void) {
    this.readable = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (this.queue.length === 0 && !this.ended && !this.error) await this.changed.wait();
          if (this.error) {
            controller.error(this.error);
            return;
          }
          const item = this.queue.shift();
          if (item) {
            controller.enqueue(item.bytes);
            onConsumed(item.bytes.byteLength, item.conn);
            return;
          }
          controller.close();
        },
        cancel: (reason) => {
          this.fail(reason instanceof Error ? reason : new Error(String(reason)));
        },
      },
      { highWaterMark: 0 },
    );
  }

  push(bytes: Uint8Array, conn: number): void {
    this.queue.push({ bytes, conn });
    this.changed.notify();
  }

  end(): void {
    this.ended = true;
    this.changed.notify();
  }

  fail(err: Error): void {
    if (this.error) return;
    this.error = err;
    this.queue = [];
    this.changed.notify();
  }
}
