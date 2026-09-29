import { formatBytes, formatDuration, formatSpeed } from '@pizzadrop/shared';
import { useEffect, useRef, useState } from 'react';
import { AsciiProgress } from '../components/AsciiProgress';
import { useBeforeUnload } from '../hooks/useBeforeUnload';
import { useSideLayout } from '../hooks/useSideLayout';
import { BLOB_WARN_BYTES } from '../lib/constants';
import { Receiver, type ReceiveSnapshot } from '../lib/receiver';
import {
  cleanUpStagedDownloads,
  NeedsMemoryConfirmationError,
  openSink,
  SaveCancelledError,
  SINK_LABELS,
  warmUpServiceWorker,
  willBufferInMemory,
} from '../lib/sinks';

interface Props {
  code: string;
  setEnergy(energy: number): void;
}

const SPINNER = ['|', '/', '-', '\\'];

function useSpinner(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setI((n) => (n + 1) % SPINNER.length), 120);
    return () => clearInterval(t);
  }, [active]);
  return SPINNER[i]!;
}

export function ReceivePage({ code, setEnergy }: Props) {
  const side = useSideLayout();
  const receiverRef = useRef<Receiver | null>(null);
  const [snap, setSnap] = useState<ReceiveSnapshot | null>(null);
  const [opening, setOpening] = useState(false);
  const [confirmMemory, setConfirmMemory] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    warmUpServiceWorker();
    void cleanUpStagedDownloads();
    const r = new Receiver(code, setSnap);
    receiverRef.current = r;
    r.connect();
    return () => {
      r.destroy();
      receiverRef.current = null;
    };
  }, [code]);

  const status = snap?.status ?? 'connecting';
  const busy = status === 'receiving' || status === 'reconnecting' || status === 'finishing';
  useBeforeUnload(busy);
  useEffect(() => setEnergy(busy ? 0.5 : 0), [busy, setEnergy]);
  const spinner = useSpinner(status === 'connecting' || status === 'reconnecting' || status === 'finishing' || opening);

  const download = async (allowLargeMemory = false) => {
    const r = receiverRef.current;
    if (!r || !r.saveName || opening) return;
    setOpening(true);
    setSaveError(null);
    try {
      const sink = await openSink(r.saveName, r.saveSize, r.saveMime, { allowLargeMemory });
      setConfirmMemory(false);
      r.start(sink);
    } catch (err) {
      if (err instanceof NeedsMemoryConfirmationError) setConfirmMemory(true);
      else if (!(err instanceof SaveCancelledError)) setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };

  return (
    <main className={side ? 'stage stage--side' : 'stage'}>
      <section className="panel panel--card" aria-live="polite" data-testid="receive-card" data-status={status}>
        {status === 'connecting' && (
          <>
            <p className="card__title">
              <span className="spinner" aria-hidden="true">
                {spinner}
              </span>{' '}
              connecting to the sender…
            </p>
            <p className="fine">Setting up a direct, encrypted connection between your browser and theirs.</p>
          </>
        )}

        {snap?.files && status !== 'connecting' && (
          <header className="card__header">
            <h1 className="card__title" data-testid="receive-name">
              {snap.files.length === 1 ? snap.files[0]!.name : `${snap.files.length} files`}
            </h1>
            <p className="card__meta" data-testid="receive-size">
              {formatBytes(snap.totalBytes)}
              {snap.files.length > 1 && ` · saved as ${snap.saveName}`}
            </p>
            {snap.files.length > 1 && (
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
        )}

        {status === 'ready' && (
          <>
            {!confirmMemory && willBufferInMemory() && snap!.totalBytes > BLOB_WARN_BYTES && (
              <p className="notice notice--warn">
                This browser can’t stream downloads to disk, so the whole {formatBytes(snap!.totalBytes)} will be held
                in memory first. Chrome, Edge or Firefox handle large files better.
              </p>
            )}
            {confirmMemory ? (
              <div className="confirm">
                <p className="notice notice--warn">
                  Streaming to disk isn’t available here, so this {formatBytes(snap!.totalBytes)} download has to be
                  held in memory until it finishes. That may crash the tab on low-memory devices.
                </p>
                <div className="row">
                  <button type="button" className="btn btn--primary" onClick={() => void download(true)}>
                    download anyway
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirmMemory(false)}>
                    cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--primary btn--big"
                onClick={() => void download()}
                disabled={opening}
                data-testid="download"
              >
                {opening ? `${spinner} preparing…` : 'download'}
              </button>
            )}
            {saveError && <p className="notice notice--bad">{saveError}</p>}
          </>
        )}

        {(status === 'receiving' || status === 'reconnecting' || status === 'finishing') && snap && (
          <div className="transfer">
            <AsciiProgress value={snap.bytes} max={snap.totalBytes} label="Download progress" />
            <p className="receiver__stats" data-testid="receive-stats">
              {status === 'reconnecting' ? (
                <>
                  <span className="spinner">{spinner}</span> connection dropped — reconnecting and resuming…
                </>
              ) : status === 'finishing' ? (
                <>
                  <span className="spinner">{spinner}</span> verified — finishing the save…
                </>
              ) : (
                <>
                  {formatBytes(snap.bytes)} of {formatBytes(snap.totalBytes)} · {formatSpeed(snap.speed)} ·{' '}
                  {Number.isFinite(snap.eta) ? `${formatDuration(snap.eta)} left` : 'estimating…'}
                </>
              )}
            </p>
            {snap.files && snap.files.length > 1 && status === 'receiving' && (
              <p className="fine">
                file {snap.fileIndex + 1} of {snap.files.length}: {snap.files[snap.fileIndex]?.name}
              </p>
            )}
            {snap.sinkKind && <p className="fine">{SINK_LABELS[snap.sinkKind]}</p>}
            {status !== 'finishing' && (
              <button type="button" className="btn btn--ghost" onClick={() => receiverRef.current?.cancel()}>
                cancel
              </button>
            )}
          </div>
        )}

        {status === 'done' && snap && (
          <div className="done" data-testid="receive-done">
            <p className="done__title">Done ✓</p>
            <p className="fine">
              {snap.verified === 1 ? 'SHA-256 verified.' : `All ${snap.verified} files SHA-256 verified.`}{' '}
              {snap.sinkKind === 'file-system-access' ? 'Saved where you chose.' : 'Check your downloads.'}
            </p>
            <a className="btn" href="/">
              send something back
            </a>
          </div>
        )}

        {status === 'error' && snap?.error && (
          <div className="error" role="alert" data-testid="receive-error" data-kind={snap.error.kind}>
            <p className="error__title">
              {snap.error.kind === 'not-found'
                ? 'This link has expired.'
                : snap.error.kind === 'integrity'
                  ? 'Integrity check failed.'
                  : snap.error.kind === 'cancelled'
                    ? 'Download cancelled.'
                    : 'Something went wrong.'}
            </p>
            <p className="fine">{snap.error.message}</p>
            <div className="row">
              {snap.error.kind !== 'not-found' && (
                <button type="button" className="btn btn--primary" onClick={() => location.reload()}>
                  try again
                </button>
              )}
              <a className="btn btn--ghost" href="/">
                share your own files
              </a>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
