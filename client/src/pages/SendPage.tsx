import { formatBytes, formatDuration, formatSpeed } from '@pizzadrop/shared';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AsciiProgress } from '../components/AsciiProgress';
import { QrCode } from '../components/QrCode';
import { ShareLink } from '../components/ShareLink';
import { useBeforeUnload } from '../hooks/useBeforeUnload';
import { useSideLayout } from '../hooks/useSideLayout';
import { Host, type HostSnapshot, type ReceiverSnapshot } from '../lib/sender';

interface Props {
  setEnergy(energy: number): void;
}

/** Collect dropped files, rejecting folders (which show up as zero-byte "files"). */
function filesFromDrop(dt: DataTransfer): { files: File[]; hadFolder: boolean } {
  const files: File[] = [];
  let hadFolder = false;
  const items = Array.from(dt.items ?? []);
  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        hadFolder = true;
        continue;
      }
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  } else {
    files.push(...Array.from(dt.files));
  }
  return { files, hadFolder };
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

export function SendPage({ setEnergy }: Props) {
  const [host, setHost] = useState<Host | null>(null);
  const [snap, setSnap] = useState<HostSnapshot | null>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const share = useCallback(
    (files: File[]) => {
      if (files.length === 0 || host) return;
      setNotice(null);
      const h = new Host(files, setSnap);
      setHost(h);
      h.start();
    },
    [host],
  );

  const reset = () => {
    host?.stop();
    setHost(null);
    setSnap(null);
  };

  // Whole-window drag & drop.
  useEffect(() => {
    if (host) return;
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const { files, hadFolder } = filesFromDrop(e.dataTransfer);
      if (hadFolder) {
        setNotice(
          files.length > 0
            ? 'Folders were skipped — zip them first to send them.'
            : 'Folders can’t be sent directly — zip it first, or drop the files inside.',
        );
      }
      share(files);
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) share(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
    };
  }, [host, share]);

  // Release the code as soon as the tab goes away (not just after the server notices).
  useEffect(() => {
    if (!host) return;
    const onPageHide = () => host.stop();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [host]);

  const transferring = snap?.receivers.some((r) => r.status === 'receiving') ?? false;
  const hosting = host !== null && snap?.status !== 'stopped';
  useBeforeUnload(hosting);

  useEffect(() => {
    setEnergy(dragging ? 1 : transferring ? 0.5 : 0);
  }, [dragging, transferring, setEnergy]);

  if (!host || !snap) {
    const pick = () => inputRef.current?.click();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    };
    return (
      <>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = '';
            share(files);
          }}
        />
        <main
          className={`dropzone${dragging ? ' dropzone--active' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Choose files to share, or drop them anywhere on the page"
          onClick={pick}
          onKeyDown={onKey}
          data-testid="dropzone"
        >
          <div className="panel panel--intro" onClick={(e) => e.stopPropagation()}>
            <p className="intro__title">{dragging ? 'release to share' : 'drop files anywhere'}</p>
            <button type="button" className="btn btn--primary" onClick={pick}>
              choose files
            </button>
            <p className="intro__sub">
              Sent straight from your browser to theirs. No size limit, no sign-up, nothing stored on a server.
            </p>
            {notice && (
              <p className="notice notice--warn" role="alert">
                {notice}
              </p>
            )}
          </div>
        </main>
      </>
    );
  }

  return <HostingCard snap={snap} onStop={reset} notice={notice} />;
}

function statusLine(snap: HostSnapshot): { text: string; tone: 'live' | 'wait' | 'bad' } {
  switch (snap.status) {
    case 'connecting':
      return { text: 'getting a link…', tone: 'wait' };
    case 'live':
      return { text: 'live — keep this tab open', tone: 'live' };
    case 'reconnecting':
      return { text: 'reconnecting to the server… transfers in progress continue', tone: 'wait' };
    case 'expired':
      return { text: 'link expired (idle too long) — drop again to reshare', tone: 'bad' };
    case 'stopped':
      return { text: 'stopped', tone: 'bad' };
    case 'error':
      return { text: snap.error ?? 'could not reach the server', tone: 'bad' };
  }
}

function HostingCard({ snap, onStop, notice }: { snap: HostSnapshot; onStop(): void; notice: string | null }) {
  const side = useSideLayout();
  const status = statusLine(snap);
  const fileCount = snap.files.length;
  const hashing = snap.hashedBytes < snap.totalBytes;
  const doneCount = snap.receivers.filter((r) => r.status === 'done').length;

  return (
    <main className={side ? 'stage stage--side' : 'stage'}>
      <section className="panel panel--card" aria-labelledby="share-heading" data-testid="hosting-card">
        <header className="card__header">
          <h1 id="share-heading" className="card__title">
            {fileCount === 1 ? snap.files[0]!.name : `${fileCount} files`}
          </h1>
          <p className="card__meta">
            {formatBytes(snap.totalBytes)}
            {fileCount > 1 && ' · zipped on the receiver’s side'}
          </p>
          {fileCount > 1 && (
            <details className="file-list">
              <summary>show files</summary>
              <ul>
                {snap.files.map((f, i) => (
                  <li key={i}>
                    <span className="file-list__name">{f.name}</span>
                    <span className="file-list__size">{formatBytes(f.size)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </header>

        <p className={`status status--${status.tone}`} role="status" data-testid="host-status">
          <span className="status__dot" aria-hidden="true" />
          {status.text}
        </p>

        {snap.url ? (
          <>
            <ShareLink url={snap.url} />
            <div className="qr-wrap">
              <QrCode value={snap.url} size={232} />
              <p className="qr-caption">scan to receive</p>
            </div>
          </>
        ) : (
          <p className="placeholder">▌</p>
        )}

        <p className="notice">
          <strong>Keep this tab open.</strong> Files stream directly from this tab to each receiver; closing it ends the
          share.
        </p>

        {hashing && (
          <p className="fine">
            fingerprinting (SHA-256) {Math.floor((snap.hashedBytes / Math.max(1, snap.totalBytes)) * 100)}%
          </p>
        )}

        <section className="receivers" aria-label="Receivers">
          <h2 className="receivers__title">
            receivers{' '}
            <span className="receivers__count">
              {snap.receivers.filter(isConnected).length} connected
              {doneCount > 0 && ` · ${doneCount} done`}
            </span>
          </h2>
          {snap.receivers.length === 0 ? (
            <p className="fine">Nobody yet. Send them the link or let them scan the code.</p>
          ) : (
            <ul className="receivers__list">
              {snap.receivers.map((r) => (
                <ReceiverRow key={r.id} r={r} />
              ))}
            </ul>
          )}
        </section>

        {notice && <p className="notice notice--warn">{notice}</p>}

        <div className="card__footer">
          <button type="button" className="btn btn--ghost" onClick={onStop} data-testid="stop-sharing">
            {snap.status === 'expired' || snap.status === 'error' ? 'start over' : 'stop sharing'}
          </button>
        </div>
      </section>
    </main>
  );
}

const isConnected = (r: ReceiverSnapshot) => r.status === 'connected' || r.status === 'receiving';

const RECEIVER_STATUS: Record<ReceiverSnapshot['status'], string> = {
  connecting: 'connecting…',
  connected: 'connected, waiting to start',
  receiving: 'downloading',
  done: 'done ✓',
  disconnected: 'disconnected',
  failed: 'failed',
};

function ReceiverRow({ r }: { r: ReceiverSnapshot }) {
  return (
    <li className={`receiver receiver--${r.status}`} data-testid="receiver-row" data-status={r.status}>
      <div className="receiver__head">
        <span className="receiver__name">receiver {r.n}</span>
        <span className="receiver__state">{RECEIVER_STATUS[r.status]}</span>
      </div>
      {(r.status === 'receiving' || r.status === 'done' || r.bytes > 0) && (
        <AsciiProgress value={r.bytes} max={r.total} label={`Receiver ${r.n} progress`} />
      )}
      {r.status === 'receiving' && (
        <p className="receiver__stats">
          {formatBytes(r.bytes)} of {formatBytes(r.total)} · {formatSpeed(r.speed)} ·{' '}
          {Number.isFinite(r.eta) ? `${formatDuration(r.eta)} left` : 'estimating…'}
        </p>
      )}
      {r.error && r.status !== 'done' && <p className="receiver__error">{r.error}</p>}
    </li>
  );
}
