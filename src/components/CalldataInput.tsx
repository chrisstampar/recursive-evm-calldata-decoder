import { useState, useCallback, useEffect, useRef, useMemo, type KeyboardEvent } from 'react';
import { validateHexInput, isValidAbiJson } from '../lib/sanitize.ts';
import { isValidTxHash, fetchTxCalldata, type TxFetchContext, type TxInfo } from '../lib/txFetcher.ts';
import { getContractName } from '../lib/abiRegistry.ts';
import { formatEther, getAddress } from 'ethers';
import { CHAIN_LIST, getChain, type ChainConfig } from '../lib/chains.ts';
import { useChainUi } from '../context/ChainContext.ts';
import { ExplorerAddressLink } from './ExplorerAddressLink.tsx';
import { SafeTxForm, type SafeFormState } from './SafeTxForm.tsx';
import { SignedTxInfo } from './SignedTxInfo.tsx';
import type { DecodeRequest } from '../lib/decodeRequest.ts';
import { decodeChainFor, looksLikeSerializedTx, parseSerializedTransaction, serializedTxWarnings, type ParsedSignedTx } from '../lib/rawTx.ts';
import { parseTypedData, typedDataToDecodeInput } from '../lib/typedData.ts';
import { EMPTY_SAFE_TX, SAFE_VERSION_RANGES, computeSafeTxHashes, safeTxAsExecCalldata } from '../lib/safeHash.ts';

type InputMode = 'calldata' | 'txhash' | 'rawtx' | 'typed' | 'safe';

const MODES: { id: InputMode; label: string; aria: string }[] = [
  { id: 'calldata', label: 'Calldata', aria: 'Calldata input mode' },
  { id: 'txhash', label: 'Tx hash', aria: 'Transaction hash input mode' },
  { id: 'rawtx', label: 'Signed tx', aria: 'Signed or unsigned serialized transaction input mode' },
  { id: 'typed', label: 'Typed data', aria: 'EIP-712 typed data signature request input mode' },
  { id: 'safe', label: 'Safe tx', aria: 'Safe transaction hash check input mode' },
];

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

/**
 * Initial textarea value: URL calldata wins; otherwise restore the same-tab `sessionStorage` draft when the URL has
 * no valid calldata fragment (so a reload keeps the draft).
 */
function initialCalldataValue(initialCalldata: string | null | undefined): string {
  if (initialCalldata) return initialCalldata;
  if (hashFragmentHasValidCalldata()) return '';
  const raw = safeSessionGetCalldataDraft();
  if (!raw) return '';
  const vr = validateHexInput(raw);
  return vr.valid ? vr.normalized : '';
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
  onDecode: (request: DecodeRequest, offlineMode: boolean) => void;
  /** Cancel an in-flight `decodeCalldata` when the user switches calldata / tx-hash mode or chain (parent owns `AbortController`). */
  onAbortInFlightDecode?: () => void;
  isLoading: boolean;
  initialCalldata?: string | null;
  chainId: number;
  onChainChange: (chainId: number) => void;
  /** After a decode, show the input as one line (what was decoded + Edit) so the results start higher up. */
  collapsed?: boolean;
  onExpand?: () => void;
}

/** Bytes in a `0x…` hex string, grouped for display. */
function hexByteCount(hex: string): string {
  const body = hex.trim().replace(/^0x/i, '');
  return Math.floor(body.length / 2).toLocaleString('en-US');
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
    <div className="text-xs text-gray-400">
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
    <div className="text-xs text-gray-400 space-y-1">
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
        {txInfo.integrity === 'verified' ? (
          <span
            className="px-1.5 py-0.5 rounded bg-green-950/60 text-green-300 border border-green-800/50 text-[10px]"
            title={`The RPC response re-hashes to this transaction hash, so its calldata and sender are authentic${txInfo.rpcHost ? ` (answered by ${txInfo.rpcHost})` : ''}.`}
          >
            Verified against hash
          </span>
        ) : (
          <span
            className="px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/50 text-[10px]"
            title={`This transaction type could not be re-hashed locally, so the calldata is as reported by ${txInfo.rpcHost ?? 'the RPC'}. Cross-check on a block explorer.`}
          >
            Not verified
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
      <div className="flex items-center gap-2 flex-wrap pt-1">
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
  collapsed = false,
  onExpand,
}: CalldataInputProps) {
  const { offlineMode, setOfflineMode, skipEns, setSkipEns } = useChainUi();
  const currentChain = useMemo(() => getChain(chainId), [chainId]);

  const [inputMode, setInputMode] = useState<InputMode>('calldata');
  const [calldata, setCalldata] = useState(() => initialCalldataValue(initialCalldata));
  const [txHash, setTxHash] = useState('');
  const [abiJson, setAbiJson] = useState('');
  const [txInfo, setTxInfo] = useState<TxInfo | null>(null);
  const [isFetchingTx, setIsFetchingTx] = useState(false);
  const [rawTxText, setRawTxText] = useState('');
  /** Last pasted transaction that parsed (shown above the result). */
  const [rawTx, setRawTx] = useState<ParsedSignedTx | null>(null);
  const [typedText, setTypedText] = useState('');
  /** One line describing the last decoded typed data, for the collapsed input. */
  const [typedSummary, setTypedSummary] = useState<string | null>(null);
  const [safeForm, setSafeForm] = useState<SafeFormState>({ safeAddress: '', version: '1.3+', tx: EMPTY_SAFE_TX });

  /** Last calldata textarea value for calldata mode (preserved when switching to tx-hash and back). */
  const calldataDraftRef = useRef(calldata);
  const onDecodeRef = useRef(onDecode);
  useEffect(() => {
    onDecodeRef.current = onDecode;
  }, [onDecode]);

  /** After at least one URL-driven calldata sync, `initialCalldata === null` clears the field + session draft. */
  const hasReceivedUrlCalldataRef = useRef(false);
  const [syncedInitialCalldata, setSyncedInitialCalldata] = useState(initialCalldata);
  const [hasReceivedUrlCalldata, setHasReceivedUrlCalldata] = useState(Boolean(initialCalldata));

  // Adjust the textarea when the URL-driven prop changes (render-time, per React's "adjusting state on prop change").
  if (initialCalldata !== syncedInitialCalldata) {
    setSyncedInitialCalldata(initialCalldata);
    if (initialCalldata != null && initialCalldata !== '') {
      setHasReceivedUrlCalldata(true);
      setCalldata(initialCalldata);
      // A #calldata link decodes as calldata, whichever tab was open.
      setInputMode('calldata');
    } else if (initialCalldata === null && hasReceivedUrlCalldata) {
      setCalldata('');
    }
  }
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
      calldataDraftRef.current = initialCalldata;
      safeSessionSetCalldataDraft(initialCalldata);
      return;
    }
    if (initialCalldata === null) {
      if (!hasReceivedUrlCalldataRef.current) return;
      calldataDraftRef.current = '';
      safeSessionClearCalldataDraft();
    }
  }, [initialCalldata]);

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

  // Tab switches cancel in their click handler, so a #calldata link that selects the Calldata tab doesn't cancel its
  // own decode.
  useEffect(() => {
    txFetchAbortRef.current?.abort();
    onAbortInFlightDecode?.();
  }, [chainId, onAbortInFlightDecode]);

  const handleDecode = useCallback(async () => {
    setError(null);
    const abiOrError = (): string | undefined | false => {
      const abi = showAbi && abiJson.trim() ? abiJson.trim() : undefined;
      if (abi && !isValidAbiJson(abi)) {
        setError('Invalid ABI JSON format. Paste a JSON array of ABI fragment objects.');
        return false;
      }
      return abi;
    };

    if (inputMode === 'rawtx') {
      let tx: ParsedSignedTx;
      try {
        tx = parseSerializedTransaction(rawTxText);
      } catch (e) {
        setRawTx(null);
        setError(e instanceof Error ? e.message : 'Could not read that transaction.');
        return;
      }
      setRawTx(tx);
      setTxInfo(null);
      const abi = abiOrError();
      if (abi === false) return;
      const decodeChain = decodeChainFor(tx, chainId);
      const warnings = serializedTxWarnings(tx, decodeChain);
      if (!tx.to) {
        setError('This transaction deploys a contract; its data is contract code, not a function call, so there is nothing to decode.');
        return;
      }
      onDecodeRef.current(
        {
          calldata: tx.data,
          abi,
          msgValueWei: tx.value,
          txTo: tx.to,
          txFetchContext: { hash: tx.hash ?? '', from: tx.from ?? '', to: tx.to, value: tx.value, isPending: false },
          chainId: decodeChain,
          extraWarnings: warnings,
          from: tx.from,
        },
        offlineMode,
      );
      return;
    }

    if (inputMode === 'typed') {
      try {
        const td = parseTypedData(typedText);
        const input = typedDataToDecodeInput(td);
        const decodeChain = td.chainId !== undefined && CHAIN_LIST.some(c => c.id === td.chainId) ? td.chainId : chainId;
        const domainName = typeof td.domain.name === 'string' ? ` · ${td.domain.name}` : '';
        setTypedSummary(`${td.primaryType}${domainName}`);
        setTxInfo(null);
        onDecodeRef.current(
          {
            calldata: input.calldata,
            abi: input.abi,
            msgValueWei: input.safeTx?.value,
            txTo: input.callTarget ?? null,
            chainId: decodeChain,
            typedData: td,
            signing: {
              kind: 'typed-data',
              primaryType: td.primaryType,
              domain: td.domain,
              hashes: td.hashes,
              ...(input.safeTx ? { safeNonce: input.safeTx.nonce } : {}),
            },
            kind: 'signature',
          },
          offlineMode,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read that typed data.');
      }
      return;
    }

    if (inputMode === 'safe') {
      const abi = abiOrError();
      if (abi === false) return;
      try {
        const safeAddress = getAddress(safeForm.safeAddress.trim());
        const hashes = computeSafeTxHashes(chainId, safeAddress, safeForm.version, safeForm.tx);
        setTxInfo(null);
        onDecodeRef.current(
          {
            calldata: safeTxAsExecCalldata(safeForm.tx),
            abi,
            txTo: safeAddress,
            chainId,
            signing: {
              kind: 'safe',
              safeAddress,
              chainId,
              versionLabel: SAFE_VERSION_RANGES.find(v => v.id === safeForm.version)?.label ?? safeForm.version,
              nonce: BigInt(safeForm.tx.nonce.trim()).toString(),
              hashes,
            },
          },
          offlineMode,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Check the Safe transaction fields.';
        setError(/invalid address|bad address checksum/i.test(msg) ? 'Safe address is not a valid address.' : msg);
      }
      return;
    }

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
        onDecodeRef.current(
          { calldata: info.calldata, abi, msgValueWei: info.value, txTo: info.to, txFetchContext: ctx, from: info.from },
          offlineMode,
        );
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
    onDecodeRef.current({ calldata: result.normalized, abi, txTo: txToOptional }, offlineMode);
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
    rawTxText,
    typedText,
    safeForm,
  ]);

  /** Calldata box holding something else: say which tab reads it. */
  const calldataHint = useMemo((): { text: string; mode: InputMode } | null => {
    const t = calldata.trim();
    if (t.startsWith('{') || t.startsWith('[')) return { text: 'This looks like typed data (JSON).', mode: 'typed' };
    if (t.length > 10 && validateHexInput(t).valid && looksLikeSerializedTx(t)) {
      return { text: 'This also reads as a serialized transaction.', mode: 'rawtx' };
    }
    return null;
  }, [calldata]);

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
      if (id === 'abi-input' || id === 'typed-input') return;
      if ((id === 'calldata-input' || id === 'rawtx-input') && e.shiftKey) return;
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

  if (collapsed && !currentlyLoading) {
    let kind: string;
    let shown: string;
    if (inputMode === 'rawtx' && rawTx) {
      kind = `${rawTx.from ? 'Signed' : 'Unsigned'} transaction`;
      shown = rawTx.hash ?? rawTxText.trim();
    } else if (inputMode === 'typed' && typedSummary) {
      kind = 'Signature request';
      shown = typedSummary;
    } else if (inputMode === 'safe') {
      kind = 'Safe transaction';
      shown = `${safeForm.safeAddress.trim()} · nonce ${safeForm.tx.nonce.trim()}`;
    } else if (txInfo) {
      kind = 'Transaction';
      shown = txInfo.hash;
    } else {
      kind = 'Calldata';
      shown = calldata.trim();
    }
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-gray-500">
              {kind} on {currentChain.name}
              {kind === 'Calldata' && shown && ` · ${hexByteCount(shown)} bytes`}
              {offlineMode && ' · offline'}
            </p>
            <p className="font-mono text-sm text-gray-300 truncate" title={shown}>
              {shown || '—'}
            </p>
          </div>
          <button
            type="button"
            onClick={onExpand}
            className="shrink-0 px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 text-sm hover:border-gray-500 hover:text-gray-50 transition-colors"
          >
            Edit input
          </button>
        </div>
        {inputMode === 'rawtx' && rawTx && <SignedTxInfo tx={rawTx} chainId={chainId} />}
        {inputMode === 'txhash' && txInfo && <TxInfoBar txInfo={txInfo} chain={currentChain} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 mb-1 items-center flex-wrap">
        {MODES.map(m => (
          <button
            key={m.id}
            type="button"
            aria-pressed={inputMode === m.id}
            aria-label={m.aria}
            onClick={() => {
              if (m.id !== inputMode) {
                txFetchAbortRef.current?.abort();
                onAbortInFlightDecode?.();
              }
              if (inputMode === 'calldata') calldataDraftRef.current = calldata;
              if (m.id === 'calldata') {
                const d = calldataDraftRef.current;
                setCalldata(d);
                schedulePersistCalldataDraft(d);
              }
              setInputMode(m.id);
              setError(null);
            }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              inputMode === m.id ? 'bg-gray-700 text-gray-50' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {m.label}
          </button>
        ))}

        <div className="flex-1" />

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">Chain:</span>
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
            className="w-full h-32 rounded-lg bg-gray-900 border border-gray-700 px-3 py-2.5 text-sm font-mono text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none resize-y"
            spellCheck={false}
            autoComplete="off"
          />
          {/* Keyboard hint only where there is a keyboard; the draft note is in the title. */}
          <p
            className="mt-1 text-xs text-gray-500 hidden sm:block"
            title="Your draft is kept in this tab until you close it (a #calldata link still wins)."
          >
            <kbd className="px-1 py-0.5 rounded bg-gray-800 border border-gray-700 font-mono text-[10px]">Enter</kbd>
            {' '}to decode ·{' '}
            <kbd className="px-1 py-0.5 rounded bg-gray-800 border border-gray-700 font-mono text-[10px]">Shift</kbd>
            +
            <kbd className="px-1 py-0.5 rounded bg-gray-800 border border-gray-700 font-mono text-[10px]">Enter</kbd>
            {' '}for a new line
          </p>
          {calldataHint && (
            <p className="mt-1 text-xs text-amber-300" role="status">
              {calldataHint.text}{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-amber-200"
                onClick={() => {
                  onAbortInFlightDecode?.();
                  calldataDraftRef.current = calldata;
                  if (calldataHint.mode === 'typed') setTypedText(calldata);
                  else setRawTxText(calldata.trim());
                  setInputMode(calldataHint.mode);
                  setError(null);
                }}
              >
                Read it as {calldataHint.mode === 'typed' ? 'typed data' : 'a transaction'}
              </button>
            </p>
          )}
          <div className="mt-3">
            <label htmlFor="optional-to-input" className="block text-sm font-medium text-gray-300 mb-1.5">
              Contract address <span className="text-gray-500 font-normal">(optional)</span>
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
                placeholder="0x… call target"
                className="min-w-0 flex-1 rounded-lg bg-gray-900 border border-gray-700 px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
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
            <p className="mt-1 text-xs text-gray-500">
              The contract this calldata is sent to. Optional; it adds contract labels and proxy notices.
            </p>
          </div>
        </div>
      ) : inputMode === 'txhash' ? (
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
            className="w-full rounded-lg bg-gray-900 border border-gray-700 px-3 py-2.5 text-sm font-mono text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-gray-500">
            The calldata will be fetched from a public {currentChain.name} RPC and decoded automatically. Press{' '}
            <kbd className="px-1 py-0.5 rounded bg-gray-800 border border-gray-700 font-mono text-[10px]">Enter</kbd>
            {' '}to fetch and decode.
          </p>
        </div>
      ) : inputMode === 'rawtx' ? (
        <div>
          <label htmlFor="rawtx-input" className="block text-sm font-medium text-gray-300 mb-1.5">
            Serialized transaction (hex)
          </label>
          <textarea
            id="rawtx-input"
            value={rawTxText}
            onChange={e => {
              setRawTxText(e.target.value);
              setRawTx(null);
              setError(null);
            }}
            onKeyDown={handlePrimaryEnter}
            placeholder="0x02f8…"
            className="w-full h-32 rounded-lg bg-gray-900 border border-gray-700 px-3 py-2.5 text-sm font-mono text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none resize-y"
            spellCheck={false}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-gray-500">
            A signed or unsigned transaction, as <code className="font-mono">cast mktx</code>, a wallet export, or a
            signing request gives it. Nothing is broadcast: it is only read, and its sender recovered from the signature.
          </p>
        </div>
      ) : inputMode === 'typed' ? (
        <div>
          <label htmlFor="typed-input" className="block text-sm font-medium text-gray-300 mb-1.5">
            Typed data (EIP-712 JSON)
          </label>
          <textarea
            id="typed-input"
            value={typedText}
            onChange={e => {
              setTypedText(e.target.value);
              setError(null);
            }}
            placeholder='{"types": {…}, "primaryType": "Permit", "domain": {…}, "message": {…}}'
            className="w-full h-48 rounded-lg bg-gray-900 border border-gray-700 px-3 py-2.5 text-sm font-mono text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none resize-y"
            spellCheck={false}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-gray-500">
            What a wallet asks you to sign with <code className="font-mono">eth_signTypedData_v4</code>: the JSON itself
            or the whole request. Permits, Permit2, Seaport orders, and Safe transactions get a plain-language reading.
          </p>
        </div>
      ) : (
        <SafeTxForm
          value={safeForm}
          onChange={next => {
            setSafeForm(next);
            setError(null);
          }}
          chainId={chainId}
          nativeCurrency={currentChain.nativeCurrency}
          offlineMode={offlineMode}
          onEnter={handlePrimaryEnter}
        />
      )}

      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}

      {inputMode === 'calldata' && (
        <OptionalToContextBar addressInput={optionalContractTo} chain={currentChain} />
      )}

      {inputMode === 'txhash' && txInfo && (
        <TxInfoBar txInfo={txInfo} chain={currentChain} />
      )}

      {inputMode === 'rawtx' && rawTx && <SignedTxInfo tx={rawTx} chainId={chainId} />}

      <div className="flex items-center gap-4 flex-wrap">
        <button
          type="button"
          onClick={handleDecode}
          disabled={
            currentlyLoading ||
            (inputMode === 'calldata'
              ? !calldata.trim()
              : inputMode === 'txhash'
                ? !txHash.trim()
                : inputMode === 'rawtx'
                  ? !rawTxText.trim()
                  : inputMode === 'typed'
                    ? !typedText.trim()
                    : !safeForm.safeAddress.trim() || !safeForm.tx.to.trim() || !safeForm.tx.nonce.trim())
          }
          className="px-5 py-2 rounded-lg bg-blue-600 text-gray-50 text-sm font-medium hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {currentlyLoading ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin motion-reduce:animate-none h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {isFetchingTx ? 'Fetching tx...' : 'Decoding...'}
            </span>
          ) : (
            inputMode === 'txhash' ? 'Fetch & Decode' : inputMode === 'safe' ? 'Check hashes & decode' : 'Decode'
          )}
        </button>

        {inputMode !== 'typed' && (
          <button
            type="button"
            onClick={() => setShowAbi(!showAbi)}
            className="px-3 py-2 rounded-lg border border-gray-700 text-gray-400 text-sm hover:border-gray-500 hover:text-gray-300 transition-colors"
          >
            {showAbi ? 'Hide' : 'Provide'} ABI
          </button>
        )}

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

        {offlineMode && (
          <span className="text-xs text-gray-500">Bundled ABIs only, no network requests</span>
        )}
      </div>

      {showAbi && inputMode !== 'typed' && (
        <div>
          <label htmlFor="abi-input" className="block text-sm font-medium text-gray-300 mb-1.5">
            Contract ABI (JSON)
          </label>
          <textarea
            id="abi-input"
            value={abiJson}
            onChange={e => setAbiJson(e.target.value)}
            placeholder='[{"type":"function","name":"swap",...}]'
            className="w-full min-h-40 h-40 rounded-lg bg-gray-900 border border-gray-700 px-3 py-2.5 text-sm font-mono text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none resize-y"
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
