import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

interface DragState {
  startX: number;
  startWidth: number;
  width: number;
  cleanup: () => void;
}

export function useRightPanelResize(
  storageKey: string,
  defaultWidth: number,
  minWidth = 240,
): { width: number; resizeHandleRef: RefObject<HTMLDivElement> } {
  const [width, setWidthState] = useState(() => initialWidth(storageKey, defaultWidth, minWidth));
  const widthRef = useRef(width);
  const drag = useRef<DragState | null>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);

  const setWidth = useCallback((next: number) => {
    widthRef.current = next;
    setWidthState(next);
  }, []);

  const endResize = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    current.cleanup();
    drag.current = null;
    try {
      localStorage.setItem(storageKey, String(current.width));
    } catch {
      // persistence is a nice-to-have
    }
  }, [storageKey]);

  const startResize = useCallback(
    (startX: number) => {
      endResize();

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const applyClientX = (clientX: number) => {
        const current = drag.current;
        if (!current) return;
        const next = Math.min(
          Math.max(minWidth, current.startWidth + (current.startX - clientX)),
          Math.round(window.innerWidth * 0.85),
        );
        current.width = next;
        setWidth(next);
      };

      const onMouseMove = (event: MouseEvent) => {
        applyClientX(event.clientX);
        event.preventDefault();
      };
      const onMouseUp = () => endResize();
      const onTouchMove = (event: TouchEvent) => {
        const touch = event.touches[0];
        if (!touch) return;
        applyClientX(touch.clientX);
        event.preventDefault();
      };
      const onTouchEnd = () => endResize();

      const cleanup = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onTouchEnd);
        document.removeEventListener("touchcancel", onTouchEnd);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      drag.current = {
        startX,
        startWidth: widthRef.current,
        width: widthRef.current,
        cleanup,
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend", onTouchEnd);
      document.addEventListener("touchcancel", onTouchEnd);
    },
    [endResize, minWidth, setWidth],
  );

  useEffect(() => {
    const handle = resizeHandleRef.current;
    if (!handle) return;

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      startResize(event.clientX);
      event.preventDefault();
      event.stopPropagation();
    };
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      startResize(touch.clientX);
      event.preventDefault();
      event.stopPropagation();
    };

    handle.addEventListener("mousedown", onMouseDown);
    handle.addEventListener("touchstart", onTouchStart, { passive: false });
    return () => {
      handle.removeEventListener("mousedown", onMouseDown);
      handle.removeEventListener("touchstart", onTouchStart);
      endResize();
    };
  }, [endResize, startResize]);

  return { width, resizeHandleRef };
}

function initialWidth(storageKey: string, defaultWidth: number, minWidth: number): number {
  try {
    const stored = Number(localStorage.getItem(storageKey));
    return stored >= minWidth ? stored : defaultWidth;
  } catch {
    return defaultWidth;
  }
}
