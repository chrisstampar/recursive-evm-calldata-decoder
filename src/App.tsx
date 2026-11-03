import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { DecodeResult, DecodeOptions, TxWarning } from './types/index.ts';
import { decodeCalldata, truncateHexForErrorPreview } from './lib/decoder.ts';
import { DEFAULT_DECODE_OPTIONS } from './types/index.ts';
import { CalldataInput } from './components/CalldataInput.tsx';
import { DecodeTree } from './components/DecodeTree.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { WarningBanner } from './components/WarningBanner.tsx';
import { TxSummaryCard } from './components/TxSummaryCard.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { useRevealCall } from './components/useRevealCall.ts';
import { TreeExpansionProvider } from './context/TreeExpansionContext.tsx';
import { validateHexInput } from './lib/sanitize.ts';
import { ChainProvider } from './context/ChainContext.ts';
import { CHAINS, DEFAULT_CHAIN_ID } from './lib/chains.ts';
import { analyzeWarnings } from './lib/warningAnalyzer.ts';
import { SAMPLE_DEV_WARNINGS } from './lib/sampleWarnings.ts';
import { DEFAULT_AUTO_EXPAND_DEPTH } from './components/TreeNode.tsx';
import type { DecodeRequest } from './lib/decodeRequest.ts';
import type { SigningContext } from './lib/signing.ts';
import { annotateTypedDataCall, typedDataWarnings } from './lib/typedData.ts';
import { lookalikeWarnings } from './lib/addressBook.ts';
import { AddressBookProvider, useAddressBook } from './context/AddressBookContext.tsx';
import { AddressBookPanel } from './components/AddressBookPanel.tsx';
import { SigningHashesCard } from './components/SigningHashesCard.tsx';

const isDev = import.meta.env.DEV;

const SOURCE_REPO_URL = 'https://github.com/chrisstampar/recursive-evm-calldata-decoder';

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

/** `?chain=<id>` — chain the shared calldata was decoded on (labels, decimals and explorer links are per chain). */
function readChainIdFromUrl(): number {
  try {
    const raw = new URLSearchParams(window.location.search).get('chain');
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) && CHAINS[n] ? n : DEFAULT_CHAIN_ID;
  } catch {
    return DEFAULT_CHAIN_ID;
  }
}

/** Current query string with `chain` set (keeps `?expand=` and anything else). */
function searchWithChain(chainId: number): string {
  try {
    const params = new URLSearchParams(window.location.search);
    if (chainId === DEFAULT_CHAIN_ID) params.delete('chain');
    else params.set('chain', String(chainId));
    const q = params.toString();
    return q ? `?${q}` : '';
  } catch {
    return window.location.search;
  }
}

/** The last decode and its chain, so a chain / Offline / ENS toggle re-runs it with the same input. */
interface LastDecode {
  request: DecodeRequest;
  chainId: number;
  /** Waiting for the chain the input names to be selected before it runs. */
  pending?: boolean;
}

/** Shown with a result: what is being signed, who sends it, and how to head the summary. */
interface ResultMeta {
  signing?: SigningContext;
  parties: { address: string | null | undefined; role: string }[];
  kind: 'transaction' | 'signature';
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

/** Identity of a result for resetting tree state (expansion, reveal) between decodes. */
function resultKey(result: DecodeResult): string {
  if (result.status === 'success' || result.status === 'partial') {
    const raw = result.call.rawCalldata ?? '';
    return `${result.status}:${raw.length}:${raw.slice(0, 48)}`;
  }
  return result.status === 'error' ? `error:${result.rawHex.slice(0, 48)}` : `native:${result.hash}`;
}

/**
 * Summary, then warnings, then the full tree. They share one expansion provider so "Show in tree" in the summary
 * and warnings can open the tree down to a call.
 */
function ResultPanels({
  result,
  meta,
  decodeTimeMs,
  autoExpandMaxDepth,
}: {
  result: DecodeResult;
  meta: ResultMeta | null;
  decodeTimeMs: number | null;
  autoExpandMaxDepth: number;
}) {
  const root = result.status === 'success' || result.status === 'partial' ? result.call : null;
  const showInTree = useRevealCall(root);
  const { entries } = useAddressBook();
  const baseWarnings = result.status === 'error' ? undefined : result.warnings;
  const parties = meta?.parties;
  // Look-alikes are checked here, not at decode time, so adding to the address book updates the open result.
  const warnings = useMemo(() => {
    const extra =
      result.status === 'native_transfer'
        ? [{ address: result.to, role: 'recipient' }, { address: result.from, role: 'sender' }]
        : (parties ?? []);
    return [...lookalikeWarnings(root, entries, extra), ...(baseWarnings ?? [])];
  }, [root, entries, parties, baseWarnings, result]);

  return (
    <>
      {meta?.signing && <SigningHashesCard ctx={meta.signing} />}

      {root && (
        <TxSummaryCard
          call={root}
          onShowInTree={showInTree}
          heading={meta?.kind === 'signature' ? 'What this signature allows' : undefined}
        />
      )}

      {warnings.length > 0 && (
        <section>
          <WarningBanner warnings={warnings} onShowInTree={root ? showInTree : undefined} />
        </section>
      )}

      <section className="overflow-x-auto min-w-0">
        <ErrorBoundary>
          <DecodeTree
            result={result}
            autoExpandMaxDepth={autoExpandMaxDepth}
            synthetic={meta?.kind === 'signature' ? 'signature' : meta?.signing?.kind === 'safe' ? 'safe' : undefined}
          />
        </ErrorBoundary>
        {decodeTimeMs !== null && (
          <p className="mt-4 text-xs text-gray-500 text-right">
            Decoded in {decodeTimeMs}ms
          </p>
        )}
      </section>
    </>
  );
}

export default function App() {
  const [result, setResult] = useState<DecodeResult | null>(null);
  const [resultMeta, setResultMeta] = useState<ResultMeta | null>(null);
  const [addressBookOpen, setAddressBookOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [decodeTimeMs, setDecodeTimeMs] = useState<number | null>(null);
  const [initialCalldata, setInitialCalldata] = useState<string | null>(null);
  const [chainId, setChainId] = useState(() => readChainIdFromUrl());
  const [offlineMode, setOfflineMode] = useState(false);
  const [skipEns, setSkipEns] = useState(false);
  const [previewSampleWarnings, setPreviewSampleWarnings] = useState(false);
  const [autoExpandMaxDepth, setAutoExpandMaxDepth] = useState(() => readAutoExpandMaxDepthFromUrl());
  /** Input shrinks to one line once something decoded; "Edit input" opens it again. */
  const [inputCollapsed, setInputCollapsed] = useState(false);

  const decodeAbortRef = useRef<AbortController | null>(null);
  const lastDecodeRef = useRef<LastDecode | null>(null);

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

  const handleDecode = useCallback(async (request: DecodeRequest, offlineMode: boolean) => {
    decodeAbortRef.current?.abort();
    setPreviewSampleWarnings(false);

    // The input names its own chain (signed transaction, typed-data domain): select it first. The chain effect below
    // then runs this request, after the chain switch has cancelled whatever was in flight.
    const decodeChainId = request.chainId ?? chainId;
    if (decodeChainId !== chainId) {
      lastDecodeRef.current = { request, chainId: decodeChainId, pending: true };
      setChainId(decodeChainId);
      return;
    }
    lastDecodeRef.current = { request, chainId };

    const { calldata, abi, msgValueWei, txTo, txFetchContext, typedData } = request;
    const extraWarnings = request.extraWarnings ?? [];
    const meta: ResultMeta = {
      signing: request.signing,
      parties: [
        { address: txTo, role: 'recipient' },
        { address: request.from ?? txFetchContext?.from, role: 'sender' },
      ],
      kind: request.kind ?? 'transaction',
    };
    // Typed data and Safe forms are not calldata anyone sent: keep them out of the shareable URL.
    const shareable = !request.signing && !typedData;

    const calldataNorm = calldata.trim().toLowerCase();
    const isEmptyCalldata = calldataNorm === '0x' || calldataNorm === '';
    if (isEmptyCalldata && txFetchContext) {
      decodeAbortRef.current = null;
      setDecodeTimeMs(null);
      setIsLoading(false);
      clearUrlHash();
      setResultMeta(meta);
      setResult({
        status: 'native_transfer',
        message:
          'This transaction has no contract calldata, so there is no function call to decode. It sends only the value shown, plus anything the warnings above describe.',
        hash: txFetchContext.hash,
        from: txFetchContext.from,
        to: txFetchContext.to,
        value: txFetchContext.value,
        isPending: txFetchContext.isPending,
        warnings: [
          ...extraWarnings,
          {
            severity: 'info',
            title: 'No contract calldata',
            message:
              'There is no function selector or ABI payload. Inspect from, to, and value above; use the explorer link for full receipt details.',
          },
        ],
      });
      setInputCollapsed(true);
      return;
    }

    const ac = new AbortController();
    decodeAbortRef.current = ac;

    setIsLoading(true);
    setResult(null);
    setResultMeta(null);
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
        setInputCollapsed(false);
      } else {
        try {
          // Chain goes in the query so a shared link decodes with the same registry, decimals and explorer.
          if (shareable) history.replaceState(null, '', `${window.location.pathname}${searchWithChain(chainId)}#${calldata}`);
          else clearUrlHash();
        } catch {
          /* ignore navigation errors */
        }

        if (typedData) await annotateTypedDataCall(decoded.call, typedData, options);
        if (ac.signal.aborted) return;

        // A typed message's verifying contract is not a call target: its registry notices would describe calldata.
        const heuristicWarnings = analyzeWarnings(decoded.call, msgValueWei, { txTo: typedData ? undefined : txTo, chainId });
        const merged = [
          ...extraWarnings,
          ...(typedData ? typedDataWarnings(typedData, decoded.call, chainId) : []),
          ...decodeWarningSink,
          ...heuristicWarnings,
        ];
        if (merged.length > 0) {
          decoded.warnings = merged;
        }

        setResultMeta(meta);
        setResult(decoded);
        setInputCollapsed(true);
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
   * Chain, Offline or Skip-ENS changed (or first load): re-run the last decode with the same input so nothing the user
   * supplied is silently dropped. Input that belongs to a chain (a fetched or pasted transaction, typed data) is
   * cleared instead of being decoded against another chain. A request waiting for its chain to be selected runs now.
   * With no prior decode, a valid URL fragment is the source of truth (shared link / reload).
   */
  useEffect(() => {
    const last = lastDecodeRef.current;
    if (last) {
      if (last.pending) {
        if (last.chainId === chainId) void handleDecode(last.request, offlineMode);
        return;
      }
      const boundToChain = Boolean(last.request.txFetchContext) || last.request.chainId !== undefined;
      if (boundToChain && last.chainId !== chainId) {
        lastDecodeRef.current = null;
        decodeAbortRef.current?.abort();
        setResult(null);
        setResultMeta(null);
        setDecodeTimeMs(null);
        clearUrlHash();
        return;
      }
      void handleDecode(last.request, offlineMode);
      return;
    }
    const hashCalldata = getCalldataFromHash();
    if (hashCalldata) {
      setInitialCalldata(hashCalldata);
      void handleDecode({ calldata: hashCalldata }, offlineMode);
    }
  }, [chainId, handleDecode, offlineMode, skipEns]);

  /**
   * Editing or pasting a different `#calldata` into the address bar doesn't reload the page; decode it as new input.
   * (`history.replaceState` from our own decodes never fires `hashchange`.)
   */
  useEffect(() => {
    const onHashChange = () => {
      const hashCalldata = getCalldataFromHash();
      if (!hashCalldata) return;
      const last = lastDecodeRef.current;
      const lastNorm = last ? validateHexInput(last.request.calldata) : null;
      if (lastNorm?.valid && lastNorm.normalized === hashCalldata) return;
      lastDecodeRef.current = null;
      setInitialCalldata(hashCalldata);
      void handleDecode({ calldata: hashCalldata }, offlineMode);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [handleDecode, offlineMode]);

  return (
    <ChainProvider value={chainUi}>
      <AddressBookProvider>
        <div className="min-h-screen bg-gray-950">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
            <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="min-w-0">
                <h1 className="text-2xl sm:text-3xl font-bold text-gray-50 tracking-tight">
                  Recursive Calldata Decoder
                </h1>
                <p className="mt-2 text-sm text-gray-500 max-w-2xl">
                  Decode EVM transaction calldata recursively. Multicalls, batched transactions,
                  and nested calls are fully expanded into a human-readable tree.
                </p>
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <AddressBookButton open={addressBookOpen} onToggle={() => setAddressBookOpen(o => !o)} />
                <ThemeToggle />
                <a
                  href={SOURCE_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-gray-500 hover:text-gray-300 underline-offset-2 hover:underline"
                  aria-label="View source on GitHub (opens in new tab)"
                >
                  GitHub
                </a>
              </div>
            </header>

            <main className="divide-y divide-gray-800 *:py-7 *:first:pt-0">
              {addressBookOpen && <AddressBookPanel onClose={() => setAddressBookOpen(false)} />}
              <section aria-label="Input">
                <CalldataInput
                  collapsed={inputCollapsed}
                  onExpand={() => setInputCollapsed(false)}
                  onDecode={handleDecode}
                  onAbortInFlightDecode={abortInFlightDecode}
                  isLoading={isLoading}
                  initialCalldata={initialCalldata}
                  chainId={chainId}
                  onChainChange={setChainId}
                />
                {isDev && !inputCollapsed && (
                  <div className="mt-4 pt-4 border-t border-gray-800 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPreviewSampleWarnings(v => !v)}
                      className="text-xs px-2.5 py-1 rounded-md border border-amber-900/60 bg-amber-950/40 text-amber-200/90 hover:bg-amber-950/70"
                    >
                      {previewSampleWarnings ? 'Hide sample warnings' : 'Preview sample warnings'}
                    </button>
                    <span className="text-[11px] text-gray-500">Dev only — not in production build</span>
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
                    <svg className="animate-spin motion-reduce:animate-none h-5 w-5" viewBox="0 0 24 24">
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

              {result && !isLoading && (
                <TreeExpansionProvider key={resultKey(result)}>
                  <ResultPanels
                    result={result}
                    meta={resultMeta}
                    decodeTimeMs={decodeTimeMs}
                    autoExpandMaxDepth={autoExpandMaxDepth}
                  />
                </TreeExpansionProvider>
              )}

              {!result && !isLoading && (
                <section className="py-10">
                  <div className="text-center">
                    <div className="text-4xl mb-4 opacity-20">{ '{...}' }</div>
                    <h3 className="text-sm font-medium text-gray-500 mb-2">Paste calldata, a transaction, or a signature request to get started</h3>
                    <p className="text-xs text-gray-500 max-w-md mx-auto">
                      Supports multicall, batch transactions, Safe multiSend, Uniswap Universal Router, and any nested
                      ABI-encoded calls. Paste a tx hash to fetch it from the chain, a signed transaction to see who sent
                      it, typed data to see what a signature allows, or a Safe transaction to check its hashes.
                    </p>
                  </div>
                </section>
              )}
            </main>

            <footer className="mt-12 pt-6 border-t border-gray-900 text-center">
              <p className="text-xs text-gray-500 max-w-2xl mx-auto">
                Decoding runs in your browser; there is no backend. Unknown function selectors are looked up on public
                signature databases, and tx hashes, ENS names, token details, and Safe nonces on public RPCs, so those services see
                them. Turn on Offline mode to send nothing.
              </p>
              <p className="mt-2 text-xs text-gray-500">
                Signatures via{' '}
                <a
                  href="https://4byte.sourcify.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-gray-400"
                  aria-label="Sourcify 4byte function signature database (opens in new tab)"
                >
                  Sourcify 4byte
                </a>
                ,{' '}
                <a
                  href="https://openchain.xyz"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-gray-400"
                  aria-label="OpenChain.xyz function signature lookup (opens in new tab)"
                >
                  openchain.xyz
                </a>
                , &{' '}
                <a
                  href="https://www.4byte.directory"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-gray-400"
                  aria-label="4byte.directory function signature lookup (opens in new tab)"
                >
                  4byte.directory
                </a>
              </p>
            </footer>
          </div>
        </div>
      </AddressBookProvider>
    </ChainProvider>
  );
}

function AddressBookButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { entries } = useAddressBook();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="text-sm text-gray-500 hover:text-gray-300"
      title="Your addresses, saved in this browser. Look-alikes of them get a warning."
    >
      Address book{entries.length > 0 ? ` (${entries.length})` : ''}
    </button>
  );
}
