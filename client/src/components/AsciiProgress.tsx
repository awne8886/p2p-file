interface Props {
  value: number;
  max: number;
  /** Number of characters between the brackets. */
  width?: number;
  label: string;
}

/** `[##########··········]  47%` — a progress bar in the site's ASCII idiom. */
export function AsciiProgress({ value, max, width = 24, label }: Props) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const filled = Math.round(ratio * width);
  const pct = Math.floor(ratio * 100);
  return (
    <div
      className="ascii-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span aria-hidden="true">
        [<span className="ascii-progress__fill">{'#'.repeat(filled)}</span>
        <span className="ascii-progress__empty">{'·'.repeat(width - filled)}</span>]
      </span>
      <span className="ascii-progress__pct">{pct}%</span>
    </div>
  );
}
