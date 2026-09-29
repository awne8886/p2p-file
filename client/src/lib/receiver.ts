import { makeZip, predictLength } from 'client-zip';
import {
  parseSenderMessage,
  type FileMeta,
  type ReceiverMessage,
  type SenderMessage,
  type ServerMessage,
} from '@pizzadrop/shared';
import { ACK_EVERY, CONNECT_TIMEOUT_MS, MAX_RECONNECTS, WINDOW } from './constants';
import { Notifier } from './flow';
import { StreamHasher } from './hasher';
import { randomId } from './ids';
import { sanitizeName, uniqueNames } from './names';
import { PeerLink } from './rtc';
import { SignalingClient } from './signaling';
import type { Sink, SinkKind } from './sinks';
import { SpeedMeter } from './speed';

export type ReceiveStatus = 'connecting' | 'ready' | 'receiving' | 'reconnecting' | 'finishing' | 'done' | 'error';

export type ReceiveErrorKind =
  'not-found' | 'host-left' | 'unreachable' | 'integrity' | 'sender' | 'save' | 'network' | 'cancelled';

export interface ReceiveSnapshot {
  status: ReceiveStatus;
  files: FileMeta[] | null;
  /** Name the download is saved under (the file itself, or a .zip for several). */
  saveName: string | null;
  totalBytes: number;
  bytes: number;
  speed: number;
  eta: number;
  fileIndex: number;
  verified: number;
  sinkKind: SinkKind | null;
  error: { kind: ReceiveErrorKind; message: string } | null;
}

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

/**
 * The receiving side: connects to the sender behind `code`, shows the
 * manifest, and on {@link start} streams every file into the chosen sink,
 * verifying each file's SHA-256 against the digest the sender announces.
 * If the connection drops mid-transfer it reconnects and resumes from the
 * exact byte it stopped at.
 */
export class Receiver {
  private readonly signaling: SignalingClient;
  private readonly clientId = tabClientId();
  private link: PeerLink | null = null;
  private dc: RTCDataChannel | null = null;
  private hasher: StreamHasher | null = null;
  private readonly meter = new SpeedMeter();

  private status: ReceiveStatus = 'connecting';
  private error: ReceiveSnapshot['error'] = null;
  private files: FileMeta[] | null = null;
  private totalBytes = 0;
  private sinkKind: SinkKind | null = null;
  private started = false;

  private readonly incoming = new Map<number, IncomingFile>();
  /** File currently being received from the network, or -1 between files. */
  private currentIndex = -1;
  /** Next file to request once the backlog allows it. */
  private pendingNext: number | null = null;
  private received = 0;
  private consumed = 0;
  private verified = 0;

  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnects = 0;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly code: string,
    private readonly onChange: (snapshot: ReceiveSnapshot) => void,
  ) {
    this.signaling = new SignalingClient({
      onReady: () => {
        // Only (re)join when we actually need a peer connection: re-joining
        // while the data channel is healthy would make the sender replace it.
        if (!this.isChannelOpen && !this.isFinal) this.join();
      },
      onMessage: (msg) => this.onSignal(msg),
    });
  }

  connect(): void {
    this.signaling.connect();
    this.emit();
  }

  /** Begin downloading into `sink`. */
  start(sink: Sink): void {
    if (this.started || !this.files) return;
    this.started = true;
    this.sinkKind = sink.kind;
    this.status = 'receiving';
    this.hasher = new StreamHasher();

    const files = this.files;
    const source =
      files.length === 1 ? this.file(0).readable : makeZip(this.zipEntries(files), { buffersAreUTF8: true });

    this.pendingNext = 0;
    this.maybeRequestNext();

    source.pipeTo(sink.writable).then(
      () => this.finish(),
      (err: unknown) => {
        if (this.status === 'error') return;
        const message = err instanceof Error ? err.message : String(err);
        this.fail('save', `Saving failed: ${message}`);
      },
    );
    this.emit();
  }

  /** Stop the download (the partial file is discarded where the sink allows it). */
  cancel(): void {
    if (this.isFinal) return;
    this.sendControl({ type: 'cancel' });
    this.fail('cancelled', 'Download cancelled.');
  }

  /** Tear everything down (component unmount). */
  destroy(): void {
    clearTimeout(this.connectTimer);
    clearTimeout(this.emitTimer);
    this.signaling.send({ t: 'leave' });
    this.signaling.close();
    this.closeLink();
    this.hasher?.terminate();
    for (const f of this.incoming.values()) f.fail(new DOMException('closed', 'AbortError'));
  }

  get saveName(): string | null {
    if (!this.files) return null;
    if (this.files.length === 1) return sanitizeName(this.files[0]!.name);
    return `pizzadrop-${this.code}.zip`;
  }

  /** Byte length of what will be saved (the zip's exact size for several files). */
  get saveSize(): number | null {
    if (!this.files) return null;
    if (this.files.length === 1) return this.totalBytes;
    const names = uniqueNames(this.files.map((f) => sanitizeName(f.name)));
    return Number(predictLength(this.files.map((f, i) => ({ name: names[i]!, size: f.size }))));
  }

  get saveMime(): string {
    if (!this.files) return 'application/octet-stream';
    return this.files.length === 1 ? this.files[0]!.type || 'application/octet-stream' : 'application/zip';
  }

  private get isChannelOpen(): boolean {
    return this.dc?.readyState === 'open';
  }

  private get isFinal(): boolean {
    return this.status === 'done' || this.status === 'error';
  }

  // ─── Signaling / connection ─────────────────────────────────────────────

  private join(): void {
    this.signaling.send({ t: 'join', code: this.code, clientId: this.clientId });
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.isChannelOpen || this.isFinal) return;
      this.fail(
        'unreachable',
        "Couldn't connect to the sender directly. One of you may be behind a strict firewall or NAT; the site operator can fix this by adding a TURN server.",
      );
    }, CONNECT_TIMEOUT_MS);
  }

  private onSignal(msg: ServerMessage): void {
    if (this.isFinal) return;
    switch (msg.t) {
      case 'signal':
        if (msg.data.kind === 'description' && msg.data.description.type === 'offer') {
          // A fresh offer means a fresh connection (first contact, or the sender re-offering).
          this.closeLink();
          this.link = new PeerLink(this.signaling.iceServers, (data) => this.signaling.send({ t: 'signal', data }));
          this.link.pc.ondatachannel = (ev) => this.setupChannel(ev.channel);
          this.link.pc.onconnectionstatechange = () => {
            if (this.link?.pc.connectionState === 'failed') this.onConnectionLost();
          };
        }
        void this.link?.handleSignal(msg.data).catch((err: unknown) => console.warn('[receiver] signal error', err));
        return;
      case 'error':
        if (msg.code === 'not-found') {
          this.fail(
            this.started ? 'host-left' : 'not-found',
            this.started
              ? 'The sender closed their tab before the transfer finished.'
              : 'This link has expired or never existed.',
          );
        } else if (msg.code === 'room-full' || msg.code === 'rate-limited') {
          this.fail('network', msg.message);
        }
        return;
      case 'host-left':
        // If the data channel is still up, let it finish/close on its own.
        if (!this.isChannelOpen) {
          this.fail(
            'host-left',
            this.started ? 'The sender closed their tab before the transfer finished.' : 'The sender stopped sharing.',
          );
        }
        return;
      default:
        return;
    }
  }

  private setupChannel(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      clearTimeout(this.connectTimer);
    };
    dc.onmessage = (ev: MessageEvent) => {
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
    this.closeLink();
    if (this.status === 'finishing') return; // every byte is already here
    if (++this.reconnects > MAX_RECONNECTS) {
      this.fail('network', 'Lost the connection to the sender and could not get it back.');
      return;
    }
    this.status = this.started ? 'reconnecting' : 'connecting';
    this.emit();
    const delay = 500 * this.reconnects;
    setTimeout(() => {
      if (this.isFinal || this.isChannelOpen) return;
      if (this.signaling.isOpen) this.join();
      // Otherwise the signaling client is reconnecting and will join in onReady.
    }, delay);
  }

  private closeLink(): void {
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
        return this.onManifest(msg.files);
      case 'file-end':
        return this.onFileEnd(msg.index, msg.sha256);
      case 'error':
        return this.fail('sender', msg.message);
    }
  }

  private onManifest(files: FileMeta[]): void {
    if (this.files) {
      // Reconnected: make sure it's the same share, then resume where we were.
      if (!sameManifest(this.files, files)) {
        this.fail('sender', 'The files being shared changed. Reload to download the new ones.');
        return;
      }
      this.reconnects = 0;
      if (this.started) {
        this.status = 'receiving';
        if (this.currentIndex >= 0) {
          this.sendControl({
            type: 'request',
            index: this.currentIndex,
            offset: this.file(this.currentIndex).received,
          });
        } else {
          this.maybeRequestNext();
        }
      } else {
        this.status = 'ready';
      }
      this.emit();
      return;
    }
    this.files = files;
    this.totalBytes = files.reduce((a, f) => a + f.size, 0);
    this.status = 'ready';
    this.emit();
  }

  private onChunk(buf: ArrayBuffer): void {
    if (!this.started || !this.files || this.currentIndex < 0 || this.isFinal) return;
    const meta = this.files[this.currentIndex]!;
    const file = this.file(this.currentIndex);
    if (file.received + buf.byteLength > meta.size) {
      this.fail('sender', 'The sender sent more data than announced.');
      return;
    }
    file.received += buf.byteLength;
    this.received += buf.byteLength;
    this.hasher!.update(buf);
    file.push(new Uint8Array(buf));
    this.meter.push(this.received);
    this.emitSoon();
  }

  private onFileEnd(index: number, expected: string): void {
    if (!this.files || index !== this.currentIndex) {
      this.fail('sender', 'The sender sent files out of order.');
      return;
    }
    const meta = this.files[index]!;
    const file = this.file(index);
    if (file.received !== meta.size) {
      this.fail('integrity', `"${meta.name}" arrived with the wrong size.`);
      return;
    }
    // digest() is queued behind every update() for this file, so posting it
    // now (before any bytes of the next file) keeps the hashes separate.
    const digest = this.hasher!.digest();
    this.currentIndex = -1;
    this.pendingNext = index + 1 < this.files.length ? index + 1 : null;

    digest.then(
      (actual) => {
        if (this.isFinal) return;
        if (actual !== expected) {
          this.fail(
            'integrity',
            `"${meta.name}" failed its integrity check (SHA-256 mismatch). The download was discarded.`,
          );
          return;
        }
        this.verified++;
        file.end();
        if (this.verified === this.files!.length) {
          this.status = 'finishing';
          this.emit();
        }
      },
      (err: unknown) => this.fail('integrity', `Couldn't verify "${meta.name}": ${String(err)}`),
    );
    this.maybeRequestNext();
  }

  /** Ask for the next file, unless too many received bytes are still waiting to be written. */
  private maybeRequestNext(): void {
    if (this.pendingNext === null || !this.isChannelOpen || this.isFinal) return;
    if (this.received - this.consumed > WINDOW / 2) return;
    const index = this.pendingNext;
    this.pendingNext = null;
    this.currentIndex = index;
    this.sendControl({ type: 'request', index, offset: this.file(index).received });
  }

  private onConsumed(index: number, file: IncomingFile, bytes: number): void {
    this.consumed += bytes;
    const size = this.files?.[index]?.size ?? 0;
    if (index === this.currentIndex && (file.consumed - file.lastAck >= ACK_EVERY || file.consumed === size)) {
      file.lastAck = file.consumed;
      this.sendControl({ type: 'ack', index, bytes: file.consumed });
    }
    this.maybeRequestNext();
  }

  private sendControl(msg: ReceiverMessage): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg));
  }

  // ─── Files / sink ───────────────────────────────────────────────────────

  private file(index: number): IncomingFile {
    let f = this.incoming.get(index);
    if (!f) {
      const created = new IncomingFile((n) => this.onConsumed(index, created, n));
      this.incoming.set(index, created);
      f = created;
    }
    return f;
  }

  private async *zipEntries(files: FileMeta[]) {
    const names = uniqueNames(files.map((f) => sanitizeName(f.name)));
    for (let i = 0; i < files.length; i++) {
      const meta = files[i]!;
      yield {
        name: names[i]!,
        size: meta.size,
        lastModified: new Date(meta.lastModified),
        input: this.file(i).readable,
      };
      // Resumed only once file i has been fully zipped: release it so memory
      // stays flat even with thousands of files.
      this.incoming.delete(i);
    }
  }

  private finish(): void {
    if (this.isFinal) return;
    this.status = 'done';
    this.sendControl({ type: 'done' });
    this.emit();
    // Let the 'done' message flush before tearing the connection down.
    setTimeout(() => {
      this.signaling.send({ t: 'leave' });
      this.signaling.close();
      this.closeLink();
      this.hasher?.terminate();
    }, 1000);
  }

  private fail(kind: ReceiveErrorKind, message: string): void {
    if (this.isFinal) return;
    this.status = 'error';
    this.error = { kind, message };
    clearTimeout(this.connectTimer);
    const reason = new Error(message);
    for (const f of this.incoming.values()) f.fail(reason);
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
    this.onChange({
      status: this.status,
      files: this.files,
      saveName: this.saveName,
      totalBytes: this.totalBytes,
      bytes: this.received,
      speed: active ? this.meter.bytesPerSecond : 0,
      eta: active ? this.meter.eta(this.totalBytes) : Infinity,
      fileIndex: Math.max(0, this.currentIndex),
      verified: this.verified,
      sinkKind: this.sinkKind,
      error: this.error,
    });
  }
}

/**
 * One incoming file as a pull-based ReadableStream: chunks are handed to the
 * sink only when it asks for more, and each hand-off is reported so the sender
 * can be acknowledged (end-to-end flow control).
 */
class IncomingFile {
  received = 0;
  consumed = 0;
  lastAck = 0;
  private queue: Uint8Array[] = [];
  private ended = false;
  private error: Error | null = null;
  private readonly changed = new Notifier();
  readonly readable: ReadableStream<Uint8Array>;

  constructor(onConsumed: (bytes: number) => void) {
    this.readable = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (this.queue.length === 0 && !this.ended && !this.error) await this.changed.wait();
          if (this.error) {
            controller.error(this.error);
            return;
          }
          const chunk = this.queue.shift();
          if (chunk) {
            controller.enqueue(chunk);
            this.consumed += chunk.byteLength;
            onConsumed(chunk.byteLength);
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

  push(chunk: Uint8Array): void {
    this.queue.push(chunk);
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

function sameManifest(a: FileMeta[], b: FileMeta[]): boolean {
  return a.length === b.length && a.every((f, i) => f.name === b[i]!.name && f.size === b[i]!.size);
}
