import { useEffect, useState } from 'react';
import { sliceExtent } from '../ascii/renderer';

/** Card width + right margin + breathing room, in CSS px (keep in sync with `.stage--side`). */
const CARD_W = 360;
const MARGIN = 32;
const GAP = 16;

function fits(): boolean {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const sliceRight = w / 2 + sliceExtent(w, h) / 2;
  return h >= 560 && w - MARGIN - CARD_W - GAP >= sliceRight;
}

/**
 * True when a card docked to the right edge would not overlap the centred
 * slice. Otherwise the card goes below it.
 */
export function useSideLayout(): boolean {
  const [side, setSide] = useState(fits);
  useEffect(() => {
    const onResize = () => setSide(fits());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return side;
}
