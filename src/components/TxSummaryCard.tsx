import { useMemo } from 'react';
import type { DecodedCall, UniswapV3Path } from '../types/index.ts';
import { useChainId } from '../context/ChainContext.ts';
import { getExplorerUrl } from '../lib/chains.ts';
import { summarizeTransaction, type SummaryPart } from '../lib/txSummary.ts';

function formatFee(fee: number): string {
  return `${Number((fee / 10_000).toFixed(4))}%`;
}

function AddressText({ address, label, chainId }: { address: string; label?: string; chainId: number }) {
  // Unlabelled addresses are shown in full: shortened ones are what address-poisoning look-alikes rely on.
  return (
    <a
      href={`${getExplorerUrl(chainId)}/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className={label ? 'text-purple-300 hover:underline' : 'font-mono text-[0.8125rem] text-purple-300 hover:underline break-all'}
      title={address}
    >
      {label ?? address}
    </a>
  );
}

function PathText({ path, chainId }: { path: UniswapV3Path; chainId: number }) {
  const tokens = path.exactOut ? [...path.tokens].reverse() : path.tokens;
  const fees = path.exactOut ? [...path.fees].reverse() : path.fees;
  return (
    <span className="inline">
      {tokens.map((t, i) => (
        <span key={`${t.address}-${i}`}>
          <AddressText
            address={t.address}
            label={t.symbol ? (t.unverified ? `"${t.symbol}"` : t.symbol) : `${t.address.slice(0, 8)}…${t.address.slice(-6)}`}
            chainId={chainId}
          />
          {i < fees.length && <span className="text-gray-500"> → </span>}
        </span>
      ))}
      <span className="text-gray-500"> ({fees.map(formatFee).join(', ')} pool{fees.length === 1 ? '' : 's'})</span>
    </span>
  );
}

function Part({ part, chainId }: { part: SummaryPart; chainId: number }) {
  switch (part.kind) {
    case 'text':
      return <>{part.text}</>;
    case 'amount':
      return part.caution ? (
        <span className="font-medium text-amber-300 underline decoration-dotted underline-offset-2" title={part.caution}>
          {part.text}
        </span>
      ) : (
        <span className="font-medium text-gray-100">{part.text}</span>
      );
    case 'address':
      return <AddressText address={part.address} label={part.label} chainId={chainId} />;
    case 'path':
      return <PathText path={part.path} chainId={chainId} />;
  }
}

/** "What this transaction does": one plain-language line per step, each linking to its node in the tree. */
export function TxSummaryCard({ call, onShowInTree }: { call: DecodedCall; onShowInTree: (callIndex: number) => void }) {
  const chainId = useChainId();
  const { steps, omitted } = useMemo(() => summarizeTransaction(call, chainId), [call, chainId]);
  if (steps.length === 0) return null;

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 sm:p-6" aria-labelledby="tx-summary-heading">
      <h2 id="tx-summary-heading" className="text-sm font-medium text-gray-400 mb-3">
        What this transaction does
      </h2>
      <ol className="space-y-2">
        {steps.map((step, i) => (
          <li
            key={`${step.callIndex}-${i}`}
            className="flex items-start gap-3 min-w-0"
            style={{ paddingLeft: `${Math.min(step.nesting, 4) * 1.25}rem` }}
          >
            <span className="mt-0.5 text-xs font-mono text-gray-500 w-5 shrink-0 text-right" aria-hidden>
              {step.nesting === 0 ? `${i + 1}.` : '–'}
            </span>
            <p className="min-w-0 flex-1 text-sm text-gray-300 leading-relaxed break-words">
              {step.parts.map((part, j) => (
                <Part key={j} part={part} chainId={chainId} />
              ))}
              {step.guessed && (
                <span
                  className="ml-2 text-[10px] px-1.5 py-0.5 rounded border bg-orange-950/50 text-orange-300 border-orange-800/50"
                  title="Found by probing opaque bytes. It may be a coincidental match."
                >
                  guessed
                </span>
              )}
              {step.allowRevert && (
                <span
                  className="ml-2 text-[10px] px-1.5 py-0.5 rounded border bg-gray-800 text-gray-400 border-gray-700"
                  title="The router continues if this step fails."
                >
                  may fail
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={() => onShowInTree(step.callIndex)}
              className="shrink-0 text-xs text-gray-500 hover:text-gray-300 underline-offset-2 hover:underline"
              aria-label={`Show step ${i + 1} in the decoded tree`}
            >
              <span className="sm:hidden" aria-hidden>
                Tree ↓
              </span>
              <span className="hidden sm:inline">Show in tree</span>
            </button>
          </li>
        ))}
      </ol>
      {omitted > 0 && (
        <p className="mt-3 text-xs text-gray-500">
          {omitted} more step{omitted === 1 ? '' : 's'} in the decoded tree below.
        </p>
      )}
    </section>
  );
}
