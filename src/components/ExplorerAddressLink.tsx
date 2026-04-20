import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { getAddress } from 'ethers';
import { getExplorerUrl } from '../lib/chains.ts';
import { reverseResolveEnsDetailed } from '../lib/ensLookup.ts';
import { useChainUi } from '../context/ChainContext.tsx';

const COPY_FEEDBACK_MS = 1500;

function shortAddr(checksummed: string): string {
  if (checksummed.length < 14) return checksummed;
  return `${checksummed.slice(0, 6)}…${checksummed.slice(-4)}`;
}

export interface ExplorerAddressLinkProps {
  /** Raw or checksummed `0x` address. */
  address: string;
  chainId: number;
  /** Registry label (e.g. token symbol); shown after the link. */
  registryLabel?: string | null;
  /** Skip ENS RPC when offline / bundled-only mode. */
  offlineMode?: boolean;
  showCopy?: boolean;
  className?: string;
}

type ParsedAddress = { ok: true; checksummed: string } | { ok: false; raw: string };

function parseAddressProp(address: string): ParsedAddress {
  try {
    return { ok: true, checksummed: getAddress(address) };
  } catch {
    return { ok: false, raw: address };
  }
}

/**
 * Block-explorer link for an EVM address: shows **ENS** when resolved, else checksummed hex.
 * Explorer `href` uses `chainId`; **ENS reverse lookup is Ethereum mainnet only** (via `reverseResolveEnsDetailed`), independent of `chainId`.
 * Resolution shares module-level **in-flight dedupe** and a short **settled LRU cache** (`ensLookup.ts`) so repeated addresses avoid extra RPC.
 * RPC / invalid reverse-record outcomes surface a warning glyph; **no reverse** stays quiet. Copy uses the checksummed address.
 */
export function ExplorerAddressLink({
  address,
  chainId,
  registryLabel,
  offlineMode,
  showCopy = true,
  className,
}: ExplorerAddressLinkProps) {
  const { skipEns } = useChainUi();
  const parsed = useMemo(() => parseAddressProp(address), [address]);

  const [ensName, setEnsName] = useState<string | null>(null);
  const [ensLoading, setEnsLoading] = useState(false);
  const [ensIssue, setEnsIssue] = useState<
    null | { kind: 'rpc' } | { kind: 'invalid'; raw: string }
  >(null);

  const shouldResolveEns = parsed.ok && !offlineMode && !skipEns;

  useEffect(() => {
    if (!shouldResolveEns) return;
    const { checksummed } = parsed as { ok: true; checksummed: string };
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setEnsName(null);
      setEnsIssue(null);
      setEnsLoading(true);
    });
    void reverseResolveEnsDetailed(checksummed, { offlineMode: false })
      .then(st => {
        if (cancelled) return;
        setEnsLoading(false);
        if (st.status === 'resolved') {
          setEnsName(st.name);
          return;
        }
        setEnsName(null);
        if (st.status === 'rpc_unavailable') setEnsIssue({ kind: 'rpc' });
        else if (st.status === 'invalid_reverse_record') setEnsIssue({ kind: 'invalid', raw: st.raw });
        else setEnsIssue(null);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('ENS reverse lookup failed:', err);
        setEnsLoading(false);
        setEnsName(null);
        setEnsIssue({ kind: 'rpc' });
      });
    return () => {
      cancelled = true;
    };
  }, [parsed, shouldResolveEns]);

  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  /** DOM `setTimeout` handle (`number` in browsers; avoids `NodeJS.Timeout` mismatch under mixed typings). */
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!parsed.ok) return;
    const { checksummed } = parsed;
    try {
      await navigator.clipboard.writeText(checksummed);
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
      setCopyFailed(false);
      setCopied(true);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, COPY_FEEDBACK_MS);
    } catch (err) {
      console.error('Clipboard failed (address):', err);
      if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
      setCopied(false);
      setCopyFailed(true);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopyFailed(false);
      }, COPY_FEEDBACK_MS);
    }
  }, [parsed]);

  if (!parsed.ok) {
    return <span className={`font-mono text-gray-400 ${className ?? ''}`}>{parsed.raw}</span>;
  }

  const { checksummed } = parsed;
  const href = `${getExplorerUrl(chainId)}/address/${checksummed}`;
  const showEns = shouldResolveEns && Boolean(ensName);
  const primary = showEns ? ensName : checksummed;
  const linkMono = !showEns;

  const displayEnsIssue = shouldResolveEns ? ensIssue : null;
  const showEnsLoading = shouldResolveEns && ensLoading;

  const ensIssueTitle =
    displayEnsIssue?.kind === 'rpc'
      ? 'ENS reverse lookup failed (RPC). Showing checksummed address.'
      : displayEnsIssue?.kind === 'invalid'
        ? `Invalid reverse ENS record from resolver: ${displayEnsIssue.raw}`
        : undefined;

  const baseLinkTitle = showEns
    ? `${checksummed}${registryLabel ? ` · ${registryLabel}` : ''}`
    : registryLabel
      ? `${checksummed} · ${registryLabel}`
      : checksummed;
  const linkTitle = ensIssueTitle ? `${baseLinkTitle} — ${ensIssueTitle}` : baseLinkTitle;

  return (
    <span
      className={`inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0 ${className ?? ''}`}
      aria-busy={showEnsLoading || undefined}
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`text-sm text-purple-300 hover:text-purple-200 hover:underline break-all ${linkMono ? 'font-mono' : ''}`}
        title={linkTitle}
      >
        {primary}
      </a>
      {showEnsLoading ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[10px] text-gray-500"
          title="Resolving ENS on Ethereum…"
        >
          <span
            className="inline-block size-3 shrink-0 rounded-full border border-gray-500 border-t-transparent animate-spin"
            aria-hidden
          />
          <span className="sr-only">Resolving ENS</span>
        </span>
      ) : null}
      {displayEnsIssue ? (
        <span
          className="text-amber-400/90 shrink-0 select-none text-xs font-medium"
          title={ensIssueTitle}
          aria-label={ensIssueTitle}
        >
          ⚠
        </span>
      ) : null}
      {showEns && (
        <span className="font-mono text-[11px] text-gray-500 shrink-0" title={checksummed}>
          {shortAddr(checksummed)}
        </span>
      )}
      {registryLabel ? (
        <span className="text-purple-400/70 text-[11px] font-medium shrink-0">({registryLabel})</span>
      ) : null}
      {showCopy ? (
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="text-gray-600 hover:text-gray-400 transition-colors inline-flex shrink-0 items-center justify-center p-1 rounded touch-manipulation"
          title={copyFailed ? 'Copy failed' : copied ? 'Copied!' : 'Copy checksummed address'}
          aria-label={copyFailed ? 'Copy failed' : copied ? 'Copied' : 'Copy checksummed address'}
        >
          {copied ? (
            <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : copyFailed ? (
            <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          )}
        </button>
      ) : null}
    </span>
  );
}
