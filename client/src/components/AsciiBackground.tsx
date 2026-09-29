import { useEffect, useRef } from 'react';
import { AsciiPizzaRenderer, type PizzaScene } from '../ascii/renderer';

interface Props {
  /** 0 = idle, 1 = excited (e.g. a file is being dragged over the page). */
  energy: number;
  /** A transfer is running: animate at 30 fps to leave the CPU to it. */
  transferring?: boolean;
  /** The tilted slice, or a whole pizza slowly spinning (the 404 page). */
  scene?: PizzaScene;
}

const TRANSFER_FPS = 30;

const reducedMotionQuery = () => window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Full-viewport canvas behind the UI. Pauses when the tab is hidden and
 * renders a single static frame when the user prefers reduced motion.
 */
export function AsciiBackground({ energy, transferring = false, scene = 'slice' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<AsciiPizzaRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mq = reducedMotionQuery();
    let renderer: AsciiPizzaRenderer;
    try {
      renderer = new AsciiPizzaRenderer(canvas, { reducedMotion: mq.matches, scene });
    } catch {
      return; // No 2D canvas: the page is simply black.
    }
    rendererRef.current = renderer;

    let pending = 0;
    const resize = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr);
        canvas.dataset.stars = String(renderer.starCount);
      });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const onVisibility = () => {
      if (document.hidden) renderer.stop();
      else renderer.start();
    };
    const onMotionChange = () => renderer.setReducedMotion(mq.matches);
    document.addEventListener('visibilitychange', onVisibility);
    mq.addEventListener('change', onMotionChange);
    if (!document.hidden) renderer.start();

    return () => {
      cancelAnimationFrame(pending);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      mq.removeEventListener('change', onMotionChange);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [scene]);

  useEffect(() => {
    rendererRef.current?.setEnergy(energy);
  }, [energy]);

  useEffect(() => {
    rendererRef.current?.setMaxFps(transferring ? TRANSFER_FPS : 0);
  }, [transferring]);

  return <canvas ref={canvasRef} className="ascii-bg" aria-hidden="true" data-testid="ascii-bg" data-scene={scene} />;
}
