import type { TxWarning, WarningSeverity } from '../types/index.ts';

/** Heroicons v2 24×24 outline `exclamation-triangle` — shared by `danger` and `warning` (color from parent). */
const EXCLAMATION_TRIANGLE_PATH =
  'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z';

const SEVERITY_STYLES: Record<
  WarningSeverity,
  { border: string; bg: string; icon: string; title: string; text: string; context: string }
> = {
  danger: {
    border: 'border-red-500/50',
    bg: 'bg-red-950/30',
    icon: 'text-red-400',
    title: 'text-red-300',
    text: 'text-red-200',
    context: 'text-red-300',
  },
  warning: {
    border: 'border-yellow-500/40',
    bg: 'bg-yellow-950/20',
    icon: 'text-yellow-400',
    title: 'text-yellow-300',
    text: 'text-yellow-200',
    context: 'text-yellow-300',
  },
  info: {
    border: 'border-blue-500/30',
    bg: 'bg-blue-950/20',
    icon: 'text-blue-400',
    title: 'text-blue-300',
    text: 'text-blue-200',
    context: 'text-blue-300',
  },
};

function SeverityIcon({ severity }: { severity: WarningSeverity }) {
  if (severity === 'danger' || severity === 'warning') {
    return (
      <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={EXCLAMATION_TRIANGLE_PATH} />
      </svg>
    );
  }
  return (
    <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

/** Severity in words, so it doesn't rest on colour alone (screen readers, colour-blind users). */
const SEVERITY_LABEL: Record<WarningSeverity, string> = { danger: 'Danger', warning: 'Warning', info: 'Note' };
const SEVERITY_NOUN: Record<WarningSeverity, [string, string]> = {
  danger: ['danger', 'dangers'],
  warning: ['warning', 'warnings'],
  info: ['note', 'notes'],
};

function WarningCard({ warning, onShowInTree }: { warning: TxWarning; onShowInTree?: (callIndex: number) => void }) {
  const styles = SEVERITY_STYLES[warning.severity];
  const canShow = onShowInTree != null && warning.callIndex !== undefined;
  const compact = warning.severity === 'info';

  return (
    <div role="listitem" className={`rounded-lg border ${styles.border} ${styles.bg} ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
      <div className={`flex items-start gap-3 ${styles.icon}`}>
        <SeverityIcon severity={warning.severity} />
        <div className="min-w-0 flex-1">
          <h4 className={`text-sm font-semibold break-words ${styles.title}`}>
            <span className="mr-2 align-middle text-[10px] font-bold uppercase tracking-wide opacity-90">
              {SEVERITY_LABEL[warning.severity]}
            </span>
            {warning.title}
          </h4>
          <p className={`text-xs mt-1 break-words ${styles.text}`}>{warning.message}</p>
          {(canShow || warning.context) && (
            <div className="mt-1.5 flex flex-wrap items-start gap-x-4 gap-y-1">
              {canShow && (
                <button
                  type="button"
                  onClick={() => onShowInTree(warning.callIndex!)}
                  className={`text-xs underline underline-offset-2 hover:no-underline ${styles.title}`}
                >
                  Show in tree
                </button>
              )}
              {warning.context && (
                <details className="min-w-0 basis-full sm:basis-auto sm:flex-1">
                  <summary className={`cursor-pointer text-xs ${styles.context} hover:opacity-100`}>Why this appears</summary>
                  <p className={`text-[11px] leading-snug mt-1 font-mono break-words ${styles.context}`}>{warning.context}</p>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** "1 danger, 2 warnings, 1 note". */
function countPhrase(warnings: TxWarning[]): string {
  return (['danger', 'warning', 'info'] as const)
    .map(sev => [sev, warnings.filter(w => w.severity === sev).length] as const)
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `${n} ${SEVERITY_NOUN[sev][n === 1 ? 0 : 1]}`)
    .join(', ');
}

export function WarningBanner({
  warnings,
  onShowInTree,
}: {
  warnings: TxWarning[];
  /** Jump to the call a warning is about (warnings with a `callIndex`). */
  onShowInTree?: (callIndex: number) => void;
}) {
  if (warnings.length === 0) return null;

  const order: Record<WarningSeverity, number> = { danger: 0, warning: 1, info: 2 };
  const sorted = [...warnings].sort((a, b) => order[a.severity] - order[b.severity]);

  return (
    <div className="space-y-2" aria-live="polite">
      <h2 className="text-sm font-medium text-gray-400">{countPhrase(sorted)}</h2>
      <div className="space-y-2" role="list">
        {sorted.map((w, i) => (
          <WarningCard key={i} warning={w} onShowInTree={onShowInTree} />
        ))}
      </div>
    </div>
  );
}
