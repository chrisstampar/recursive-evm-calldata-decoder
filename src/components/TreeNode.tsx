import { useState, useCallback, useRef, useEffect, type Dispatch, type SetStateAction } from 'react';
import type {
  DecodedValue,
  DecodedParam,
  DecodedCall,
  DecodeConfidence,
  SignatureSource,
} from '../types/index.ts';
import { useChainId, useChainUi } from '../context/ChainContext.tsx';
import { ExplorerAddressLink } from './ExplorerAddressLink.tsx';
import { useTreeExpansionOptional } from '../context/TreeExpansionContext.tsx';
import { getExplorerUrl } from '../lib/chains.ts';
import { getContractName } from '../lib/abiRegistry.ts';
import { summarizeCurveSwapParamsCollapsed } from '../lib/curveRouterSwapParams.ts';
import {
  computeInitialExpanded,
  CURVE_SWAP_PARAMS_HOP_EXPANSION_WEIGHT,
  isCurveSwapParamsOuterMatrix,
} from '../lib/treeExpandPolicy.ts';

/**
 * Decode tree UI — dependency flow (read bottom-up in source):
 *
 * `ValueDisplay` → `CopyMenu` / `CopyButton` / badges; nested `bytes` → `DecodedCallNode`; tuples → `ParamRow`.
 * `ParamRow` → `ValueDisplay` for each parameter value (passes `declaringParam` for {@link computeInitialExpanded}).
 * `DecodedCallNode` (export) → `ParamRow` for each call argument.
 *
 * Expansion defaults live in `treeExpandPolicy.ts`. Bulk **Expand all** / **Collapse all** uses
 * `TreeExpansionProvider` (see `DecodeTree.tsx`); `useExpandableNodeState` subscribes via `useTreeExpansionOptional`.
 *
 * `ValueDisplay` and `DecodedCallNode` reference each other (nested calldata). All of these are `function`
 * declarations, so they hoist and that cycle stays valid without circular ES modules or `const` forward refs.
 *
 * **Bundle:** `curveRouterSwapParams` / `treeExpandPolicy` / `curveExpandRules` are static imports (same chunk). Bundlers
 * may drop unused exports inside those files, but any symbol this module references stays in the bundle regardless
 * of whether a given decode hits the Curve path.
 */

const COPY_PREVIEW_MAX_LEN = 20;
const COPY_PREVIEW_ELLIPSIS = '...';
const COPY_PREVIEW_ELLIPSIS_LEN = COPY_PREVIEW_ELLIPSIS.length;
/** Visible characters before ellipsis in copy-menu previews (`maxLen - "..."`). */
const COPY_PREVIEW_BODY_LEN = COPY_PREVIEW_MAX_LEN - COPY_PREVIEW_ELLIPSIS_LEN;

const TYPE_BADGE_MAX_LEN = 40;
const TYPE_BADGE_BODY_LEN = TYPE_BADGE_MAX_LEN - COPY_PREVIEW_ELLIPSIS_LEN;

const BYTES_INLINE_MAX_BYTES = 32;
const BYTES_INLINE_HEAD_CHARS = 18;
const BYTES_INLINE_TAIL_CHARS = 8;

const COPY_BUTTON_FEEDBACK_MS = 1500;
const COPY_MENU_FEEDBACK_MS = 1000;

/** Array/tuple nodes with `depth < this` start expanded (tune for compact vs verbose tree views). */
export const DEFAULT_AUTO_EXPAND_DEPTH = 3;

function truncateForCopyPreview(s: string): string {
  return s.length > COPY_PREVIEW_MAX_LEN
    ? `${s.slice(0, COPY_PREVIEW_BODY_LEN)}${COPY_PREVIEW_ELLIPSIS}`
    : s;
}

/** Solidity type string prefixes used only for badge color (`type.startsWith`). */
const TYPE_BADGE_PREFIX_STYLES = {
  address: 'bg-purple-900/60 text-purple-300 border-purple-700/50',
  bool: 'bg-yellow-900/60 text-yellow-300 border-yellow-700/50',
  string: 'bg-green-900/60 text-green-300 border-green-700/50',
  bytes: 'bg-orange-900/60 text-orange-300 border-orange-700/50',
} as const;

// --- Local types (domain unions live in `../types/index.ts`) ---

type SolidityTypeBadgePrefix = keyof typeof TYPE_BADGE_PREFIX_STYLES;

interface CopyButtonProps {
  text: string;
  /** `title` / tooltip for the control (e.g. address vs bytes). */
  copyTitle?: string;
}

/** Raw calldata / ABI string vs human-oriented `display`, optional `interpretation` (e.g. timestamp, token amount). */
interface CopyMenuProps {
  raw: string;
  display?: string;
  interpretation?: string;
}

interface TypeBadgeProps {
  type: string;
}

interface ConfidenceBadgeProps {
  confidence: DecodeConfidence;
}

interface SourceBadgeProps {
  source: SignatureSource;
}

/** Optional: function / tuple field that declares this value (see `treeExpandPolicy`). */
export type DeclaringParamRef = { name: string; type: string };

interface ValueDisplayProps {
  value: DecodedValue;
  depth: number;
  autoExpandMaxDepth?: number;
  declaringParam?: DeclaringParamRef;
  /**
   * Expansion hint for verbose numeric rows (e.g. Curve `_swap_params` hop lines): set to
   * `CURVE_SWAP_PARAMS_HOP_EXPANSION_WEIGHT` only when this `ValueDisplay` is a direct child of the outer matrix.
   */
  expansionWeight?: number;
}

interface ParamRowProps {
  param: DecodedParam;
  depth: number;
  autoExpandMaxDepth?: number;
}

/** Root or nested decoded call frame (`bytes` inner calldata). */
export interface DecodedCallNodeProps {
  call: DecodedCall;
  /**
   * Max nesting depth (0-based) for which array/tuple rows start expanded, and whether this call
   * frame’s body starts expanded (`call.depth < autoExpandMaxDepth`).
   */
  autoExpandMaxDepth?: number;
}

const TYPE_BADGE_PREFIX_ORDER: readonly SolidityTypeBadgePrefix[] = [
  'address',
  'bool',
  'string',
  'bytes',
];

const TYPE_BADGE_INT_LIKE_CLASS =
  'bg-cyan-900/60 text-cyan-300 border-cyan-700/50' as const;
const TYPE_BADGE_FALLBACK_CLASS =
  'bg-blue-900/60 text-blue-300 border-blue-700/50' as const;

const CONFIDENCE_BADGE_MAP: Record<DecodeConfidence, { label: string; className: string }> = {
  exact: { label: 'Exact', className: 'bg-green-900/60 text-green-300 border-green-700/50' },
  high: { label: 'High', className: 'bg-blue-900/60 text-blue-300 border-blue-700/50' },
  ambiguous: { label: 'Ambiguous', className: 'bg-yellow-900/60 text-yellow-300 border-yellow-700/50' },
  failed: { label: 'Failed', className: 'bg-red-900/60 text-red-300 border-red-700/50' },
};

const SOURCE_BADGE_CLASS_MAP: Record<SignatureSource, string> = {
  bundled: 'text-green-500',
  'user-abi': 'text-green-400',
  sourcify: 'text-cyan-400',
  openchain: 'text-blue-400',
  '4byte': 'text-gray-400',
};

/**
 * Whole-byte count for a hex payload (`0x` / `0X` optional).
 * Odd-length payloads use `Math.floor(nibbles / 2)` so callers never show fractional bytes.
 */
function hexPayloadByteLength(hex: string): number {
  const payload = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  return Math.floor(payload.length / 2);
}

const VALUE_FINGERPRINT_HEX_CHARS = 24;

/**
 * Per-`DecodedValue` fingerprint cache. Assumes decoded nodes are not mutated after build (decoder output).
 * Avoids rescanning large tuple field lists on every parent re-render when object identity is stable.
 */
const decodedValueFingerprintCache = new WeakMap<DecodedValue, string>();

/** Compact fingerprint so list keys stay stable when the decoded tree is replaced (e.g. re-decode). */
function decodedValueFingerprint(v: DecodedValue): string {
  const cached = decodedValueFingerprintCache.get(v);
  if (cached !== undefined) return cached;
  let fp: string;
  switch (v.kind) {
    case 'primitive':
      fp = `p:${v.raw}:${v.embeddedEvmAddress?.checksummed ?? ''}:${v.embeddedEvmAddress?.ensName ?? ''}`;
      break;
    case 'address':
      fp = `a:${v.checksummed}:${v.ensName ?? ''}`;
      break;
    case 'bytes':
      fp = `b:${v.hex.length}:${v.wordAlignedAddresses?.length ?? 0}:${v.hex.slice(0, VALUE_FINGERPRINT_HEX_CHARS)}`;
      break;
    case 'array':
      fp = `r:${v.elementType}:${v.elements.length}`;
      break;
    case 'tuple':
      fp = `t:${v.fields.map(f => `${f.name}:${f.type}`).join(';')}`;
      break;
  }
  decodedValueFingerprintCache.set(v, fp);
  return fp;
}

function arrayElementRowKey(elementType: string, elem: DecodedValue, index: number, depth: number): string {
  return `arr:d${depth}:[${index}]:${elementType}:${decodedValueFingerprint(elem)}`;
}

function tupleFieldRowKey(field: DecodedParam, index: number, depth: number): string {
  return `tpl:d${depth}:[${index}]:${field.name}:${field.type}:${decodedValueFingerprint(field.value)}`;
}

function callParamRowKey(param: DecodedParam, index: number, depth: number, selector: string): string {
  return `call:${selector}:d${depth}:[${index}]:${param.name}:${param.type}:${decodedValueFingerprint(param.value)}`;
}

function alternativeSignatureRowKey(selector: string, source: SignatureSource, index: number): string {
  return `alt:${selector}:${index}:${source}`;
}

function CopyButton({ text, copyTitle = 'Copy raw value' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const feedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current != null) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      if (feedbackTimerRef.current != null) {
        clearTimeout(feedbackTimerRef.current);
      }
      setCopyFailed(false);
      setCopied(true);
      feedbackTimerRef.current = window.setTimeout(() => {
        feedbackTimerRef.current = null;
        setCopied(false);
      }, COPY_BUTTON_FEEDBACK_MS);
    } catch (err) {
      console.error('Clipboard failed:', err);
      if (feedbackTimerRef.current != null) {
        clearTimeout(feedbackTimerRef.current);
      }
      setCopied(false);
      setCopyFailed(true);
      feedbackTimerRef.current = window.setTimeout(() => {
        feedbackTimerRef.current = null;
        setCopyFailed(false);
      }, COPY_BUTTON_FEEDBACK_MS);
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="ml-1.5 text-gray-600 hover:text-gray-400 transition-colors inline-flex shrink-0"
      title={copyFailed ? 'Copy failed' : copyTitle}
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : copyFailed ? (
        <svg className="w-3.5 h-3.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

function CopyMenu({ raw, display, interpretation }: CopyMenuProps) {
  const [open, setOpen] = useState(false);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const [clipboardError, setClipboardError] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current != null) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeIfOutside = (e: MouseEvent | TouchEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', closeIfOutside);
    document.addEventListener('touchstart', closeIfOutside);
    return () => {
      document.removeEventListener('mousedown', closeIfOutside);
      document.removeEventListener('touchstart', closeIfOutside);
    };
  }, [open]);

  const doCopy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (feedbackTimerRef.current != null) {
        clearTimeout(feedbackTimerRef.current);
      }
      setClipboardError(false);
      setCopiedLabel(label);
      feedbackTimerRef.current = window.setTimeout(() => {
        feedbackTimerRef.current = null;
        setCopiedLabel(null);
        setOpen(false);
      }, COPY_MENU_FEEDBACK_MS);
    } catch (err) {
      console.error('Clipboard failed:', err);
      if (feedbackTimerRef.current != null) {
        clearTimeout(feedbackTimerRef.current);
      }
      setCopiedLabel(null);
      setClipboardError(true);
      feedbackTimerRef.current = window.setTimeout(() => {
        feedbackTimerRef.current = null;
        setClipboardError(false);
      }, COPY_MENU_FEEDBACK_MS);
    }
  }, []);

  /** Formatted / UI display string differs from the raw slot value. */
  const showFormattedRow = Boolean(display && display !== raw);
  /**
   * Extra decoded line (timestamp, wei hint, etc.). Omit when it duplicates the formatted row so the menu
   * does not offer two identical copy targets.
   */
  const showDecodedRow = Boolean(
    interpretation &&
      interpretation !== raw &&
      (!showFormattedRow || interpretation !== display),
  );

  if (!showFormattedRow && !showDecodedRow) {
    return <CopyButton text={raw} />;
  }

  return (
    <span ref={rootRef} className="relative inline-flex shrink-0 ml-1.5">
      <button
        type="button"
        onClick={() => {
          setOpen(o => {
            if (!o) setClipboardError(false);
            return !o;
          });
        }}
        className="text-gray-600 hover:text-gray-400 transition-colors inline-flex"
        title="Copy value — choose raw, formatted, or decoded text"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-5 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[180px]">
            {clipboardError && (
              <p className="px-3 py-1 text-[10px] text-red-400 border-b border-gray-700" role="alert">
                Clipboard unavailable
              </p>
            )}
            <button
              type="button"
              onClick={() => void doCopy(raw, 'raw')}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors flex items-center gap-2"
            >
              <span className="text-gray-400 shrink-0">Raw:</span>
              <span className="font-mono text-gray-200 truncate">{truncateForCopyPreview(raw)}</span>
              {copiedLabel === 'raw' && <span className="text-green-400 text-[10px] ml-auto shrink-0">Copied</span>}
            </button>
            {showFormattedRow && display != null ? (
              <button
                type="button"
                onClick={() => void doCopy(display, 'formatted')}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors flex items-center gap-2"
              >
                <span className="text-gray-400 shrink-0">Formatted:</span>
                <span className="font-mono text-gray-200 truncate">{truncateForCopyPreview(display)}</span>
                {copiedLabel === 'formatted' && (
                  <span className="text-green-400 text-[10px] ml-auto shrink-0">Copied</span>
                )}
              </button>
            ) : null}
            {showDecodedRow && interpretation != null ? (
              <button
                type="button"
                onClick={() => void doCopy(interpretation, 'decoded')}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 transition-colors flex items-center gap-2"
              >
                <span className="text-gray-400 shrink-0">Decoded:</span>
                <span className="text-gray-200 truncate">{truncateForCopyPreview(interpretation)}</span>
                {copiedLabel === 'decoded' && (
                  <span className="text-green-400 text-[10px] ml-auto shrink-0">Copied</span>
                )}
              </button>
            ) : null}
        </div>
      )}
    </span>
  );
}

function TypeBadge({ type }: TypeBadgeProps) {
  let colorClass: string = TYPE_BADGE_FALLBACK_CLASS;
  if (type.startsWith('uint') || type.startsWith('int')) {
    colorClass = TYPE_BADGE_INT_LIKE_CLASS;
  } else {
    for (const key of TYPE_BADGE_PREFIX_ORDER) {
      if (type.startsWith(key)) {
        colorClass = TYPE_BADGE_PREFIX_STYLES[key];
        break;
      }
    }
  }

  const displayType =
    type.length > TYPE_BADGE_MAX_LEN
      ? `${type.slice(0, TYPE_BADGE_BODY_LEN)}${COPY_PREVIEW_ELLIPSIS}`
      : type;

  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono border shrink-0 max-w-[200px] truncate ${colorClass}`}
      title={type}
    >
      {displayType}
    </span>
  );
}

function ConfidenceBadge({ confidence }: ConfidenceBadgeProps) {
  const { label, className } = CONFIDENCE_BADGE_MAP[confidence];

  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0 ${className}`}>
      {label}
    </span>
  );
}

function SourceBadge({ source }: SourceBadgeProps) {
  return (
    <span className={`text-[10px] shrink-0 ${SOURCE_BADGE_CLASS_MAP[source]}`}>
      via {source}
    </span>
  );
}

// --- Tree: bottom-up (`function` hoisting allows `ValueDisplay` ↔ `DecodedCallNode`) ---

function useExpandableNodeState(getInitial: () => boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const treeExp = useTreeExpansionOptional();
  const [expanded, setExpanded] = useState(getInitial);

  useEffect(() => {
    if (!treeExp?.lastBulk) return;
    const intent = treeExp.lastBulk;
    const id = requestAnimationFrame(() => {
      if (intent === 'expand-all') setExpanded(true);
      if (intent === 'collapse-all') setExpanded(false);
    });
    return () => cancelAnimationFrame(id);
  }, [treeExp?.generation, treeExp?.lastBulk]);

  return [expanded, setExpanded];
}

function ValueDisplay({
  value,
  depth,
  autoExpandMaxDepth = DEFAULT_AUTO_EXPAND_DEPTH,
  declaringParam,
  expansionWeight,
}: ValueDisplayProps) {
  const chainId = useChainId();
  const { offlineMode, skipEns } = useChainUi();

  const [expanded, setExpanded] = useExpandableNodeState(() => {
    if (value.kind === 'array') {
      return computeInitialExpanded({
        kind: 'array',
        depth,
        autoExpandMaxDepth,
        childCount: value.elements.length,
        declaringParam,
        elementType: value.elementType,
        expansionWeight,
      });
    }
    if (value.kind === 'tuple') {
      return computeInitialExpanded({
        kind: 'tuple',
        depth,
        autoExpandMaxDepth,
        childCount: value.fields.length,
      });
    }
    return false;
  });

  const arrayChildInsideHop =
    value.kind === 'array' && isCurveSwapParamsOuterMatrix(declaringParam, value.elementType);

  if (value.kind === 'primitive') {
    const emb = value.embeddedEvmAddress;
    if (emb) {
      const href = `${getExplorerUrl(chainId)}/address/${emb.checksummed}`;
      const contractLabel = getContractName(emb.checksummed, chainId);
      const showEns = !offlineMode && !skipEns && emb.ensName;
      const primary = showEns ? emb.ensName! : emb.checksummed;
      const linkMono = !showEns;
      const shortHex =
        emb.checksummed.length >= 14
          ? `${emb.checksummed.slice(0, 6)}…${emb.checksummed.slice(-4)}`
          : emb.checksummed;
      return (
        <div className="min-w-0 space-y-1">
          <div className="min-w-0">
            <span className="font-mono text-sm text-gray-200 break-all">{value.display}</span>
            {value.interpretation && (
              <span className="ml-2 text-xs text-gray-500 italic break-all">{value.interpretation}</span>
            )}
            <CopyMenu raw={value.raw} display={value.display} interpretation={value.interpretation} />
          </div>
          <div className="min-w-0 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-sm text-purple-300 hover:text-purple-200 hover:underline break-all ${linkMono ? 'font-mono' : ''}`}
              title={
                showEns
                  ? `${emb.checksummed}${contractLabel ? ` · ${contractLabel}` : ''}`
                  : contractLabel
                    ? `${emb.checksummed} · ${contractLabel}`
                    : emb.checksummed
              }
            >
              {primary}
            </a>
            {showEns && (
              <span className="font-mono text-xs text-gray-500 shrink-0" title={emb.checksummed}>
                {shortHex}
              </span>
            )}
            {contractLabel && (
              <span className="text-xs text-purple-400/70 font-medium">({contractLabel})</span>
            )}
            <CopyButton text={emb.checksummed} copyTitle="Copy checksummed address" />
          </div>
        </div>
      );
    }
    return (
      <div className="min-w-0">
        <span className="font-mono text-sm text-gray-200 break-all">{value.display}</span>
        {value.interpretation && (
          <span className="ml-2 text-xs text-gray-500 italic break-all">{value.interpretation}</span>
        )}
        <CopyMenu raw={value.raw} display={value.display} interpretation={value.interpretation} />
      </div>
    );
  }

  if (value.kind === 'address') {
    const href = `${getExplorerUrl(chainId)}/address/${value.checksummed}`;
    const showEns = !offlineMode && !skipEns && value.ensName;
    const primary = showEns ? value.ensName! : value.checksummed;
    const linkMono = !showEns;
    const shortHex =
      value.checksummed.length >= 14
        ? `${value.checksummed.slice(0, 6)}…${value.checksummed.slice(-4)}`
        : value.checksummed;
    return (
      <div className="min-w-0">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={`text-sm text-purple-300 hover:text-purple-200 hover:underline break-all ${linkMono ? 'font-mono' : ''}`}
          title={
            showEns
              ? `${value.checksummed}${value.label ? ` · ${value.label}` : ''}`
              : value.label
                ? `${value.checksummed} · ${value.label}`
                : value.checksummed
          }
        >
          {primary}
        </a>
        {showEns && (
          <span className="ml-2 font-mono text-xs text-gray-500 shrink-0" title={value.checksummed}>
            {shortHex}
          </span>
        )}
        {value.label && (
          <span className="ml-2 text-xs text-purple-400/70 font-medium">({value.label})</span>
        )}
        <CopyButton text={value.checksummed} copyTitle="Copy checksummed address" />
      </div>
    );
  }

  if (value.kind === 'bytes') {
    const wordHits = value.wordAlignedAddresses;
    const hitsBlock =
      wordHits && wordHits.length > 0 ? (
        <div className="mt-1.5 space-y-1 border-l border-violet-900/50 pl-2 max-w-4xl">
          <div className="text-[10px] text-gray-500 font-medium tracking-wide">
            Padded addresses (32-byte ABI words in this payload)
          </div>
          <ul className="list-none space-y-1 m-0 p-0">
            {wordHits.map((hit, i) => (
              <li
                key={`w${hit.wordIndex}-${hit.checksummed}-${i}`}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
              >
                <span className="font-mono text-gray-600 shrink-0" title="Word index (32-byte slots from start of payload)">
                  [{hit.wordIndex}]
                </span>
                <ExplorerAddressLink
                  address={hit.checksummed}
                  chainId={chainId}
                  registryLabel={hit.label}
                  offlineMode={offlineMode}
                  className="min-w-0"
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null;

    if (value.decoded) {
      return (
        <div className="min-w-0 mt-1 space-y-2">
          {hitsBlock}
          <DecodedCallNode call={value.decoded} autoExpandMaxDepth={autoExpandMaxDepth} />
        </div>
      );
    }
    const byteLen = hexPayloadByteLength(value.hex);
    const display =
      byteLen > BYTES_INLINE_MAX_BYTES
        ? `${value.hex.slice(0, BYTES_INLINE_HEAD_CHARS)}${COPY_PREVIEW_ELLIPSIS}${value.hex.slice(-BYTES_INLINE_TAIL_CHARS)}`
        : value.hex;
    return (
      <div className="min-w-0">
        <span className="font-mono text-sm text-orange-300 break-all">{display}</span>
        <span className="ml-2 text-xs text-gray-600">{byteLen} bytes</span>
        <CopyButton text={value.hex} />
        {hitsBlock}
      </div>
    );
  }

  if (value.kind === 'array') {
    const count = value.elements.length;
    const isSwapParamsOuter = isCurveSwapParamsOuterMatrix(declaringParam, value.elementType);
    const listLabel = isSwapParamsOuter
      ? `${count} hop${count === 1 ? '' : 's'}`
      : `${count} element${count === 1 ? '' : 's'}`;
    const collapsedSummary = !expanded && isSwapParamsOuter ? summarizeCurveSwapParamsCollapsed(value) : null;

    return (
      <div className="min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-gray-500 hover:text-gray-300 font-mono text-left w-fit"
          >
            {expanded ? '▼' : '▶'} [{listLabel}]
          </button>
          {collapsedSummary && (
            <p className="text-xs text-gray-500 italic leading-snug max-w-2xl pl-4 border-l border-gray-800 ml-0.5">
              {collapsedSummary}
            </p>
          )}
        </div>
        {expanded && (
          <div className="mt-1 space-y-1 border-l-2 border-gray-800 pl-3">
            {value.elements.map((elem, i) => (
              <div key={arrayElementRowKey(value.elementType, elem, i, depth)}>
                <span className="text-xs text-gray-600 font-mono">[{i}]</span>
                <div className="ml-2">
                  <ValueDisplay
                    value={elem}
                    depth={depth + 1}
                    autoExpandMaxDepth={autoExpandMaxDepth}
                    expansionWeight={
                      arrayChildInsideHop ? CURVE_SWAP_PARAMS_HOP_EXPANSION_WEIGHT : undefined
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (value.kind === 'tuple') {
    return (
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-gray-500 hover:text-gray-300 font-mono"
        >
          {expanded ? '▼' : '▶'} {'{'}tuple{'}'}
        </button>
        {expanded && (
          <div className="mt-1 space-y-2 border-l-2 border-gray-800 pl-3">
            {value.fields.map((field, i) => (
              <ParamRow
                key={tupleFieldRowKey(field, i, depth)}
                param={field}
                depth={depth + 1}
                autoExpandMaxDepth={autoExpandMaxDepth}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return null;
}

function ParamRow({
  param,
  depth,
  autoExpandMaxDepth = DEFAULT_AUTO_EXPAND_DEPTH,
}: ParamRowProps) {
  const [showRaw, setShowRaw] = useState(false);

  const isComplex =
    param.value.kind === 'tuple' ||
    param.value.kind === 'array' ||
    (param.value.kind === 'bytes' && param.value.decoded != null);

  const declaringParam = { name: param.name, type: param.type };

  const valueDisplayProps = {
    value: param.value,
    depth,
    autoExpandMaxDepth,
    declaringParam,
  };

  return (
    <div className="group min-w-0">
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap min-w-0">
          <span className="text-sm font-medium text-gray-400 shrink-0">{param.name}</span>
          <TypeBadge type={param.type} />
          {param.rawHex && (
            <button
              type="button"
              onClick={() => setShowRaw(!showRaw)}
              className="text-[10px] text-gray-600 hover:text-gray-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Show or hide the 32-byte ABI-encoded hex word for this argument"
            >
              {showRaw ? 'hide hex' : 'hex'}
            </button>
          )}
        </div>
        {param.fieldHint ? (
          <p className="text-[11px] text-gray-500 leading-snug max-w-3xl border-l border-gray-700/70 pl-2 ml-0.5">
            {param.fieldHint}
          </p>
        ) : null}
      </div>
      {isComplex ? (
        <div className="mt-0.5 min-w-0">
          <ValueDisplay {...valueDisplayProps} />
        </div>
      ) : (
        <div className="mt-0.5 ml-2 min-w-0">
          <ValueDisplay {...valueDisplayProps} />
        </div>
      )}
      {showRaw && param.rawHex && (
        <div className="mt-0.5 ml-2 text-xs font-mono text-gray-600 break-all" title="32-byte ABI word (hex)">
          {param.rawHex}
        </div>
      )}
    </div>
  );
}

export function DecodedCallNode({
  call,
  autoExpandMaxDepth = DEFAULT_AUTO_EXPAND_DEPTH,
}: DecodedCallNodeProps) {
  const [expanded, setExpanded] = useExpandableNodeState(() =>
    computeInitialExpanded({
      kind: 'call',
      depth: call.depth,
      autoExpandMaxDepth,
      childCount: call.params.length,
    }),
  );
  const [showAlts, setShowAlts] = useState(false);

  return (
    <div className={`rounded-lg border min-w-0 ${call.depth === 0 ? 'border-gray-700 bg-gray-900/50' : 'border-gray-800 bg-gray-900/30'}`}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-800/50 transition-colors flex-wrap min-w-0"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-xs text-gray-600 font-mono shrink-0">
          {expanded ? '▼' : '▶'}
        </span>
        <span className="font-mono text-sm font-semibold text-blue-300 break-all">
          {call.signature.name}
        </span>
        <span className="text-xs text-gray-600 font-mono shrink-0 hidden sm:inline">
          {call.selector}
        </span>
        <ConfidenceBadge confidence={call.confidence} />
        <SourceBadge source={call.signature.source} />
        {call.alternatives.length > 0 && (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              setShowAlts(!showAlts);
            }}
            className="text-[10px] text-yellow-600 hover:text-yellow-400 shrink-0"
          >
            +{call.alternatives.length} alt{call.alternatives.length > 1 ? 's' : ''}
          </button>
        )}
      </div>

      {showAlts && call.alternatives.length > 0 && (
        <div className="px-3 py-1.5 border-t border-gray-800 bg-gray-900/80">
          <p className="text-[10px] text-gray-500 mb-1">Alternative signatures:</p>
          {call.alternatives.map((alt, i) => (
            <div key={alternativeSignatureRowKey(alt.selector, alt.source, i)} className="text-xs font-mono text-gray-500 ml-2 break-all">
              {alt.textSignature} <SourceBadge source={alt.source} />
              {alt.deprecated && (
                <span className="ml-1 text-[10px] uppercase tracking-wide text-orange-500/90">deprecated</span>
              )}
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div className="px-3 py-2 border-t border-gray-800/50 space-y-2 min-w-0">
          <div className="text-xs font-mono text-gray-600 break-all">
            {call.signature.textSignature}
          </div>
          {call.params.map((param, i) => (
            <ParamRow
              key={callParamRowKey(param, i, call.depth, call.selector)}
              param={param}
              depth={call.depth}
              autoExpandMaxDepth={autoExpandMaxDepth}
            />
          ))}
        </div>
      )}
    </div>
  );
}
