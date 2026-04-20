import { useState, useCallback, useEffect, useRef, useMemo, type KeyboardEvent } from 'react';
import { validateHexInput, isValidAbiJson } from '../lib/sanitize.ts';
import { isValidTxHash, fetchTxCalldata, type TxFetchContext, type TxInfo } from '../lib/txFetcher.ts';
import { getContractName } from '../lib/abiRegistry.ts';
import { formatEther, getAddress } from 'ethers';
import { CHAIN_LIST, getChain, type ChainConfig } from '../lib/chains.ts';
import { useChainUi } from '../context/ChainContext.tsx';
import { ExplorerAddressLink } from './ExplorerAddressLink.tsx';

type InputMode = 'calldata' | 'txhash';

const TX_INFO_CLIPBOARD_FEEDBACK_MS = 1500;

/** Same-origin session only; cleared when the tab closes. Never replaces URL `#` calldata. */
const CALLDATA_DRAFT_SESSION_KEY = 'rec_dec_calldata_draft_v1';
const MAX_SESSION_CALLDATA_CHARS = 512_000;
const CALLDATA_DRAFT_PERSIST_DEBOUNCE_MS = 400;

function hashFragmentHasValidCalldata(): boolean {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash;
  if (!hash || hash.length < 3) return false;
  try {
    const decoded = decodeURIComponent(hash.slice(1));
    return validateHexInput(decoded).valid;
  } catch {
    return false;
  }
}

function safeSessionGetCalldataDraft(): string | null {
  try {
    return sessionStorage.getItem(CALLDATA_DRAFT_SESSION_KEY);
  } catch {
    return null;
  }
}

function safeSessionSetCalldataDraft(value: string): void {
  try {
    const t = value.trim();
    if (t === '' || t.toLowerCase() === '0x') {
      sessionStorage.removeItem(CALLDATA_DRAFT_SESSION_KEY);
      return;
    }
    if (value.length > MAX_SESSION_CALLDATA_CHARS) return;
    sessionStorage.setItem(CALLDATA_DRAFT_SESSION_KEY, value);
  } catch {
    /* quota / private mode */
  }
}

function safeSessionClearCalldataDraft(): void {
  try {
    sessionStorage.removeItem(CALLDATA_DRAFT_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** RPC `value` is a hex string; missing/invalid values become `0n` so the UI never throws. */
function parseTxValueWei(raw: string | undefined | null): bigint {
  if (raw == null || typeof raw !== 'string') return 0n;
  const t = raw.trim();
  if (t === '') return 0n;
  try {
    return BigInt(t.startsWith('0x') || t.startsWith('0X') ? t : `0x${t}`);
  } catch {
    return 0n;
  }
}

interface CalldataInputProps {
  /**
   * Prefer a stable reference (e.g. `useCallback` in the parent) so `handleDecode` and
   * keyboard shortcuts do not churn every render.
   */
  onDecode: (
    calldata: string,
    abi: string | undefined,
    offlineMode: boolean,
    msgValueWei?: string,
    txTo?: string | null,
    /** Set when calldata came from “Transaction hash” fetch (enables native-transfer summary without decoding `0x`). */
    txFetchContext?: TxFetchContext | null,
  ) => void;
  /** Cancel an in-flight `decodeCalldata` when the user switches calldata / tx-hash mode or chain (parent owns `AbortController`). */
  onAbortInFlightDecode?: () => void;
  isLoading: boolean;
  initialCalldata?: string | null;
  chainId: number;
  onChainChange: (chainId: number) => void;
}

function OptionalToContextBar({ addressInput, chain }: { addressInput: string; chain: ChainConfig }) {
  const { offlineMode } = useChainUi();
  const trimmed = addressInput.trim();
  if (!trimmed) return null;
  try {
    getAddress(trimmed);
  } catch {
    return null;
  }
  const label = getContractName(trimmed, chain.id);
  return (
    <div className="rounded-lg border border-gray-700/50 bg-gray-800/30 px-3 py-2 text-xs text-gray-400">
      <span className="text-gray-500">Call target: </span>
      <ExplorerAddressLink
        key={trimmed}
        address={trimmed}
        chainId={chain.id}
        registryLabel={label ?? undefined}
        offlineMode={offlineMode}
      />
    </div>
  );
}

function TxInfoBar({ txInfo, chain }: { txInfo: TxInfo; chain: ChainConfig }) {
  const { offlineMode } = useChainUi();
  const [calldataCopyFeedback, setCalldataCopyFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  const calldataCopyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (calldataCopyTimerRef.current != null) {
        clearTimeout(calldataCopyTimerRef.current);
      }
    };
  }, []);

  const handleCopyCalldata = useCallback(() => {
    const hex = txInfo.calldata.trim();
    if (hex === '') {
      if (calldataCopyTimerRef.current != null) clearTimeout(calldataCopyTimerRef.current);
      setCalldataCopyFeedback('failed');
      calldataCopyTimerRef.current = window.setTimeout(() => {
        calldataCopyTimerRef.current = null;
        setCalldataCopyFeedback('idle');
      }, TX_INFO_CLIPBOARD_FEEDBACK_MS);
      return;
    }
    navigator.clipboard
      .writeText(hex)
      .then(() => {
        if (calldataCopyTimerRef.current != null) clearTimeout(calldataCopyTimerRef.current);
        setCalldataCopyFeedback('copied');
        calldataCopyTimerRef.current = window.setTimeout(() => {
          calldataCopyTimerRef.current = null;
          setCalldataCopyFeedback('idle');
        }, TX_INFO_CLIPBOARD_FEEDBACK_MS);
      })
      .catch((err: unknown) => {
        console.error('Clipboard failed (tx calldata):', err);
        if (calldataCopyTimerRef.current != null) clearTimeout(calldataCopyTimerRef.current);
        setCalldataCopyFeedback('failed');
        calldataCopyTimerRef.current = window.setTimeout(() => {
          calldataCopyTimerRef.current = null;
          setCalldataCopyFeedback('idle');
        }, TX_INFO_CLIPBOARD_FEEDBACK_MS);
      });
  }, [txInfo.calldata]);

  const calldataNorm = txInfo.calldata.trim().toLowerCase();
  const calldataPreview =
    calldataNorm === '0x' || calldataNorm === ''
      ? '— (none; native transfer)'
      : txInfo.calldata.length > 36
        ? `${txInfo.calldata.slice(0, 18)}…${txInfo.calldata.slice(-10)}`
        : txInfo.calldata;

  const weiValue = parseTxValueWei(txInfo.value);
  const ethExact = formatEther(weiValue);

  return (
    <div className="rounded-lg border border-gray-700/50 bg-gray-800/30 px-3 py-2 text-xs text-gray-400 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-gray-500">Tx:</span>
        <a
          href={`${chain.explorerUrl}/tx/${txInfo.hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
        >
          {txInfo.hash.slice(0, 10)}...{txInfo.hash.slice(-8)}
        </a>
        {txInfo.isPending && (
          <span className="px-1.5 py-0.5 rounded bg-yellow-900/60 text-yellow-300 border border-yellow-700/50 text-[10px]">
            Pending
          </span>
        )}
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <span>
          <span className="text-gray-500">From: </span>
          <ExplorerAddressLink
            key={`tx-from-${txInfo.from}`}
            address={txInfo.from}
            chainId={chain.id}
            registryLabel={getContractName(txInfo.from, chain.id) ?? undefined}
            offlineMode={offlineMode}
          />
        </span>
        {txInfo.to && (
          <span>
            <span className="text-gray-500">To: </span>
            <ExplorerAddressLink
              key={`tx-to-${txInfo.to}`}
              address={txInfo.to}
              chainId={chain.id}
              registryLabel={getContractName(txInfo.to, chain.id) ?? undefined}
              offlineMode={offlineMode}
            />
          </span>
        )}
        {weiValue > 0n && (
          <span>
            <span className="text-gray-500">Value: </span>
            <span className="text-gray-300 font-mono break-all" title={ethExact}>
              {ethExact} {chain.nativeCurrency}
            </span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap pt-1.5 mt-1 border-t border-gray-700/50">
        <span className="text-gray-500 shrink-0">Calldata</span>
        <span className="font-mono text-gray-500 truncate min-w-0 max-w-[min(100%,280px)]" title={txInfo.calldata}>
          {calldataPreview || '(empty)'}
        </span>
        <button
          type="button"
          onClick={handleCopyCalldata}
          className="shrink-0 min-w-[4rem] text-[10px] uppercase tracking-wide text-gray-500 hover:text-gray-300 border border-gray-700 rounded px-2 py-0.5 transition-colors text-center"
          title={calldataCopyFeedback === 'failed' ? 'Copy failed' : 'Copy full calldata to clipboard'}
        >
          {calldataCopyFeedback === 'copied'
            ? 'Copied'
            : calldataCopyFeedback === 'failed'
              ? 'Failed'
              : 'Copy'}
        </button>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {calldataCopyFeedback === 'copied'
            ? 'Calldata copied to clipboard.'
            : calldataCopyFeedback === 'failed'
              ? 'Calldata copy failed.'
              : ''}
        </span>
      </div>
    </div>
  );
}

export function CalldataInput({
  onDecode,
  onAbortInFlightDecode,
  isLoading,
  initialCalldata,
  chainId,
  onChainChange,
}: CalldataInputProps) {
  const { offlineMode, setOfflineMode, skipEns, setSkipEns } = useChainUi();
  const currentChain = useMemo(() => getChain(chainId), [chainId]);

  const [inputMode, setInputMode] = useState<InputMode>('calldata');
  const [calldata, setCalldata] = useState(initialCalldata ?? '');
  const [txHash, setTxHash] = useState('');
  const [abiJson, setAbiJson] = useState('');
  const [txInfo, setTxInfo] = useState<TxInfo | null>(null);
  const [isFetchingTx, setIsFetchingTx] = useState(false);

  /** Last calldata textarea value for calldata mode (preserved when switching to tx-hash and back). */
  const calldataDraftRef = useRef(initialCalldata ?? '');
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;

  /** After at least one URL-driven calldata sync, `initialCalldata === null` clears the field + session draft. */
  const hasReceivedUrlCalldataRef = useRef(false);
  const didHydrateCalldataFromSessionRef = useRef(false);
  const sessionPersistTimerRef = useRef<number | null>(null);

  const schedulePersistCalldataDraft = useCallback((value: string) => {
    if (sessionPersistTimerRef.current != null) {
      window.clearTimeout(sessionPersistTimerRef.current);
    }
    sessionPersistTimerRef.current = window.setTimeout(() => {
      sessionPersistTimerRef.current = null;
      safeSessionSetCalldataDraft(value);
    }, CALLDATA_DRAFT_PERSIST_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (sessionPersistTimerRef.current != null) {
        window.clearTimeout(sessionPersistTimerRef.current);
      }
    };
  }, []);

  /**
   * Sync from URL/hash when the parent passes hex. First-mount `null` means “no fragment”, not “clear textarea”
   * (session restore may fill the field). After a non-empty URL calldata was applied once, `null` clears.
   */
  useEffect(() => {
    if (initialCalldata != null && initialCalldata !== '') {
      hasReceivedUrlCalldataRef.current = true;
      setCalldata(initialCalldata);
      calldataDraftRef.current = initialCalldata;
      safeSessionSetCalldataDraft(initialCalldata);
      return;
    }
    if (initialCalldata === null) {
      if (!hasReceivedUrlCalldataRef.current) return;
      setCalldata('');
      calldataDraftRef.current = '';
      safeSessionClearCalldataDraft();
    }
  }, [initialCalldata]);

  /**
   * Restore calldata from `sessionStorage` once per mount when the URL has no valid calldata fragment
   * (hash wins; same tab reload keeps the draft).
   */
  useEffect(() => {
    if (didHydrateCalldataFromSessionRef.current) return;
    didHydrateCalldataFromSessionRef.current = true;
    if (hashFragmentHasValidCalldata()) return;
    const raw = safeSessionGetCalldataDraft();
    if (!raw) return;
    const vr = validateHexInput(raw);
    if (!vr.valid) return;
    setCalldata(vr.normalized);
    calldataDraftRef.current = vr.normalized;
  }, []);

  const [showAbi, setShowAbi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Calldata mode only: optional `to` for proxy warnings / registry context */
  const [optionalContractTo, setOptionalContractTo] = useState('');
  /** Set on blur of optional address; reset to `idle` while typing */
  const [optionalToHint, setOptionalToHint] = useState<'idle' | 'valid' | 'invalid'>('idle');

  const txFetchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      txFetchAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    txFetchAbortRef.current?.abort();
    onAbortInFlightDecode?.();
  }, [chainId, inputMode, onAbortInFlightDecode]);

  const handleDecode = useCallback(async () => {
    setError(null);

    if (inputMode === 'txhash') {
      if (!isValidTxHash(txHash)) {
        setError('Invalid transaction hash. Expected 0x followed by 64 hex characters.');
        return;
      }

      txFetchAbortRef.current?.abort();
      const ac = new AbortController();
      txFetchAbortRef.current = ac;

      setIsFetchingTx(true);
      try {
        const info = await fetchTxCalldata(txHash.trim(), chainId, { signal: ac.signal });
        if (ac.signal.aborted) return;

        setTxInfo(info);
        setCalldata(info.calldata);
        calldataDraftRef.current = info.calldata;
        schedulePersistCalldataDraft(info.calldata);

        const abi = showAbi && abiJson.trim() ? abiJson.trim() : undefined;
        if (abi && !isValidAbiJson(abi)) {
          setError('Invalid ABI JSON format. Paste a JSON array of ABI fragment objects.');
          return;
        }

        const ctx: TxFetchContext = {
          hash: info.hash,
          from: info.from,
          to: info.to,
          value: info.value,
          isPending: info.isPending,
        };
        onDecodeRef.current(info.calldata, abi, offlineMode, info.value, info.to, ctx);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Failed to fetch transaction');
      } finally {
        if (txFetchAbortRef.current === ac) {
          txFetchAbortRef.current = null;
        }
        setIsFetchingTx(false);
      }
      return;
    }

    const result = validateHexInput(calldata);
    if (!result.valid) {
      setError(result.error);
      return;
    }

    const abi = showAbi && abiJson.trim() ? abiJson.trim() : undefined;
    if (abi && !isValidAbiJson(abi)) {
      setError('Invalid ABI JSON format. Paste a JSON array of ABI fragment objects.');
      return;
    }

    let txToOptional: string | undefined;
    const toTrim = optionalContractTo.trim();
    if (toTrim !== '') {
      try {
        txToOptional = getAddress(toTrim);
      } catch {
        setError('Invalid contract address in optional To field. Use 0x + 40 hex characters.');
        return;
      }
    }

    setTxInfo(null);
    onDecodeRef.current(result.normalized, abi, offlineMode, undefined, txToOptional, null);
  }, [
    inputMode,
    calldata,
    txHash,
    abiJson,
    showAbi,
    offlineMode,
    optionalContractTo,
    chainId,
    schedulePersistCalldataDraft,
  ]);

  const currentlyLoading = isLoading || isFetchingTx;

  /**
   * Enter runs the same action as Fetch & Decode / Decode (skipped while loading, like the button).
   * Calldata textarea: Shift+Enter inserts a newline; plain Enter decodes.
   * ABI textarea is unchanged (Enter always inserts a newline).
   */
  const handlePrimaryEnter = useCallback(
    (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key !== 'Enter') return;
      const id = (e.target as HTMLElement).id;
      if (id === 'abi-input') return;
      if (id === 'calldata-input' && e.shiftKey) return;
      if (currentlyLoading) return;
      e.preventDefault();
      void handleDecode();
    },
    [handleDecode, currentlyLoading],
  );

  const validateOptionalToOnBlur = useCallback(() => {
    const t = optionalContractTo.trim();
    if (t === '') {
      setOptionalToHint('idle');
      return;
    }
    try {
      getAddress(t);
      setOptionalToHint('valid');
    } catch {
      setOptionalToHint('invalid');
    }
  }, [optionalContractTo]);

  return (
    <div className="space-y-4">
      <div className="flex gap-1 mb-1 items-center flex-wrap">
        <button
          type="button"
          aria-pressed={inputMode === 'calldata'}
          aria-label="Calldata input mode"
          onClick={() => {
            setInputMode('calldata');
            const d = calldataDraftRef.current;
            setCalldata(d);
            schedulePersistCalldataDraft(d);
            setError(null);
          }}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            inputMode === 'calldata'
              ? 'bg-gray-700 text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Calldata
        </button>
        <button
          type="button"
          aria-pressed={inputMode === 'txhash'}
          aria-label="Transaction hash input mode"
          onClick={() => {
            calldataDraftRef.current = calldata;
            setInputMode('txhash');
            setError(null);
          }}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            inputMode === 'txhash'
              ? 'bg-gray-700 text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Transaction Hash
        </button>

        <div className="flex-1" />

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-600">Chain:</span>
          <select
            value={chainId}
            onChange={e => {
              onChainChange(Number(e.target.value));
              setTxInfo(null);
              setError(null);
            }}
            disabled={currentlyLoading}
            title={currentlyLoading ? 'Wait for the current request to finish before changing chain' : undefined}
            aria-busy={currentlyLoading}
            className="rounded-md bg-gray-800 border border-gray-700 px-2 py-1 text-sm text-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {CHAIN_LIST.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      {inputMode === 'calldata' ? (
        <div>
          <label htmlFor="calldata-input" className="block text-sm font-medium text-gray-300 mb-1.5">
            Calldata (hex)
          </label>
          <textarea
            id="calldata-input"
            value={calldata}
            onChange={e => {
              const v = e.target.value;
              setCalldata(v);
              calldataDraftRef.current = v;
              schedulePersistCalldataDraft(v);
              setError(null);
            }}
            onKeyDown={handlePrimaryEnter}
            placeholder="0x5ae401dc00000000000000000000..."
            className="w-full h-32 rounded-lg bg-gray-900 border border-gray-700 px-3 py-2.5 text-sm font-mono text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none resize-y"
            spellCheck={false}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-gray-600">
            <kbd className="px-1 py-0.5 rounded bg-gray-800 border border-gray-700 font-mono text-[10px]">Enter</kbd>
            {' '}to decode ·{' '}
            <kbd className="px-1 py-0.5 rounded bg-gray-800 border border-gray-700 font-mono text-[10px]">Shift</kbd>
            +
            <kbd className="px-1 py-0.5 rounded bg-gray-800 border border-gray-700 font-mono text-[10px]">Enter</kbd>
            {' '}for a new line · Draft saved in this tab until you close it (URL{' '}
            <span className="font-mono text-gray-500">#</span> still wins when present).
          </p>
          <div className="mt-3">
            <label htmlFor="optional-to-input" className="block text-sm font-medium text-gray-300 mb-1.5">
              Contract address <span className="text-gray-600 font-normal">(optional)</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                id="optional-to-input"
                type="text"
                value={optionalContractTo}
                onChange={e => {
                  setOptionalContractTo(e.target.value);
                  setOptionalToHint('idle');
                  setError(null);
                }}
                onBlur={validateOptionalToOnBlur}
                onKeyDown={handlePrimaryEnter}
                placeholder="0x... (call target for proxy warnings & labels)"
                className="min-w-0 flex-1 rounded-lg bg-gray-900 border border-gray-700 px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={optionalToHint === 'invalid'}
              />
              {optionalToHint === 'valid' && (
                <span className="shrink-0 text-green-500" aria-label="Valid Ethereum address">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </span>
              )}
            </div>
            {optionalToHint === 'invalid' && (
              <p className="mt-1 text-xs text-amber-500/90" role="status" aria-live="polite">
                This does not look like a valid checksummed address (blur to re-check).
              </p>
            )}
            <p className="mt-1 text-xs text-gray-600">
              Not required to decode. If set, used like a transaction <span className="font-mono text-gray-500">to</span> for known-contract labels and proxy notices.
            </p>
          </div>
        </div>
      ) : (
        <div>
          <label htmlFor="txhash-input" className="block text-sm font-medium text-gray-300 mb-1.5">
            Transaction Hash
          </label>
          <input
            id="txhash-input"
            type="text"
            value={txHash}
            onChange={e => { setTxHash(e.target.value); setError(null); setTxInfo(null); }}
            onKeyDown={handlePrimaryEnter}
            placeholder={`0x1234...abcd (paste any ${currentChain.name} transaction hash)`}
            className="w-full rounded-lg bg-gray-900 border border-gray-700 px-3 py-2.5 text-sm font-mono text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-gray-600">
            The calldata will be fetched from a public {currentChain.name} RPC and decoded automatically. Press{' '}
            <kbd className="px-1 py-0.5 rounded bg-gray-800 border border-gray-700 font-mono text-[10px]">Enter</kbd>
            {' '}to fetch and decode.
          </p>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}

      {inputMode === 'calldata' && (
        <OptionalToContextBar addressInput={optionalContractTo} chain={currentChain} />
      )}

      {txInfo && (
        <TxInfoBar txInfo={txInfo} chain={currentChain} />
      )}

      <div className="flex items-center gap-4 flex-wrap">
        <button
          type="button"
          onClick={handleDecode}
          disabled={currentlyLoading || (inputMode === 'calldata' ? !calldata.trim() : !txHash.trim())}
          className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {currentlyLoading ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {isFetchingTx ? 'Fetching tx...' : 'Decoding...'}
            </span>
          ) : (
            inputMode === 'txhash' ? 'Fetch & Decode' : 'Decode'
          )}
        </button>

        <button
          type="button"
          onClick={() => setShowAbi(!showAbi)}
          className="px-3 py-2 rounded-lg border border-gray-700 text-gray-400 text-sm hover:border-gray-500 hover:text-gray-300 transition-colors"
        >
          {showAbi ? 'Hide' : 'Provide'} ABI
        </button>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={offlineMode}
            onChange={e => setOfflineMode(e.target.checked)}
            className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 h-4 w-4"
          />
          <span className="text-sm text-gray-400">Offline mode</span>
        </label>

        {!offlineMode && (
          <label className="flex items-center gap-2 cursor-pointer" title="Skip Ethereum reverse-ENS (mainnet RPC). Faster on large trees.">
            <input
              type="checkbox"
              checked={skipEns}
              onChange={e => setSkipEns(e.target.checked)}
              className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 h-4 w-4"
            />
            <span className="text-sm text-gray-400">Skip ENS</span>
          </label>
        )}

        <span className="text-xs text-gray-600 hidden sm:inline">
          {offlineMode
            ? 'Using bundled ABIs only'
            : skipEns
              ? 'ENS lookups disabled'
              : 'Querying signature databases'}
        </span>
      </div>

      {showAbi && (
        <div>
          <label htmlFor="abi-input" className="block text-sm font-medium text-gray-300 mb-1.5">
            Contract ABI (JSON)
          </label>
          <textarea
            id="abi-input"
            value={abiJson}
            onChange={e => setAbiJson(e.target.value)}
            placeholder='[{"type":"function","name":"swap",...}]'
            className="w-full min-h-40 h-40 rounded-lg bg-gray-900 border border-gray-700 px-3 py-2.5 text-sm font-mono text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none resize-y"
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-gray-500">
            Optional. Paste the contract ABI for guaranteed-correct decoding with named parameters.
          </p>
        </div>
      )}
    </div>
  );
}
