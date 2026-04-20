import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { formatEther } from 'ethers';
import type { DecodeResult } from '../types/index.ts';
import { useChainId, useOfflineMode } from '../context/ChainContext.tsx';
import { TreeExpansionProvider } from '../context/TreeExpansionContext.tsx';
import { getKnownPattern } from '../lib/knownPatterns.ts';
import { getChain, type ChainConfig } from '../lib/chains.ts';
import { getContractName } from '../lib/abiRegistry.ts';
import { tryParseBigInt } from '../lib/valueFormatter.ts';
import { DecodedCallNode } from './TreeNode.tsx';
import { TreeExpandToolbar } from './TreeExpandToolbar.tsx';
import { ExplorerAddressLink } from './ExplorerAddressLink.tsx';

type NativeTransferResult = Extract<DecodeResult, { status: 'native_transfer' }>;

function NativeTransferSummary({ row, chain }: { row: NativeTransferResult; chain: ChainConfig }) {
  const offlineMode = useOfflineMode();
  const wei = tryParseBigInt(row.value) ?? 0n;
  const ethExact = formatEther(wei);

  return (
    <div className="rounded-lg border border-gray-700/50 bg-gray-800/30 px-3 py-2 text-xs text-gray-400 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-gray-500">Tx:</span>
        <a
          href={`${chain.explorerUrl}/tx/${row.hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
        >
          {row.hash.slice(0, 10)}...{row.hash.slice(-8)}
        </a>
        {row.isPending && (
          <span className="px-1.5 py-0.5 rounded bg-yellow-900/60 text-yellow-300 border border-yellow-700/50 text-[10px]">
            Pending
          </span>
        )}
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <span>
          <span className="text-gray-500">From: </span>
          <ExplorerAddressLink
            key={`nt-from-${row.from}`}
            address={row.from}
            chainId={chain.id}
            registryLabel={getContractName(row.from, chain.id) ?? undefined}
            offlineMode={offlineMode}
          />
        </span>
        {row.to ? (
          <span>
            <span className="text-gray-500">To: </span>
            <ExplorerAddressLink
              key={`nt-to-${row.to}`}
              address={row.to}
              chainId={chain.id}
              registryLabel={getContractName(row.to, chain.id) ?? undefined}
              offlineMode={offlineMode}
            />
          </span>
        ) : (
          <span>
            <span className="text-gray-500">To: </span>
            <span className="text-gray-500 italic">— (contract creation)</span>
          </span>
        )}
        <span>
          <span className="text-gray-500">Value: </span>
          <span className="text-gray-300 font-mono break-all" title={ethExact}>
            {ethExact} {chain.nativeCurrency}
          </span>
        </span>
      </div>
      <div className="pt-1.5 mt-1 border-t border-gray-700/50">
        <span className="text-gray-500">Calldata: </span>
        <span className="font-mono text-gray-500">0x</span>
        <span className="text-gray-600 ml-2">(empty — no function call)</span>
      </div>
    </div>
  );
}

const CLIPBOARD_FEEDBACK_MS = 1500;

interface DecodeTreeProps {
  result: DecodeResult;
  /** Passed to the tree; nodes with `depth < autoExpandMaxDepth` start expanded (default `DEFAULT_AUTO_EXPAND_DEPTH` in `TreeNode.tsx`, currently 3). */
  autoExpandMaxDepth?: number;
  /**
   * URL copied by Share. When omitted, uses `window.location.href` (this app stores calldata in the hash, so the full URL is usually what you want).
   * Pass e.g. `${origin}${pathname}${search}` if the hash must not be shared.
   */
  shareUrl?: string;
}

function serializeResult(result: DecodeResult): string {
  return JSON.stringify(
    result,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );
}

/** Safe join for partial-decode messages (typed as `string[]` but may be widened at runtime). */
function joinPartialDecodeErrors(errors: readonly unknown[]): string {
  return errors
    .map(e => {
      if (typeof e === 'string') return e;
      if (e instanceof Error) return e.message;
      if (e != null && typeof e === 'object') {
        if ('message' in e && typeof (e as { message: unknown }).message === 'string') {
          return (e as { message: string }).message;
        }
        try {
          return JSON.stringify(e);
        } catch {
          /* ignore */
        }
      }
      return String(e);
    })
    .join(', ');
}

export function DecodeTree({ result, autoExpandMaxDepth, shareUrl }: DecodeTreeProps) {
  const chainId = useChainId();
  const chain = useMemo(() => getChain(chainId), [chainId]);

  const serializedJson = useMemo(() => serializeResult(result), [result]);

  /** Non-empty when the parent overrides the copied URL (deps only on `shareUrl`). */
  const shareUrlOverride = useMemo(() => (shareUrl ?? '').trim(), [shareUrl]);

  /**
   * Live `location.href` when the parent does not pass `shareUrl`. Recomputes when `serializedJson` changes so a
   * decode-driven `history.replaceState` hash update is reflected on the next copy. The `slice(0, 0)` noop keeps the
   * dependency explicit for readers and `react-hooks/exhaustive-deps` (same revision token as Copy JSON).
   */
  const shareUrlFromLocation = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return window.location.href + serializedJson.slice(0, 0);
  }, [serializedJson]);

  const resolvedShareUrl = shareUrlOverride || shareUrlFromLocation;

  const [showJson, setShowJson] = useState(false);
  const [copied, setCopied] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [jsonCopyFailed, setJsonCopyFailed] = useState(false);
  const [urlCopyFailed, setUrlCopyFailed] = useState(false);
  const [rawHexCopied, setRawHexCopied] = useState(false);
  const [rawHexCopyFailed, setRawHexCopyFailed] = useState(false);

  /** Full calldata in `#fragment` makes URLs huge; many tools truncate around a few KB–32KB. */
  const shareUrlTitle = useMemo(() => {
    if (urlCopyFailed) return 'Copy failed';
    if (resolvedShareUrl.length > 8000) {
      return 'Copy page URL (calldata is in the hash). This link is very long — some chat apps or logs may truncate it; copy calldata from the field above if sharing fails.';
    }
    return 'Copy page URL with calldata in the hash';
  }, [resolvedShareUrl, urlCopyFailed]);

  // Clipboard feedback: same ref + clearTimeout + unmount cleanup pattern as TreeNode CopyButton / CopyMenu.
  const jsonFeedbackTimerRef = useRef<number | null>(null);
  const urlFeedbackTimerRef = useRef<number | null>(null);
  const rawHexFeedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (jsonFeedbackTimerRef.current != null) {
        clearTimeout(jsonFeedbackTimerRef.current);
      }
      if (urlFeedbackTimerRef.current != null) {
        clearTimeout(urlFeedbackTimerRef.current);
      }
      if (rawHexFeedbackTimerRef.current != null) {
        clearTimeout(rawHexFeedbackTimerRef.current);
      }
    };
  }, []);

  const handleCopyJson = useCallback(() => {
    navigator.clipboard
      .writeText(serializedJson)
      .then(() => {
        if (jsonFeedbackTimerRef.current != null) {
          clearTimeout(jsonFeedbackTimerRef.current);
        }
        setJsonCopyFailed(false);
        setCopied(true);
        jsonFeedbackTimerRef.current = window.setTimeout(() => {
          jsonFeedbackTimerRef.current = null;
          setCopied(false);
          setJsonCopyFailed(false);
        }, CLIPBOARD_FEEDBACK_MS);
      })
      .catch((err: unknown) => {
        console.error('Clipboard failed (copy JSON):', err);
        if (jsonFeedbackTimerRef.current != null) {
          clearTimeout(jsonFeedbackTimerRef.current);
        }
        setCopied(false);
        setJsonCopyFailed(true);
        jsonFeedbackTimerRef.current = window.setTimeout(() => {
          jsonFeedbackTimerRef.current = null;
          setJsonCopyFailed(false);
        }, CLIPBOARD_FEEDBACK_MS);
      });
  }, [serializedJson]);

  const handleShareUrl = useCallback(() => {
    if (!resolvedShareUrl) {
      console.warn('DecodeTree Share: no URL to copy (empty resolvedShareUrl)');
      return;
    }
    navigator.clipboard
      .writeText(resolvedShareUrl)
      .then(() => {
        if (urlFeedbackTimerRef.current != null) {
          clearTimeout(urlFeedbackTimerRef.current);
        }
        setUrlCopyFailed(false);
        setUrlCopied(true);
        urlFeedbackTimerRef.current = window.setTimeout(() => {
          urlFeedbackTimerRef.current = null;
          setUrlCopied(false);
          setUrlCopyFailed(false);
        }, CLIPBOARD_FEEDBACK_MS);
      })
      .catch((err: unknown) => {
        console.error('Clipboard failed (share URL):', err);
        if (urlFeedbackTimerRef.current != null) {
          clearTimeout(urlFeedbackTimerRef.current);
        }
        setUrlCopied(false);
        setUrlCopyFailed(true);
        urlFeedbackTimerRef.current = window.setTimeout(() => {
          urlFeedbackTimerRef.current = null;
          setUrlCopyFailed(false);
        }, CLIPBOARD_FEEDBACK_MS);
      });
  }, [resolvedShareUrl]);

  const calldataClipboardHex = useMemo(() => {
    if (result.status === 'error') return result.rawHex.trim();
    if (result.status === 'success' || result.status === 'partial') return (result.call.rawCalldata ?? '').trim();
    return '';
  }, [result]);

  const canCopyCalldata = calldataClipboardHex.length > 0;

  const handleCopyCalldata = useCallback(() => {
    if (!calldataClipboardHex) return;
    navigator.clipboard
      .writeText(calldataClipboardHex)
      .then(() => {
        if (rawHexFeedbackTimerRef.current != null) {
          clearTimeout(rawHexFeedbackTimerRef.current);
        }
        setRawHexCopyFailed(false);
        setRawHexCopied(true);
        rawHexFeedbackTimerRef.current = window.setTimeout(() => {
          rawHexFeedbackTimerRef.current = null;
          setRawHexCopied(false);
          setRawHexCopyFailed(false);
        }, CLIPBOARD_FEEDBACK_MS);
      })
      .catch((err: unknown) => {
        console.error('Clipboard failed (copy calldata):', err);
        if (rawHexFeedbackTimerRef.current != null) {
          clearTimeout(rawHexFeedbackTimerRef.current);
        }
        setRawHexCopied(false);
        setRawHexCopyFailed(true);
        rawHexFeedbackTimerRef.current = window.setTimeout(() => {
          rawHexFeedbackTimerRef.current = null;
          setRawHexCopyFailed(false);
        }, CLIPBOARD_FEEDBACK_MS);
      });
  }, [calldataClipboardHex]);

  const isError = result.status === 'error';
  const isNativeTransfer = result.status === 'native_transfer';

  const decodeTreeSessionKey = useMemo(() => {
    if (result.status !== 'success' && result.status !== 'partial') return 'none';
    const raw = result.call.rawCalldata ?? '';
    return `${result.call.selector}:${raw.length}:${raw.slice(0, 48)}`;
  }, [result]);

  const clipboardStatusMessage = useMemo(() => {
    if (urlCopyFailed) return 'Could not copy share link to clipboard.';
    if (urlCopied) return 'Share link copied to clipboard.';
    if (jsonCopyFailed) return 'Could not copy JSON to clipboard.';
    if (copied) return 'JSON copied to clipboard.';
    if (rawHexCopyFailed) return 'Could not copy calldata to clipboard.';
    if (rawHexCopied) return 'Calldata copied to clipboard.';
    return '';
  }, [urlCopyFailed, urlCopied, jsonCopyFailed, copied, rawHexCopyFailed, rawHexCopied]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-gray-400">
          {isError ? 'Decode failed' : isNativeTransfer ? 'Transaction (no calldata)' : 'Decoded Transaction'}
        </h3>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleShareUrl}
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors flex items-center gap-1"
          title={shareUrlTitle}
          disabled={!resolvedShareUrl}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          {urlCopyFailed ? 'Copy failed' : urlCopied ? 'Link Copied!' : 'Share'}
        </button>
        <button
          type="button"
          onClick={handleCopyJson}
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors flex items-center gap-1"
          title={jsonCopyFailed ? 'Copy failed' : undefined}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          {jsonCopyFailed ? 'Copy failed' : copied ? 'Copied!' : 'Copy JSON'}
        </button>
        {canCopyCalldata && (
          <button
            type="button"
            onClick={handleCopyCalldata}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors flex items-center gap-1"
            title={
              rawHexCopyFailed
                ? 'Copy failed'
                : 'Copy raw input calldata (hex) to the clipboard'
            }
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {rawHexCopyFailed ? 'Copy failed' : rawHexCopied ? 'Copied!' : 'Copy calldata'}
          </button>
        )}
        {!isError && (
          <button
            type="button"
            onClick={() => setShowJson(!showJson)}
            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
            aria-pressed={showJson}
            aria-label={
              showJson
                ? isNativeTransfer
                  ? 'Switch to summary view'
                  : 'Switch to tree view'
                : 'Switch to JSON view'
            }
          >
            {showJson
              ? isNativeTransfer
                ? 'Summary'
                : 'Tree View'
              : 'JSON View'}
          </button>
        )}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {clipboardStatusMessage}
        </span>
      </div>

      {isError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-950/20 p-4">
          <div className="flex items-center gap-2 mb-2">
            <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h4 className="text-sm font-semibold text-red-400">Could not decode</h4>
          </div>
          <p className="text-sm text-red-300/70">{result.error}</p>
          {result.selector && (
            <p className="mt-2 text-xs text-red-300/50 font-mono">
              Selector: {result.selector}
            </p>
          )}
          <div className="mt-3">
            <p className="text-xs text-gray-500 mb-1">Raw calldata:</p>
            <div className="text-xs font-mono text-gray-600 break-all bg-gray-900/50 rounded p-2 max-h-32 overflow-y-auto">
              {result.rawHex}
            </div>
          </div>
        </div>
      ) : isNativeTransfer ? (
        <>
          <div className="rounded-lg border border-sky-500/25 bg-sky-950/20 p-4">
            <p className="text-sm text-sky-200/90 leading-relaxed">{result.message}</p>
          </div>
          <NativeTransferSummary row={result} chain={chain} />
          {showJson && (
            <pre className="text-xs font-mono text-gray-400 bg-gray-900/50 rounded-lg p-4 overflow-x-auto max-h-[600px] overflow-y-auto border border-gray-800">
              {serializedJson}
            </pre>
          )}
        </>
      ) : (
        <>
          {result.status === 'partial' && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-950/20 p-3">
              <p className="text-xs text-yellow-400">
                Partial decode: {joinPartialDecodeErrors(result.errors)}
              </p>
            </div>
          )}

          {getKnownPattern(result.call.selector)?.requiresSpecialHandling && (
            <div className="rounded-lg border border-amber-500/25 bg-amber-950/15 p-3">
              <p className="text-xs text-amber-200/90 leading-relaxed">
                This function uses <span className="font-mono text-amber-100/95">non-standard packed encoding</span>{' '}
                for part of the calldata (e.g. Gnosis Safe <span className="font-mono">multiSend</span>: 1-byte
                operation + 20-byte address + 32-byte value + 32-byte length + variable <span className="font-mono">data</span>).
                The decoder follows that layout; truncated or malformed blobs may show partial segments only.
              </p>
            </div>
          )}

          {showJson ? (
            <pre className="text-xs font-mono text-gray-400 bg-gray-900/50 rounded-lg p-4 overflow-x-auto max-h-[600px] overflow-y-auto border border-gray-800">
              {serializedJson}
            </pre>
          ) : (
            <TreeExpansionProvider key={decodeTreeSessionKey}>
              <div className="flex justify-end mb-1 min-h-[1.5rem]">
                <TreeExpandToolbar />
              </div>
              {/* Deep `pl-3` nesting can overflow narrow viewports; allow horizontal scroll without clipping focus rings */}
              <div className="min-w-0 overflow-x-auto">
                <DecodedCallNode call={result.call} autoExpandMaxDepth={autoExpandMaxDepth} />
              </div>
            </TreeExpansionProvider>
          )}
        </>
      )}
    </div>
  );
}
