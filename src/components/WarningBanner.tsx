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
    text: 'text-red-300/80',
    context: 'text-red-200/55',
  },
  warning: {
    border: 'border-yellow-500/40',
    bg: 'bg-yellow-950/20',
    icon: 'text-yellow-400',
    title: 'text-yellow-300',
    text: 'text-yellow-300/80',
    context: 'text-yellow-200/50',
  },
  info: {
    border: 'border-blue-500/30',
    bg: 'bg-blue-950/20',
    icon: 'text-blue-400',
    title: 'text-blue-300',
    text: 'text-blue-300/80',
    context: 'text-blue-200/50',
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

function WarningCard({ warning }: { warning: TxWarning }) {
  const styles = SEVERITY_STYLES[warning.severity];

  return (
    <div className={`rounded-lg border ${styles.border} ${styles.bg} px-4 py-3`}>
      <div className={`flex items-start gap-3 ${styles.icon}`}>
        <SeverityIcon severity={warning.severity} />
        <div className="min-w-0 flex-1">
          <h4 className={`text-sm font-semibold break-words ${styles.title}`}>{warning.title}</h4>
          {warning.context && (
            <p
              className={`text-[11px] leading-snug mt-1 font-mono break-all hyphens-none ${styles.context}`}
              title={warning.context.length > 200 ? warning.context : undefined}
            >
              {warning.context}
            </p>
          )}
          <p className={`text-xs mt-1 break-words ${styles.text}`}>{warning.message}</p>
        </div>
      </div>
    </div>
  );
}

export function WarningBanner({ warnings }: { warnings: TxWarning[] }) {
  if (warnings.length === 0) return null;

  const sorted = [...warnings].sort((a, b) => {
    const order: Record<WarningSeverity, number> = { danger: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });

  return (
    <div className="space-y-2">
      {sorted.map((w, i) => (
        <WarningCard key={i} warning={w} />
      ))}
    </div>
  );
}
