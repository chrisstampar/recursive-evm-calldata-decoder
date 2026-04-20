import { useEffect } from 'react';
import { useTreeExpansion } from '../context/TreeExpansionContext.tsx';

function isTypingFocusTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/**
 * Expand / collapse every expandable node in the decode tree (calls, arrays, tuples).
 *
 * **Provider:** {@link useTreeExpansion} throws if this is not under `TreeExpansionProvider` (no `null` context).
 * Bulk actions are synchronous; no loading state on these buttons.
 *
 * **Shortcuts** (when focus is not in an input / contenteditable): **Ctrl/Cmd+Shift+E** expand all,
 * **Ctrl/Cmd+Shift+L** collapse all (`preventDefault` when handled).
 */
export function TreeExpandToolbar() {
  const { expandAll, collapseAll } = useTreeExpansion();

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!ev.shiftKey || (!ev.metaKey && !ev.ctrlKey)) return;
      if (isTypingFocusTarget(ev.target)) return;
      const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      if (k === 'e') {
        ev.preventDefault();
        expandAll();
      } else if (k === 'l') {
        ev.preventDefault();
        collapseAll();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expandAll, collapseAll]);

  const btn =
    'text-xs text-gray-600 hover:text-white transition-colors px-1.5 py-0.5 rounded border border-transparent hover:border-gray-500';

  return (
    <div className="flex items-center gap-1.5 shrink-0" role="group" aria-label="Decode tree expansion">
      <button
        type="button"
        onClick={expandAll}
        className={btn}
        title="Expand all (Ctrl+Shift+E or ⌘⇧E)"
        aria-keyshortcuts="Control+Shift+E Meta+Shift+E"
      >
        Expand all
      </button>
      <span className="text-gray-700 select-none" aria-hidden>
        |
      </span>
      <button
        type="button"
        onClick={collapseAll}
        className={btn}
        title="Collapse all (Ctrl+Shift+L or ⌘⇧L)"
        aria-keyshortcuts="Control+Shift+L Meta+Shift+L"
      >
        Collapse all
      </button>
    </div>
  );
}
