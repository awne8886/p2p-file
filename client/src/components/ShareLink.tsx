import { useEffect, useRef, useState } from 'react';

interface Props {
  url: string;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers / insecure contexts: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok: boolean;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

const canShare = () => typeof navigator.share === 'function' && window.matchMedia('(pointer: coarse)').matches;

/** The short link, a Copy button with "Copied!" feedback, and native Share on mobile. */
export function ShareLink({ url }: Props) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const display = url.replace(/^https?:\/\//, '');
  const slash = display.lastIndexOf('/');

  const onCopy = async () => {
    const ok = await copyText(url);
    setCopied(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied('idle'), 1800);
  };

  const onShare = async () => {
    try {
      await navigator.share({ title: 'PizzaDrop', text: 'Grab the file I’m sending you:', url });
    } catch {
      // Dismissed — nothing to do.
    }
  };

  return (
    <div className="share-link">
      <a className="share-link__url" href={url} target="_blank" rel="noreferrer" data-testid="share-url">
        <span className="share-link__host">{display.slice(0, slash + 1)}</span>
        <span className="share-link__code">{display.slice(slash + 1)}</span>
      </a>
      <div className="share-link__actions">
        <button type="button" className="btn btn--primary" onClick={onCopy} data-testid="copy-link">
          {copied === 'copied' ? 'copied!' : copied === 'failed' ? 'press ctrl+c' : 'copy link'}
        </button>
        {canShare() && (
          <button type="button" className="btn" onClick={onShare}>
            share…
          </button>
        )}
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copied === 'copied' ? 'Link copied to clipboard' : ''}
      </span>
    </div>
  );
}
