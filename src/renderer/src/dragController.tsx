// yCal — pointer / HTML5 hybrid drag controller.
//
// This file is the corrected version of the design's drag-controller.jsx.
// The bug the user hit ("the time bar pops up but the drop doesn't commit")
// had two root causes:
//
//   1. `useDragTarget` hooked the drop event listeners against a callback
//      that callers passed as inline arrows. Every render those arrows are
//      fresh references, the effect re-ran, listeners were torn down + put
//      back, and a re-render landing during the gap between dragstart and
//      drop swallowed the drop event entirely. Fixed by reading callbacks
//      through a ref so the listener bindings stay stable across renders.
//
//   2. Inside iframes / overlay tools, `pointermove`/`pointerup` events
//      are sometimes intercepted before our React handlers run, while
//      HTML5 `dragstart` always fires from the OS-level drag. We support
//      both: a card responds to either pointerdown (with a small movement
//      threshold) OR HTML5 dragstart, whichever wins, and the controller
//      switches to dragover/dragend tracking when the browser is driving
//      the drag (because pointer events are suppressed during a native
//      HTML5 drag).
//
// Drop targets register via `useDragTarget(ref, opts)`. When the user
// releases over a target, that target gets a synthetic `ycal-drop` event
// with the source's `payload` in `event.detail`.

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from 'react';

type DragMode = 'pointer' | 'html5';

interface DragInfo<P = unknown> {
  type: string;
  payload: P;
  x: number;
  y: number;
  preview: ReactNode;
  mode: DragMode;
}

interface DragCtxValue {
  drag: DragInfo | null;
  begin: (info: DragInfo) => void;
}

const DragCtx = createContext<DragCtxValue | null>(null);

export function DragProvider({ children }: { children: ReactNode }) {
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const stateRef = useRef<DragInfo | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const lastTargetRef = useRef<Element | null>(null);

  const begin = useCallback((info: DragInfo) => {
    stateRef.current = info;
    setDrag(info);
  }, []);

  const move = useCallback((x: number, y: number) => {
    if (!stateRef.current) return;
    const el = previewRef.current;
    if (el) {
      el.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
      // Hide our own preview before hit-testing so elementFromPoint never
      // returns the preview itself.
      el.style.pointerEvents = 'none';
    }
    const under = document.elementFromPoint(x, y);
    const target = (under instanceof Element)
      ? under.closest('[data-drop-target]')
      : null;
    const prevTarget = lastTargetRef.current;
    if (target !== prevTarget) {
      if (prevTarget) {
        prevTarget.dispatchEvent(new CustomEvent('ycal-dragleave', { bubbles: false }));
      }
      if (target) {
        target.dispatchEvent(new CustomEvent('ycal-dragenter', {
          bubbles: false, detail: { ...stateRef.current, x, y },
        }));
      }
      lastTargetRef.current = target;
    }
    if (target) {
      target.dispatchEvent(new CustomEvent('ycal-dragover', {
        bubbles: false, detail: { ...stateRef.current, x, y },
      }));
    }
  }, []);

  const end = useCallback((x: number, y: number) => {
    const t = lastTargetRef.current;
    const s = stateRef.current;
    if (t && s) {
      t.dispatchEvent(new CustomEvent('ycal-drop', {
        bubbles: false, detail: { ...s, x, y },
      }));
    }
    if (t) t.dispatchEvent(new CustomEvent('ycal-dragleave', { bubbles: false }));
    lastTargetRef.current = null;
    stateRef.current = null;
    setDrag(null);
  }, []);

  const cancel = useCallback(() => {
    const t = lastTargetRef.current;
    if (t) t.dispatchEvent(new CustomEvent('ycal-dragleave', { bubbles: false }));
    lastTargetRef.current = null;
    stateRef.current = null;
    setDrag(null);
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKey);

    if (drag.mode === 'html5') {
      // The browser's native drag suppresses pointer events. We listen at
      // window-level for dragover/drop, and use dragend as a guaranteed
      // commit point in case `drop` gets eaten by a host overlay.
      let lastX = drag.x;
      let lastY = drag.y;
      const onDragOver = (e: DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        lastX = e.clientX;
        lastY = e.clientY;
        move(e.clientX, e.clientY);
      };
      const onDrop = (e: DragEvent) => {
        e.preventDefault();
        end(e.clientX, e.clientY);
      };
      const onDragEnd = (_e: DragEvent) => {
        // dragend fires after drop; if state is already cleared, no-op.
        if (stateRef.current) end(lastX, lastY);
      };
      window.addEventListener('dragover', onDragOver, true);
      window.addEventListener('drop', onDrop, true);
      window.addEventListener('dragend', onDragEnd, true);
      return () => {
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('dragover', onDragOver, true);
        window.removeEventListener('drop', onDrop, true);
        window.removeEventListener('dragend', onDragEnd, true);
      };
    }
    const onMove = (e: PointerEvent) => move(e.clientX, e.clientY);
    const onUp = (e: PointerEvent) => end(e.clientX, e.clientY);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, move, end, cancel]);

  return (
    <DragCtx.Provider value={{ drag, begin }}>
      {children}
      {drag && drag.preview && (
        <div
          ref={previewRef}
          className="drag-preview"
          style={{
            position: 'fixed',
            left: 0, top: 0,
            transform: `translate(${drag.x + 12}px, ${drag.y + 12}px)`,
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        >
          {drag.preview}
        </div>
      )}
    </DragCtx.Provider>
  );
}

interface DragSource<P> {
  draggable: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
}

interface DragSourceOpts<P> {
  type: string;
  payload: P;
  makePreview?: () => ReactNode;
  threshold?: number;
}

export function useDragSource<P>(opts: DragSourceOpts<P>): DragSource<P> {
  const ctx = useContext(DragCtx);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const startDrag = useCallback((x: number, y: number, mode: DragMode) => {
    if (!ctx) return;
    const o = optsRef.current;
    ctx.begin({
      type: o.type,
      payload: o.payload,
      x, y, mode,
      preview: o.makePreview ? o.makePreview() : null,
    });
  }, [ctx]);

  if (!ctx) {
    return {
      draggable: false,
      onPointerDown: () => { /* no provider */ },
      onDragStart: () => { /* no provider */ },
    };
  }

  return {
    draggable: true,
    onPointerDown: (e) => {
      // Don't initiate drag from form controls; they need their normal behavior.
      const tgt = e.target as HTMLElement;
      if (tgt.closest('button,input,textarea,select,a,label')) return;
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const threshold = optsRef.current.threshold ?? 4;
      const t2 = threshold * threshold;
      let started = false;
      const onMove = (m: PointerEvent) => {
        const dx = m.clientX - startX;
        const dy = m.clientY - startY;
        if (!started && (dx * dx + dy * dy) >= t2) {
          started = true;
          startDrag(m.clientX, m.clientY, 'pointer');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        }
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    onDragStart: (e) => {
      // Hide the OS drag image — we render our own floating preview.
      try {
        const blank = document.createElement('canvas');
        blank.width = 1; blank.height = 1;
        e.dataTransfer.setDragImage(blank, 0, 0);
      } catch {
        /* ignore */
      }
      try {
        const id = (optsRef.current.payload as { taskId?: string } | null)?.taskId ?? '';
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
      } catch {
        /* ignore */
      }
      startDrag(e.clientX, e.clientY, 'html5');
    },
  };
}

interface DragTargetOpts {
  accept?: string;
  onEnter?: (e: DragInfo & { target: Element; originalEvent: Event }) => void;
  onOver?: (e: DragInfo & { target: Element; originalEvent: Event }) => void;
  onLeave?: (e: { target: Element; originalEvent: Event }) => void;
  onDrop?: (e: DragInfo & { target: Element; originalEvent: Event }) => void;
}

// IMPORTANT: callbacks are read through a ref. This is the bug-fix the user
// flagged in the prototype — re-renders of inline callbacks would otherwise
// tear down + rebuild the listeners mid-drag, and a render landing between
// pointerup and the rebuild would swallow the drop event entirely.
export function useDragTarget(
  ref: React.RefObject<HTMLElement>,
  opts: DragTargetOpts = {},
): void {
  const cbRef = useRef(opts);
  cbRef.current = opts;
  const accept = opts.accept;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute('data-drop-target', accept || '*');
    const matches = (e: Event): boolean => {
      const t = (e as CustomEvent).detail?.type;
      if (!accept || accept === '*') return true;
      return accept.split(',').map((s) => s.trim()).includes(t);
    };
    const fire = (key: 'onEnter' | 'onOver' | 'onDrop') => (e: Event) => {
      if (!matches(e)) return;
      const cb = cbRef.current[key];
      if (cb) {
        const detail = (e as CustomEvent).detail;
        cb({ ...detail, target: el, originalEvent: e });
      }
    };
    const hEnter = fire('onEnter');
    const hOver = fire('onOver');
    const hDrop = fire('onDrop');
    const hLeave = (e: Event) => {
      const cb = cbRef.current.onLeave;
      if (cb) cb({ target: el, originalEvent: e });
    };
    el.addEventListener('ycal-dragenter', hEnter);
    el.addEventListener('ycal-dragover', hOver);
    el.addEventListener('ycal-dragleave', hLeave);
    el.addEventListener('ycal-drop', hDrop);
    return () => {
      el.removeAttribute('data-drop-target');
      el.removeEventListener('ycal-dragenter', hEnter);
      el.removeEventListener('ycal-dragover', hOver);
      el.removeEventListener('ycal-dragleave', hLeave);
      el.removeEventListener('ycal-drop', hDrop);
    };
  }, [ref, accept]);
}
