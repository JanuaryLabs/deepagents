import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { SnapshotRenderContext } from './snapshot-context.ts';

export function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * Renders `children` off-screen at a fixed width so a capture (image, PDF) does
 * not depend on the current window size.
 *
 * A portal keeps the React tree intact while moving only the DOM node, so the
 * snapshot copy shares the surrounding providers — params, SQL interpolation,
 * and the React Query cache. Widgets therefore hydrate from cache instead of
 * re-running their queries, and the artifact shows the same numbers as the
 * screen.
 */
export function SnapshotRenderPortal({
  contentRef,
  children,
  width = 1120,
  padding = 24,
  className = 'bg-background text-foreground flex flex-col gap-3',
}: {
  contentRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  width?: number;
  padding?: number;
  className?: string;
}) {
  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: '-100000px',
        pointerEvents: 'none',
        zIndex: -1,
      }}
    >
      <SnapshotRenderContext value={true}>
        <div
          ref={contentRef}
          className={className}
          style={{ width, padding, boxSizing: 'border-box' }}
        >
          {children}
        </div>
      </SnapshotRenderContext>
    </div>,
    document.body,
  );
}
