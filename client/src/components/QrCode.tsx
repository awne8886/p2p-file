import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

interface Props {
  /** The exact text to encode — the plain https:// share link. */
  value: string;
  /** Rendered size in CSS pixels (the QR is resolution-independent SVG). */
  size?: number;
}

/** Quiet zone in modules. The spec asks for 4; scanners are much happier with it. */
const MARGIN = 4;

/**
 * Client-side QR code (nothing leaves the browser). Error correction level Q
 * (~25% recoverable) and standard polarity — dark modules on a light tile —
 * because inverted codes still trip up some phone cameras. The tile is tinted
 * cream to sit well on the black page.
 */
export function QrCode({ value, size = 240 }: Props) {
  const { path, dim } = useMemo(() => {
    const qr = qrcode(0, 'Q');
    qr.addData(value, 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + MARGIN} ${row + MARGIN}h1v1h-1z`;
      }
    }
    return { path: d, dim: count + MARGIN * 2 };
  }, [value]);

  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code for ${value}`}
      data-qr-value={value}
    >
      <rect width={dim} height={dim} rx={1.2} fill="#fff4e0" />
      <path d={path} fill="#000" />
    </svg>
  );
}
