import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { DecodeResult, DecodeOptions, TxWarning } from './types/index.ts';
import { decodeCalldata, truncateHexForErrorPreview } from './lib/decoder.ts';
import { DEFAULT_DECODE_OPTIONS } from './types/index.ts';
import { CalldataInput } from './components/CalldataInput.tsx';
import { DecodeTree } from './components/DecodeTree.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { WarningBanner } from './components/WarningBanner.tsx';
import { validateHexInput } from './lib/sanitize.ts';
import { ChainProvider } from './context/ChainContext.tsx';
import { DEFAULT_CHAIN_ID } from './lib/chains.ts';
import { analyzeWarnings } from './lib/warningAnalyzer.ts';
import { SAMPLE_DEV_WARNINGS } from './lib/sampleWarnings.ts';
import { DEFAULT_AUTO_EXPAND_DEPTH } from './components/TreeNode.tsx';
import type { TxFetchContext } from './lib/txFetcher.ts';

const isDev = import.meta.env.DEV;

/** Strip `#…` while keeping pathname and query (e.g. `?expand=`). */
function clearUrlHash(): void {
  try {
    const { pathname, search } = window.location;
    history.replaceState(null, '', `${pathname}${search}`);
  } catch {
    /* ignore navigation errors */
  }
}

/** `?expand=N` — initial tree auto-expand depth (clamped). */
function readAutoExpandMaxDepthFromUrl(): number {
  try {
    const raw = new URLSearchParams(window.location.search).get('expand');
    if (raw == null || raw === '') return DEFAULT_AUTO_EXPAND_DEPTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_AUTO_EXPAND_DEPTH;
    return Math.min(20, Math.max(1, Math.floor(n)));
  } catch {
    return DEFAULT_AUTO_EXPAND_DEPTH;
  }
}

function getCalldataFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash || hash.length < 3) return null;
  try {
    const decoded = decodeURIComponent(hash.slice(1));
    const result = validateHexInput(decoded);
    if (result.valid) return result.normalized;
  } catch { /* invalid hash */ }
  return null;
}

export default function App() {
  const [result, setResult] = useState<DecodeResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [decodeTimeMs, setDecodeTimeMs] = useState<number | null>(null);
  const [initialCalldata, setInitialCalldata] = useState<string | null>(null);
  const [chainId, setChainId] = useState(DEFAULT_CHAIN_ID);
  const [offlineMode, setOfflineMode] = useState(false);
  const [skipEns, setSkipEns] = useState(false);
  const [previewSampleWarnings, setPreviewSampleWarnings] = useState(false);
  const [autoExpandMaxDepth, setAutoExpandMaxDepth] = useState(() => readAutoExpandMaxDepthFromUrl());

  const decodeAbortRef = useRef<AbortController | null>(null);

  const chainUi = useMemo(
    () => ({ chainId, offlineMode, setOfflineMode, skipEns, setSkipEns }),
    [chainId, offlineMode, skipEns],
  );

  const abortInFlightDecode = useCallback(() => {
    decodeAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    return () => {
      decodeAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    decodeAbortRef.current?.abort();
  }, [chainId]);

  /** Keep `?expand=` in sync with back/forward and any `history.pushState` / `replaceState` (incl. this app). */
  useEffect(() => {
    const syncExpandFromUrl = () => {
      setAutoExpandMaxDepth(readAutoExpandMaxDepthFromUrl());
    };
    syncExpandFromUrl();
    window.addEventListener('popstate', syncExpandFromUrl);
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = (...args: Parameters<History['pushState']>) => {
      origPush(...args);
      syncExpandFromUrl();
    };
    history.replaceState = (...args: Parameters<History['replaceState']>) => {
      origReplace(...args);
      syncExpandFromUrl();
    };
    return () => {
      window.removeEventListener('popstate', syncExpandFromUrl);
      history.pushState = origPush;
      history.replaceState = origReplace;
    };
  }, []);

  const handleDecode = useCallback(async (
    calldata: string,
    abi: string | undefined,
    offlineMode: boolean,
    msgValueWei?: string,
    txTo?: string | null,
    txFetchContext?: TxFetchContext | null,
  ) => {
    decodeAbortRef.current?.abort();
    setPreviewSampleWarnings(false);

    const calldataNorm = calldata.trim().toLowerCase();
    const isEmptyCalldata = calldataNorm === '0x' || calldataNorm === '';
    if (isEmptyCalldata && txFetchContext) {
      decodeAbortRef.current = null;
      setDecodeTimeMs(null);
      setIsLoading(false);
      clearUrlHash();
      setResult({
        status: 'native_transfer',
        message:
          'This transaction has no contract calldata. It is a simple native currency transfer (no function call to decode).',
        hash: txFetchContext.hash,
        from: txFetchContext.from,
        to: txFetchContext.to,
        value: txFetchContext.value,
        isPending: txFetchContext.isPending,
        warnings: [
          {
            severity: 'info',
            title: 'No contract calldata',
            message:
              'There is no function selector or ABI payload. Inspect from, to, and value above; use the explorer link for full receipt details.',
          },
        ],
      });
      return;
    }

    const ac = new AbortController();
    decodeAbortRef.current = ac;

    setIsLoading(true);
    setResult(null);
    setDecodeTimeMs(null);

    const start = performance.now();

    try {
      const decodeWarningSink: TxWarning[] = [];
      const options: DecodeOptions = {
        ...DEFAULT_DECODE_OPTIONS,
        chainId,
        offlineMode,
        resolveEns: !offlineMode && !skipEns,
        userAbi: abi,
        decodeWarningSink,
        signal: ac.signal,
        callTarget: txTo?.trim() || undefined,
      };

      const decoded = await decodeCalldata(calldata, options);

      if (ac.signal.aborted) return;

      if (decoded.status === 'error') {
        clearUrlHash();
        setResult(decoded);
      } else {
        try {
          const { pathname, search } = window.location;
          history.replaceState(null, '', `${pathname}${search}#${calldata}`);
        } catch {
          /* ignore navigation errors */
        }

        const heuristicWarnings = analyzeWarnings(decoded.call, msgValueWei, { txTo, chainId });
        const merged = [...decodeWarningSink, ...heuristicWarnings];
        if (merged.length > 0) {
          decoded.warnings = merged;
        }

        setResult(decoded);
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      clearUrlHash();
      setResult({
        status: 'error',
        error: err instanceof Error ? err.message : 'Unexpected error during decoding',
        rawHex: truncateHexForErrorPreview(calldata),
      });
    } finally {
      if (decodeAbortRef.current === ac) {
        if (!ac.signal.aborted) {
          setDecodeTimeMs(Math.round(performance.now() - start));
        }
        setIsLoading(false);
        decodeAbortRef.current = null;
      }
    }
  }, [chainId, skipEns]);

  /**
   * When the URL fragment holds valid calldata, treat it as source of truth: sync `CalldataInput` and decode.
   * Re-runs when `chainId` changes so registry/RPC context matches. If the user clears the textarea but leaves
   * the hash, a chain change will re-fill from the fragment and decode again (same as reloading with that URL).
   */
  useEffect(() => {
    const hashCalldata = getCalldataFromHash();
    if (hashCalldata) {
      setInitialCalldata(hashCalldata);
      void handleDecode(hashCalldata, undefined, offlineMode);
    }
  }, [chainId, handleDecode, offlineMode, skipEns]);

  return (
    <ChainProvider value={chainUi}>
      <div className="min-h-screen bg-gray-950">
        <div className="max-w-6xl mx-auto px-2 sm:px-4 py-6 sm:py-10">
          <header className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
              Recursive Calldata Decoder
            </h1>
            <p className="mt-2 text-sm text-gray-500 max-w-2xl">
              Decode EVM transaction calldata recursively. Multicalls, batched transactions,
              and nested calls are fully expanded into a human-readable tree.
            </p>
          </header>

          <main className="space-y-6">
            <section className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 sm:p-6">
              <CalldataInput
                onDecode={handleDecode}
                onAbortInFlightDecode={abortInFlightDecode}
                isLoading={isLoading}
                initialCalldata={initialCalldata}
                chainId={chainId}
                onChainChange={setChainId}
              />
              {isDev && (
                <div className="mt-4 pt-4 border-t border-gray-800 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPreviewSampleWarnings(v => !v)}
                    className="text-xs px-2.5 py-1 rounded-md border border-amber-900/60 bg-amber-950/40 text-amber-200/90 hover:bg-amber-950/70"
                  >
                    {previewSampleWarnings ? 'Hide sample warnings' : 'Preview sample warnings'}
                  </button>
                  <span className="text-[11px] text-gray-600">Dev only — not in production build</span>
                </div>
              )}
            </section>

            {isLoading && (
              <div
                className="flex items-center justify-center py-12"
                role="status"
                aria-live="polite"
                aria-busy="true"
              >
                <div className="flex items-center gap-3 text-gray-500">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-sm">Decoding calldata...</span>
                </div>
              </div>
            )}

            {isDev && previewSampleWarnings && !isLoading && (
              <section>
                <p className="text-xs text-amber-500/90 mb-2 font-medium">Sample warning styles (dev preview)</p>
                <WarningBanner warnings={SAMPLE_DEV_WARNINGS} />
              </section>
            )}

            {result && !isLoading && result.status !== 'error' && result.warnings && result.warnings.length > 0 && (
              <section>
                <WarningBanner warnings={result.warnings} />
              </section>
            )}

            {result && !isLoading && (
              <section className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 sm:p-6 overflow-x-auto min-w-0">
                <ErrorBoundary>
                  <DecodeTree result={result} autoExpandMaxDepth={autoExpandMaxDepth} />
                </ErrorBoundary>
                {decodeTimeMs !== null && (
                  <p className="mt-4 text-xs text-gray-700 text-right">
                    Decoded in {decodeTimeMs}ms
                  </p>
                )}
              </section>
            )}

            {!result && !isLoading && (
              <section className="rounded-xl border border-gray-800/50 bg-gray-900/20 p-6 sm:p-8">
                <div className="text-center">
                  <div className="text-4xl mb-4 opacity-20">{ '{...}' }</div>
                  <h3 className="text-sm font-medium text-gray-600 mb-2">Paste calldata or a transaction hash to get started</h3>
                  <p className="text-xs text-gray-700 max-w-md mx-auto">
                    Supports multicall, aggregate, batch transactions, Gnosis Safe multiSend,
                    Uniswap Universal Router, and any nested ABI-encoded calls. Paste a tx hash
                    to fetch calldata directly from the blockchain.
                  </p>
                </div>
              </section>
            )}
          </main>

          <footer className="mt-12 pt-6 border-t border-gray-900 text-center">
            <p className="text-xs text-gray-700">
              Pure client-side. No data leaves your browser.
              Signatures via{' '}
              <a
                href="https://4byte.sourcify.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-600 hover:text-gray-400"
                aria-label="Sourcify 4byte function signature database (opens in new tab)"
              >
                Sourcify 4byte
              </a>
              ,{' '}
              <a
                href="https://openchain.xyz"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-600 hover:text-gray-400"
                aria-label="OpenChain.xyz function signature lookup (opens in new tab)"
              >
                openchain.xyz
              </a>
              , &{' '}
              <a
                href="https://www.4byte.directory"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-600 hover:text-gray-400"
                aria-label="4byte.directory function signature lookup (opens in new tab)"
              >
                4byte.directory
              </a>
            </p>
          </footer>
        </div>
      </div>
    </ChainProvider>
  );
}
