'use client';

/**
 * Renders remote collaborator carets + selection highlights on top of the
 * Plate editor surface. Hooked into Plate via YjsPlugin's `afterEditable`
 * render slot.
 */

import {
  type CursorOverlayData,
  useRemoteCursorOverlayPositions,
} from '@slate-yjs/react';
import { useRef } from 'react';

type CursorData = { color: string; name: string };

function RemoteCursor({
  caretPosition,
  data,
  selectionRects,
  clientId,
}: Pick<
  CursorOverlayData<CursorData>,
  'caretPosition' | 'data' | 'selectionRects' | 'clientId'
>) {
  const fallbackHue = (Math.abs(clientId) * 137) % 360;
  const fallbackColor = `hsl(${fallbackHue}, 65%, 55%)`;
  const color = data?.color ?? fallbackColor;
  const name = data?.name ?? 'Anonymous';

  return (
    <>
      {selectionRects.map((rect) => (
        <div
          key={`${rect.left}-${rect.top}-${rect.width}-${rect.height}`}
          className="pointer-events-none absolute"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            backgroundColor: color,
            opacity: 0.18,
            borderRadius: 2,
          }}
        />
      ))}
      {caretPosition && (
        <div
          className="pointer-events-none absolute"
          style={{
            left: caretPosition.left,
            top: caretPosition.top,
            height: caretPosition.height,
            width: 2,
            backgroundColor: color,
            borderRadius: 1,
          }}
        >
          <div
            className="absolute bottom-full left-0 mb-0.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-tight text-white shadow-sm"
            style={{ backgroundColor: color }}
          >
            {name}
          </div>
        </div>
      )}
    </>
  );
}

export function RemoteCursorOverlay() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cursors] = useRemoteCursorOverlayPositions<CursorData>({
    containerRef: containerRef as React.RefObject<HTMLDivElement>,
  });

  return (
    <div className="pointer-events-none absolute inset-0" ref={containerRef}>
      {cursors.map((cursor) => (
        <RemoteCursor key={cursor.clientId} {...cursor} />
      ))}
    </div>
  );
}
