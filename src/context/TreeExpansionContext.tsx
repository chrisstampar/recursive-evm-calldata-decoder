/**
 * Bulk expand/collapse for the decode tree. Initial open/closed defaults come from `treeExpandPolicy.ts`;
 * this context only broadcasts **user-driven** expand-all / collapse-all (see toolbar in `DecodeTree.tsx`).
 *
 * Subscribers (e.g. `TreeNode` via `useTreeExpansionOptional`) typically watch `generation` + `lastBulk` in an
 * effect and apply intent after `requestAnimationFrame` to avoid synchronous setState-from-effect issues.
 */
/* eslint-disable react-refresh/only-export-components -- paired Provider + hook module */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type TreeBulkExpansion = 'expand-all' | 'collapse-all';

export interface TreeExpansionContextValue {
  /**
   * Increments on each expand-all / collapse-all. Resets toward `0` before exceeding `Number.MAX_SAFE_INTEGER`
   * so `generation` stays safe for equality deps and `===` comparisons.
   */
  generation: number;
  /** Intent for the latest generation (null = no bulk action yet). */
  lastBulk: TreeBulkExpansion | null;
  /**
   * Each call bumps `generation`, even if `lastBulk` was already `expand-all`, so nested nodes can re-sync
   * (e.g. double-click or remounted subtrees). Not deduplicated by design.
   */
  expandAll: () => void;
  /** Same re-bump semantics as {@link TreeExpansionContextValue.expandAll}. */
  collapseAll: () => void;
}

const TreeExpansionContext = createContext<TreeExpansionContextValue | null>(null);

function bumpGeneration(prev: number): number {
  return prev < Number.MAX_SAFE_INTEGER ? prev + 1 : 0;
}

export function TreeExpansionProvider({ children }: { children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  const [lastBulk, setLastBulk] = useState<TreeBulkExpansion | null>(null);

  const expandAll = useCallback(() => {
    setLastBulk('expand-all');
    setGeneration(bumpGeneration);
  }, []);

  const collapseAll = useCallback(() => {
    setLastBulk('collapse-all');
    setGeneration(bumpGeneration);
  }, []);

  const value = useMemo(
    () => ({ generation, lastBulk, expandAll, collapseAll }),
    [generation, lastBulk, expandAll, collapseAll],
  );

  return <TreeExpansionContext.Provider value={value}>{children}</TreeExpansionContext.Provider>;
}

/**
 * Requires `TreeExpansionProvider`. Use from toolbar / features that always live under the decode tree shell.
 */
export function useTreeExpansion(): TreeExpansionContextValue {
  const ctx = useContext(TreeExpansionContext);
  if (!ctx) {
    throw new Error('useTreeExpansion must be used within TreeExpansionProvider');
  }
  return ctx;
}

/**
 * Returns `null` outside a provider so tree nodes can opt out of bulk sync when embedded without the toolbar
 * (tests or future reuse). Prefer {@link useTreeExpansion} when the provider is guaranteed.
 */
export function useTreeExpansionOptional(): TreeExpansionContextValue | null {
  return useContext(TreeExpansionContext);
}
