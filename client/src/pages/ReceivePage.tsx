import { formatBytes, formatDuration, formatSpeed, type FileMeta } from '@pizzadrop/shared';
import { useEffect, useRef, useState } from 'react';
import { AsciiProgress } from '../components/AsciiProgress';
import { useBeforeUnload } from '../hooks/useBeforeUnload';
import { useSideLayout } from '../hooks/useSideLayout';
import { BASE_PATH } from '../lib/config';
import { BLOB_WARN_BYTES } from '../lib/constants';
import { Receiver, type ConnectPhase, type ReceiveErrorKind, type ReceiveSnapshot } from '../lib/receiver';
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
  /** Tells the background a transfer is running (it animates more cheaply then). */
  setTransferring(transferring: boolean): void;
}

const SPINNER = ['|', '/', '-', '\\'];

const PHASES: Record<ConnectPhase, string> = {
  signaling: 'Reaching the signaling server…',
  looking: 'Looking for the sender…',
  negotiating: 'Found the sender. Opening a direct, encrypted connection between your browsers…',
};

const ERROR_TITLES: Partial<Record<ReceiveErrorKind, string>> = {
  'not-found': 'This link has expired.',
  'no-sender': 'Couldn’t find the sender.',
  unreachable: 'Couldn’t connect to the sender.',
  integrity: 'Integrity check failed.',
  cancelled: 'Download cancelled.',
};

/** What connecting is doing right now, so a slow step is visible instead of an endless spinner. */
function connectDetail(s: ReceiveSnapshot | null): string {
  if (!s?.connect) return 'Setting up a direct, encrypted connection between your browser and theirs.';
  const retry = s.connect.attempt > 1 ? ` (attempt ${s.connect.attempt})` : '';
  return PHASES[s.connect.phase] + retry;
}

function useSpinner(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setI((n) => (n + 1) % SPINNER.length), 120);
    return () => clearInterval(t);
  }, [active]);
  return SPINNER[i]!;
}

export function ReceivePage({ code, setEnergy, setTransferring }: Props) {
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
  useEffect(() => setTransferring(busy), [busy, setTransferring]);
  const spinner = useSpinner(status === 'connecting' || status === 'reconnecting' || status === 'finishing' || opening);

  const download = async (allowLargeMemory = false) => {
    const r = receiverRef.current;
    const plan = r?.planDownload();
    if (!r || !plan || opening) return;
    setOpening(true);
    setSaveError(null);
    try {
      const sink = await openSink(plan.name, plan.size, plan.mime, { allowLargeMemory });
      setConfirmMemory(false);
      if (!r.start(sink, plan)) void sink.writable.abort().catch(() => undefined);
    } catch (err) {
      if (err instanceof NeedsMemoryConfirmationError) setConfirmMemory(true);
      else if (!(err instanceof SaveCancelledError)) setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  };

  const active = status === 'receiving' || status === 'reconnecting' || status === 'finishing';
  const batch = snap?.batch ?? null;
  const pending = snap?.pending ?? [];
  const canDownload = (status === 'ready' || status === 'done') && pending.length > 0 && !snap?.hostGone;
  // While downloading, the header describes this download; otherwise everything on offer.
  const shown: FileMeta[] | null = active && batch ? batch.files : (snap?.files ?? null);
  const shownBytes = shown?.reduce((a, f) => a + f.size, 0) ?? 0;
  const pendingIds = new Set(pending.map((f) => f.id));

  const downloadButton = (s: ReceiveSnapshot) => (
    <>
      {!confirmMemory && willBufferInMemory() && s.pendingBytes > BLOB_WARN_BYTES && (
        <p className="notice notice--warn">
          This browser can’t stream downloads to disk, so the whole {formatBytes(s.pendingBytes)} will be held in memory
          first. Chrome, Edge or Firefox handle large files better.
        </p>
      )}
      {confirmMemory ? (
        <div className="confirm">
          <p className="notice notice--warn">
            Streaming to disk isn’t available here, so this {formatBytes(s.pendingBytes)} download has to be held in
            memory until it finishes. That may crash the tab on low-memory devices.
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
          {opening
            ? `${spinner} preparing…`
            : s.downloadedCount === 0
              ? 'download'
              : `download ${pending.length === 1 ? 'it' : `all ${pending.length}`}`}
        </button>
      )}
      {saveError && <p className="notice notice--bad">{saveError}</p>}
    </>
  );

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
            <p className="fine" data-testid="connect-phase" data-phase={snap?.connect?.phase ?? ''}>
              {connectDetail(snap)}
            </p>
          </>
        )}

        {shown && status !== 'connecting' && (
          <header className="card__header">
            <h1 className="card__title" data-testid="receive-name">
              {shown.length === 1 ? shown[0]!.name : `${shown.length} files`}
            </h1>
            <p className="card__meta" data-testid="receive-size">
              {formatBytes(shownBytes)}
              {active && batch && batch.files.length > 1 && ` · saved as ${batch.saveName}`}
            </p>
            {shown.length > 1 && (
              <details className="file-list">
                <summary>show files</summary>
                <ul>
                  {shown.map((f) => (
                    <li key={f.id}>
                      <span className="file-list__name">
                        {!active && !pendingIds.has(f.id) && <span className="file-list__done">✓ </span>}
                        {f.name}
                      </span>
                      <span className="file-list__size">{formatBytes(f.size)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </header>
        )}

        {status === 'ready' &&
          snap &&
          (pending.length > 0 ? downloadButton(snap) : <p className="fine">Nothing is shared yet.</p>)}

        {active && snap && batch && (
          <div className="transfer">
            <AsciiProgress value={batch.bytes} max={batch.total} label="Download progress" />
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
                  {formatBytes(batch.bytes)} of {formatBytes(batch.total)} · {formatSpeed(snap.speed)} ·{' '}
                  {Number.isFinite(snap.eta) ? `${formatDuration(snap.eta)} left` : 'estimating…'}
                </>
              )}
            </p>
            {batch.files.length > 1 && status === 'receiving' && (
              <p className="fine">
                file {batch.fileIndex + 1} of {batch.files.length}: {batch.files[batch.fileIndex]?.name}
              </p>
            )}
            {snap.sinkKind && <p className="fine">{SINK_LABELS[snap.sinkKind]} · every block SHA-256 checked</p>}
            <Repaired n={snap.repaired} />
            {pending.length > 0 && (
              <p className="fine">
                The sender added {pending.length} more file{pending.length === 1 ? '' : 's'}; you can download{' '}
                {pending.length === 1 ? 'it' : 'them'} after this.
              </p>
            )}
            {status !== 'finishing' && (
              <button type="button" className="btn btn--ghost" onClick={() => receiverRef.current?.cancel()}>
                cancel
              </button>
            )}
          </div>
        )}

        {status === 'done' && snap && batch && (
          <div className="done" data-testid="receive-done" data-batch={batch.n}>
            <p className="done__title">Done ✓</p>
            <p className="fine">
              {batch.verified === 1 ? 'SHA-256 verified.' : `All ${batch.verified} files SHA-256 verified.`}{' '}
              {snap.sinkKind === 'file-system-access' ? 'Saved where you chose.' : 'Check your downloads.'}
            </p>
            <Repaired n={snap.repaired} />
            {canDownload ? (
              <>
                <p className="notice" data-testid="new-files">
                  The sender added {pending.length} more file{pending.length === 1 ? '' : 's'} (
                  {formatBytes(snap.pendingBytes)}).
                </p>
                {downloadButton(snap)}
              </>
            ) : snap.hostGone ? (
              <p className="fine">The sender has stopped sharing.</p>
            ) : (
              <p className="fine">Keep this page open to get anything else they add.</p>
            )}
            <a className="btn" href={BASE_PATH}>
              send something back
            </a>
          </div>
        )}

        {status === 'error' && snap?.error && (
          <div className="error" role="alert" data-testid="receive-error" data-kind={snap.error.kind}>
            <p className="error__title">{ERROR_TITLES[snap.error.kind] ?? 'Something went wrong.'}</p>
            <p className="fine">{snap.error.message}</p>
            <div className="row">
              {snap.error.kind !== 'not-found' && (
                <button type="button" className="btn btn--primary" onClick={() => location.reload()}>
                  try again
                </button>
              )}
              <a className="btn btn--ghost" href={BASE_PATH}>
                share your own files
              </a>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

/** Corruption that the per-block check caught and repaired, reported rather than hidden. */
function Repaired({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <p className="fine" data-testid="repaired" data-count={n}>
      {n === 1 ? '1 damaged block was' : `${n} damaged blocks were`} caught by the SHA-256 check and fetched again.
    </p>
  );
}
