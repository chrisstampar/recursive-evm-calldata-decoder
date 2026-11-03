import { useCallback, useMemo } from 'react';
import type { DecodedCall } from '../types/index.ts';
import { useTreeExpansionOptional } from '../context/TreeExpansionContext.tsx';
import { callNodeDomId, listDecodedCalls, pathToCall } from '../lib/callTree.ts';

/** Frames to wait for the target node to mount (each tree level mounts a frame after its parent opens). */
const MAX_REVEAL_FRAMES = 60;
const FLASH_MS = 1600;

/**
 * Returns `reveal(callIndex)`: opens the tree down to that call, scrolls it into view, focuses its header and
 * briefly highlights it. Needs `TreeExpansionProvider` above both the caller and the tree; a no-op without it.
 */
export function useRevealCall(root: DecodedCall | null): (callIndex: number) => void {
  const tree = useTreeExpansionOptional();
  const calls = useMemo(() => (root ? listDecodedCalls(root) : []), [root]);

  return useCallback(
    (callIndex: number) => {
      const target = calls[callIndex];
      if (!root || !target || !tree) return;
      tree.reveal(pathToCall(root, target));
      const id = callNodeDomId(callIndex);
      let frames = 0;
      const tick = () => {
        const el = document.getElementById(id);
        if (!el) {
          if (++frames < MAX_REVEAL_FRAMES) requestAnimationFrame(tick);
          return;
        }
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
        el.querySelector<HTMLElement>('[role="button"]')?.focus({ preventScroll: true });
        el.dataset.flash = 'true';
        window.setTimeout(() => delete el.dataset.flash, FLASH_MS);
      };
      requestAnimationFrame(tick);
    },
    [calls, root, tree],
  );
}
