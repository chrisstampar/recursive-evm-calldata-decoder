import { AbiCoder, getBytes, hexlify, type Interface } from 'ethers';
import type {
  DecodedCalldataOutcome,
  DecodedCall,
  DecodedParam,
  DecodedValue,
  DecodeOptions,
  FunctionSignature,
  DecodeConfidence,
  HexSelector,
  TxWarning,
  WordAlignedAddressHit,
} from '../types/index.ts';
import { extractSelector, MAX_INPUT_BYTES, sanitizeDecodedString } from './sanitize.ts';
import {
  getCachedUserAbiInterface,
  initEthers,
  lookupSelector,
  lookupSelectorFromUserAbi,
  MAX_USER_ABI_JSON_CHARS,
} from './signatureLookup.ts';
import {
  DEFAULT_MAX_MULTISEND_OPERATIONS,
  DEFAULT_MAX_PATTERN_ARRAY_EXPAND,
  DEFAULT_MULTICALL_PATTERN_NEST_LIMIT,
  ENSO_EXECUTE_SHORTCUT_SELECTOR,
  getKnownPattern,
  isKnownMulticallSelector,
  type CalldataIndex,
  type MulticallPattern,
} from './knownPatterns.ts';
import {
  formatAddress,
  formatUint256,
  formatTokenAmount,
  formatBytes32,
  extractLeftPaddedAddressFromBytes32,
  interpretBytes32AsLeftPaddedAddress,
  formatBool,
  coerceAbiDecodedBool,
  scanHexForWordAlignedPaddedAddresses,
  tokenAmountWholePartExceedsPlausibleDisplay,
} from './valueFormatter.ts';
import {
  fetchErc4626UnderlyingAsset,
  fetchOnChainTokenDecimals,
  getTokenInfo,
  type TokenInfo,
} from './abiRegistry.ts';
import { annotateCurveRouterSwapParams } from './curveRouterSwapParams.ts';
import { formatDestinationChainInterpretation } from './chains.ts';
import { reverseResolveEns } from './ensLookup.ts';

const coder = AbiCoder.defaultAbiCoder();

const DEPRECATED_SCORE_PENALTY = 400;

/** Reject absurd type strings before any `RegExp` work on attacker-controlled ABI text. */
const MAX_SOLIDITY_TYPE_STRING_CHARS = 4096;

/** Fixed `address` type: 20 bytes on the wire. */
const ABI_ADDRESS_BYTE_LENGTH = 20;
/** `uint256` / length words in packed layouts: 32-byte big-endian. */
const ABI_WORD_BYTE_LENGTH = 32;
const HEX_NIBBLES_PER_BYTE = 2;
/** EVM function selector size on the wire (bytes). */
const ABI_SELECTOR_BYTE_LENGTH = 4;
/**
 * Length of calldata hex string prefix `0x` + selector nibbles (see {@link ABI_SELECTOR_BYTE_LENGTH}).
 * Params body for ABI decode is `calldataHex.slice(SELECTOR_HEX_PREFIX_LENGTH)`.
 */
const SELECTOR_HEX_PREFIX_LENGTH = 2 + ABI_SELECTOR_BYTE_LENGTH * HEX_NIBBLES_PER_BYTE;
/** Gnosis Safe `multiSend` packed row: leading operation tag byte (CALL / DELEGATECALL / CREATE). */
const GNOSIS_MULTISEND_OPERATION_BYTE_LENGTH = 1;
/** Hex character count for one ABI address (no `0x`). */
const HEX_CHARS_PER_ADDRESS = ABI_ADDRESS_BYTE_LENGTH * HEX_NIBBLES_PER_BYTE;
/** Length of `0x` + 40 hex nibbles (typical checksummed address string). */
const ADDRESS_HEX_STRING_LENGTH = 2 + HEX_CHARS_PER_ADDRESS;

const ZERO_ADDRESS_LOWER = '0x0000000000000000000000000000000000000000';

/** Curve Finance router `exchange(address[11],…)` (bundled selector). */
const CURVE_ROUTER_EXCHANGE_SELECTOR = '0x5c9c18e2' as const;

/** LayerZero V2 OFT `send(SendParam,(uint256,uint256),address)` — amounts are in the OFT at transaction `to`. */
const LAYERZERO_OFT_SEND_SELECTOR = '0xc7c7f5b3' as const;
/** ERC-4626 `withdraw(uint256 assets,address receiver,address owner)` — `assets` uses decimals from `asset()` on callee. */
const ERC4626_WITHDRAW_SELECTOR = '0xb460af94' as const;
/** Across SpokePool V2 `deposit` — `inputToken` / `outputToken` are left-padded addresses in `bytes32`. */
const ACROSS_SPOKE_DEPOSIT_SELECTOR = '0xad5425c6' as const;

/** 1inch Aggregation Router `swap`: `desc` tuple holds src/dst tokens; early tuple enrichment skips uints when ≥2 tokens. */
const ONEINCH_AGG_SWAP_SELECTOR_V5 = '0x12aa3caf' as const;
const ONEINCH_AGG_SWAP_SELECTOR_V6 = '0x90411a32' as const;

/** Uniswap V3 SwapRouter `exactInputSingle` / `exactOutputSingle` — same param tuple layout. */
const UNISWAP_V3_EXACT_INPUT_SINGLE_SELECTOR = '0x414bf389' as const;
const UNISWAP_V3_EXACT_OUTPUT_SINGLE_SELECTOR = '0xdb3e2198' as const;
const UNISWAP_V3_EXACT_SINGLE_PARAMS_TUPLE = '(address,address,uint24,address,uint256,uint256,uint256,uint160)';

/**
 * 4byte / OpenChain list `swapCompact()` (no ABI parameters), but many contracts append a **non-standard**
 * packed payload. Standard `AbiCoder.decode` rejects the tail; we surface it as dynamic `bytes` instead.
 */
const SWAP_COMPACT_SELECTOR = '0x83bd37f9' as const;

/**
 * Packed `swapCompact` tails often hide standard contract calldata after a short prologue (not at byte 0).
 * We try `decodeCalldata` from many start offsets within this window, with a hard cap on attempts.
 */
const MAX_SWAP_COMPACT_INNER_SCAN_BYTES = 1536;
const MAX_SWAP_COMPACT_INNER_DECODE_ATTEMPTS = 200;

/** Max `calldata` string length: `0x` + two hex nibbles per payload byte (see {@link MAX_INPUT_BYTES}). */
const MAX_CALLDATA_HEX_STRING_LENGTH = 2 + MAX_INPUT_BYTES * HEX_NIBBLES_PER_BYTE;

/** Max characters kept in `rawHex` / similar error previews before appending `...`. */
const ERROR_HEX_PREVIEW_CHARS = 100;
/** When input length exceeds this, {@link truncateHexForErrorPreview} truncates (100 chars + `...`). */
const ERROR_HEX_PREVIEW_THRESHOLD = ERROR_HEX_PREVIEW_CHARS + 3;

/** Truncates long hex/calldata strings for error UI (`rawHex`) — same cap as {@link ERROR_HEX_PREVIEW_CHARS}. */
export function truncateHexForErrorPreview(s: string): string {
  return s.length > ERROR_HEX_PREVIEW_THRESHOLD ? `${s.slice(0, ERROR_HEX_PREVIEW_CHARS)}...` : s;
}

function pushDecodeWarning(options: DecodeOptions, warning: TxWarning): void {
  options.decodeWarningSink?.push(warning);
}

/**
 * Cooperative abort: call after `await`s and in long async loops. Pure CPU between checks cannot be preempted.
 */
function throwIfDecodeAborted(options: DecodeOptions): void {
  if (options.signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

/** In tight loops, call every N iterations (plus iteration 0) to reduce `signal.aborted` polling overhead. */
const ABORT_CHECK_INTERVAL = 32;

function throwIfDecodeAbortedEvery(options: DecodeOptions, loopIndex: number, every = ABORT_CHECK_INTERVAL): void {
  if (loopIndex % every === 0) {
    throwIfDecodeAborted(options);
  }
}

/**
 * Normalize to `0x` + hex body. Rejects non-hexadecimal characters so failures are not deferred to `getBytes`.
 * Preserves casing after `0x` when input already used a lowercase `0x` prefix (matches prior behavior).
 */
function normalizeHex(h: string): string {
  const trimmed = h.trim();
  const hasPrefix = trimmed.startsWith('0x') || trimmed.startsWith('0X');
  const body = hasPrefix ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]*$/.test(body)) {
    throw new RangeError('Invalid hexadecimal string');
  }
  if (hasPrefix) {
    return trimmed.startsWith('0X') ? `0x${body}` : trimmed;
  }
  return body.length === 0 ? '0x' : `0x${body}`;
}

/**
 * Parse trailing fixed ABI dimension `T[k]` (single `k` only, last `[]` pair).
 * Avoids catastrophic backtracking from `/^(.+)\[(\d+)\]$/` on long strings.
 */
export function parseFixedAbiArraySuffix(type: string): { baseType: string; length: number } | null {
  if (type.length > MAX_SOLIDITY_TYPE_STRING_CHARS) return null;
  const open = type.lastIndexOf('[');
  if (open <= 0 || !type.endsWith(']')) return null;
  const dim = type.slice(open + 1, -1);
  if (dim.length === 0 || dim.length > 6 || !/^\d+$/.test(dim)) return null;
  const n = Number(dim);
  if (!Number.isFinite(n) || n < 1 || n > 65_535) return null;
  const baseType = type.slice(0, open);
  if (baseType.length === 0) return null;
  return { baseType, length: n };
}

function effectiveArrayDirectCap(hints: CalldataIndex[]): number {
  const ad = hints.find(h => h.kind === 'array-direct');
  return ad?.maxArrayLength ?? DEFAULT_MAX_PATTERN_ARRAY_EXPAND;
}

function effectiveTupleArrayCap(hints: CalldataIndex[]): number {
  const tupleFields = hints.filter((h): h is Extract<CalldataIndex, { kind: 'tuple-field' }> => h.kind === 'tuple-field');
  const explicit = tupleFields.map(h => h.maxArrayLength).filter((n): n is number => n !== undefined);
  return explicit.length > 0 ? Math.min(...explicit) : DEFAULT_MAX_PATTERN_ARRAY_EXPAND;
}

/** Source tier for tie-breaking (lower = preferred). */
function sourcePrecedence(source: FunctionSignature['source']): number {
  switch (source) {
    case 'user-abi':
      return 0;
    case 'bundled':
      return 1;
    case 'sourcify':
      return 2;
    case 'openchain':
      return 3;
    case '4byte':
      return 4;
    default:
      return 5;
  }
}

/** Order ambiguous alternatives for UI: non-deprecated, popularity, source, text. */
function rankSignatureAlternatives(sigs: FunctionSignature[]): FunctionSignature[] {
  return [...sigs].sort((a, b) => {
    if (!!a.deprecated !== !!b.deprecated) return a.deprecated ? 1 : -1;
    const pa = a.popularity ?? 0;
    const pb = b.popularity ?? 0;
    if (pa !== pb) return pb - pa;
    const sa = sourcePrecedence(a.source);
    const sb = sourcePrecedence(b.source);
    if (sa !== sb) return sa - sb;
    return a.textSignature.localeCompare(b.textSignature);
  });
}

export async function decodeCalldata(
  calldata: string,
  options: DecodeOptions,
  /** ABI decode stack depth (every nested `decodeCalldata` frame, including generic `bytes` probes). */
  depth = 0,
  /**
   * Count of **pattern-driven** nested expansions (multicall `bytes` / `bytes[]`, Gnosis `multiSend` segments, etc.)
   * above this frame. Incremented only when entering nested calldata via a known {@link MulticallPattern}, not for
   * every `depth` step. Capped by {@link DecodeOptions.multicallNestLimit}, `maxDepth`, and optional
   * `maxRecursionDepth` on the pattern. Stops pathological A→B→A selector chains from blowing the stack or heap.
   */
  patternNestingDepth = 0,
): Promise<DecodedCalldataOutcome> {
  const opts: DecodeOptions =
    depth === 0 && options.tokenLookupSessionCache === undefined
      ? { ...options, tokenLookupSessionCache: new Map<string, Promise<TokenInfo | undefined>>() }
      : options;

  throwIfDecodeAborted(opts);

  if (depth === 0) {
    await initEthers();
    throwIfDecodeAborted(opts);
  }

  if (depth > opts.maxDepth) {
    return {
      status: 'error',
      error: `Max recursion depth (${opts.maxDepth}) reached`,
      rawHex: truncateHexForErrorPreview(calldata),
    };
  }

  let calldataBytes: string;
  try {
    calldataBytes = normalizeHex(calldata);
  } catch {
    return {
      status: 'error',
      error: 'Invalid hexadecimal in calldata',
      rawHex: truncateHexForErrorPreview(calldata),
    };
  }

  // Size gate before heavy work. On rejection, still parse the selector from **full** `calldataBytes` — never from
  // the truncated preview — so truncation only affects `rawHex` in the error payload (avoids huge objects / accidental parse fail).
  if (calldataBytes.length > MAX_CALLDATA_HEX_STRING_LENGTH) {
    const sel = extractSelector(calldataBytes);
    const preview = truncateHexForErrorPreview(calldataBytes);
    return {
      status: 'error',
      error: sel
        ? `Calldata exceeds maximum size (${MAX_INPUT_BYTES} bytes of hex payload) for selector ${sel}`
        : `Calldata exceeds maximum size (${MAX_INPUT_BYTES} bytes of hex payload)`,
      rawHex: preview,
      selector: sel ?? undefined,
    };
  }

  const selector = extractSelector(calldataBytes);
  if (selector === null) {
    return {
      status: 'error',
      error: `Invalid function selector (expected 0x followed by 8 hexadecimal characters, with calldata at least ${ABI_SELECTOR_BYTE_LENGTH} bytes)`,
      rawHex: truncateHexForErrorPreview(calldataBytes),
    };
  }
  const paramsHex = `0x${calldataBytes.slice(SELECTOR_HEX_PREFIX_LENGTH)}`;

  let candidates: FunctionSignature[] = [];

  // User ABI matches are authoritative when present; remote lookup runs only when the paste has no matching selector.
  // (User ABI resolution is synchronous; prefetching APIs in parallel would waste bandwidth whenever user wins.)
  if (opts.userAbi) {
    const userMatches = lookupSelectorFromUserAbi(selector, opts.userAbi, {
      onNonCanonicalSelector: opts.onUserAbiNonCanonicalSelector,
    });
    if (userMatches.length > 0) {
      candidates = userMatches;
    }
  }

  if (candidates.length === 0) {
    candidates = await lookupSelector(selector, {
      offlineMode: opts.offlineMode,
      onError: opts.onSignatureLookupError,
    });
    throwIfDecodeAborted(opts);
  }

  // OpenChain / 4byte list `swapCompact()` with **zero** parameters. Ethers `AbiCoder.decode([], tail)` succeeds and
  // **drops** trailing bytes, so users only see `swapCompact()` with no payload. Prefer the synthetic
  // `swapCompact(bytes compactPayload)` path whenever a non-trivial tail exists and no ABI lists real args.
  const swapCompactPackedTail =
    selector.toLowerCase() === SWAP_COMPACT_SELECTOR && calldataBytes.length > SELECTOR_HEX_PREFIX_LENGTH;
  if (swapCompactPackedTail && !candidates.some(c => c.params.length > 0)) {
    throwIfDecodeAborted(opts);
    const swapCompactOpaque = await tryDecodeSwapCompactOpaque(
      calldataBytes,
      selector,
      opts,
      depth,
      patternNestingDepth,
    );
    if (swapCompactOpaque) return swapCompactOpaque;
  }

  if (candidates.length === 0) {
    const swapCompactFallback = await tryDecodeSwapCompactOpaque(
      calldataBytes,
      selector,
      opts,
      depth,
      patternNestingDepth,
    );
    if (swapCompactFallback) return swapCompactFallback;

    return {
      status: 'error',
      error: `No matching function signature found for selector ${selector}`,
      rawHex: truncateHexForErrorPreview(calldataBytes),
      selector,
    };
  }

  const scored = await scoreAndDecode(
    candidates,
    paramsHex,
    selector,
    calldataBytes,
    opts,
    depth,
    patternNestingDepth,
  );
  throwIfDecodeAborted(opts);

  if (!scored) {
    const swapCompactFallback = await tryDecodeSwapCompactOpaque(
      calldataBytes,
      selector,
      opts,
      depth,
      patternNestingDepth,
    );
    if (swapCompactFallback) return swapCompactFallback;

    return {
      status: 'error',
      error: `All candidate signatures failed to decode calldata for selector ${selector}`,
      rawHex: truncateHexForErrorPreview(calldataBytes),
      selector,
    };
  }

  return scored;
}

interface ScoredDecode {
  result: DecodedCalldataOutcome;
  score: number;
}

async function scoreAndDecode(
  candidates: FunctionSignature[],
  paramsHex: string,
  selector: string,
  fullCalldata: string,
  options: DecodeOptions,
  depth: number,
  patternNestingDepth: number,
): Promise<DecodedCalldataOutcome | null> {
  const scored: ScoredDecode[] = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    throwIfDecodeAbortedEvery(options, ci);
    const candidate = candidates[ci];
    try {
      const decoded = tryDecode(candidate, paramsHex);
      if (!decoded) continue;

      const params = await processDecodedParams(
        decoded,
        candidate,
        selector,
        options,
        depth,
        patternNestingDepth,
      );
      throwIfDecodeAborted(options);

      const confidence = determineConfidence(candidate, candidates.length);

      const call: DecodedCall = {
        selector,
        signature: candidate,
        params,
        confidence,
        alternatives: rankSignatureAlternatives(candidates.filter(c => c !== candidate)),
        depth,
        rawCalldata: fullCalldata,
      };

      const score = computeScore(decoded, candidate);
      scored.push({ result: { status: 'success', call }, score });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      // candidate failed, try next
    }
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  return scored[0].result;
}

function tryDecode(sig: FunctionSignature, paramsHex: string): unknown[] | null {
  const paramTypes = sig.params.map(p => p.type);
  if (paramTypes.length === 0 && paramsHex === '0x') {
    return [];
  }

  // Prefer decoding as a flat parameter list. Wrapping as `(type0,type1,...)` and taking `result[0]`
  // breaks single dynamic array params (e.g. `bytes[]`): `result[0]` is the whole array, not `[array]`.
  try {
    return [...coder.decode(paramTypes, paramsHex)];
  } catch {
    try {
      const tupleType = `(${paramTypes.join(',')})`;
      const result = coder.decode([tupleType], paramsHex);
      const inner = result[0] as unknown;
      if (paramTypes.length === 1) {
        return [inner];
      }
      if (inner != null && typeof inner === 'object' && Symbol.iterator in inner) {
        return Array.from(inner as Iterable<unknown>);
      }
      return [inner];
    } catch {
      return null;
    }
  }
}

/**
 * `swapCompact()` selector with trailing packed bytes (not ABI-encoded as a `bytes` argument).
 * @see SWAP_COMPACT_SELECTOR
 */
async function tryDecodeSwapCompactOpaque(
  calldataBytes: string,
  selector: string,
  options: DecodeOptions,
  depth: number,
  patternNestingDepth: number,
): Promise<DecodedCalldataOutcome | null> {
  if (selector.toLowerCase() !== SWAP_COMPACT_SELECTOR) return null;
  if (calldataBytes.length <= SELECTOR_HEX_PREFIX_LENGTH) return null;

  throwIfDecodeAborted(options);

  const tailHex = `0x${calldataBytes.slice(SELECTOR_HEX_PREFIX_LENGTH)}`;
  try {
    getBytes(tailHex);
  } catch {
    return null;
  }

  const syntheticSig: FunctionSignature = {
    selector: SWAP_COMPACT_SELECTOR as HexSelector,
    name: 'swapCompact',
    textSignature: 'swapCompact(bytes compactPayload)',
    params: [{ name: 'compactPayload', type: 'bytes' }],
    source: 'bundled',
  };

  // `convertValue` handles dynamic `bytes` when `raw` is a hex `string` (Uint8Array falls through otherwise).
  const decoded: unknown[] = [tailHex];

  try {
    const params = await processDecodedParams(
      decoded,
      syntheticSig,
      selector,
      options,
      depth,
      patternNestingDepth,
    );
    const head = params[0];
    if (head) {
      head.fieldHint =
        'Signature databases list `swapCompact()` with no ABI args, but this call includes a non-standard packed tail; shown as `bytes`. The decoder scans early bytes for nested function calldata (heuristic) and runs a padded-address scan on the full blob.';
    }

    const call: DecodedCall = {
      selector,
      signature: syntheticSig,
      params,
      confidence: 'high',
      alternatives: [],
      depth,
      rawCalldata: calldataBytes,
    };

    return { status: 'success', call };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return null;
  }
}

function computeScore(decoded: readonly unknown[], sig: FunctionSignature): number {
  let score = 0;

  if (sig.source === 'user-abi') score += 1000;
  else if (sig.source === 'bundled') score += 500;
  else if (sig.source === 'sourcify') score += 120;
  else if (sig.source === 'openchain') score += 100;
  else score += 50;

  score += decoded.length * 10;

  for (const val of decoded) {
    if (typeof val === 'string' && val.startsWith('0x') && val.length === ADDRESS_HEX_STRING_LENGTH) {
      const addr = val.toLowerCase();
      if (addr !== '0x' + '0'.repeat(HEX_CHARS_PER_ADDRESS) && addr !== '0x' + 'f'.repeat(HEX_CHARS_PER_ADDRESS)) {
        score += 5;
      }
    }
  }

  score += sig.popularity ?? 0;
  if (sig.deprecated) score -= DEPRECATED_SCORE_PENALTY;

  return score;
}

function determineConfidence(sig: FunctionSignature, totalCandidates: number): DecodeConfidence {
  if (sig.source === 'user-abi') return 'exact';
  if (sig.source === 'bundled') return 'exact';
  if (totalCandidates === 1) return 'high';
  return 'ambiguous';
}

/**
 * ## Known-multicall pattern attachment (selector → hints)
 *
 * After ABI decode succeeds, `getKnownPattern` matches the call’s 4-byte selector to a static
 * `MulticallPattern` in `knownPatterns.ts` (Multicall2/3, Universal Router, Gnosis `execTransaction`,
 * `multiSend`, Pendle `multicall`, etc.). Each pattern lists `CalldataIndex` entries: which **top-level**
 * parameter index (`paramIndex`) may hold nested calldata, and for tuple batches which **field** (`tuple-field`
 * `fieldIndex`) inside each row is dynamic `bytes`.
 *
 * For each decoded argument `i`, only hints with `paramIndex === i` are passed into `convertValue` as
 * `calldataHints`. Expansion is **gated on Solidity type**: e.g. `direct` applies only when the param is dynamic
 * `bytes` (`isDynamicBytesSolidityType`); `array-direct` requires `bytes[]`; `gnosis-multisend` switches to
 * packed `convertGnosisMultiSend` instead of standard tuple layout. Nested `decodeCalldata` increments
 * stack `depth` always, and `patternNestingDepth` only for pattern-marked calldata, capped by
 * `multicallNestLimit` / `maxRecursionDepth` / `allowRecursive` (see `convertBytesValue`).
 */
async function processDecodedParams(
  decoded: readonly unknown[],
  sig: FunctionSignature,
  selector: string,
  options: DecodeOptions,
  depth: number,
  patternNestingDepth: number,
): Promise<DecodedParam[]> {
  const pattern = getKnownPattern(selector);
  const params: DecodedParam[] = [];

  for (let i = 0; i < sig.params.length; i++) {
    throwIfDecodeAbortedEvery(options, i);
    const { name, type } = sig.params[i];
    const raw = decoded[i];

    const calldataHints = pattern
      ? pattern.calldataIndices.filter(ci => ci.paramIndex === i)
      : [];

    const value = await convertValue(
      raw,
      type,
      calldataHints,
      options,
      depth,
      pattern,
      patternNestingDepth,
    );
    throwIfDecodeAborted(options);

    params.push({
      name,
      type,
      value,
      rawHex: toRawHex(raw),
    });
  }

  for (const p of params) {
    enrichWordAlignedAddressesInParam(p, options.chainId);
  }

  await enrichParamsWithTokenContext(params, options, sig, depth);
  throwIfDecodeAborted(options);
  enrichDestinationChainIdLabels(params);
  enrichEnsoExecuteShortcutLeavesInterpretation(params, selector, sig);
  await enrichAddressNodesWithEns(params, options);
  throwIfDecodeAborted(options);
  return params;
}

/** `uint` / `uint256` / … only (not `uint256[]` or tuples). */
function isBareUintSolidityType(type: string): boolean {
  const t = type.replace(/\s/g, '').toLowerCase();
  return t === 'uint' || /^uint\d+$/.test(t);
}

/**
 * Show a human chain name next to `destinationChainId` (and nested calldata) when the ID is known.
 */
function enrichDestinationChainIdOnParam(param: DecodedParam): void {
  const nameNorm = param.name.replace(/\s/g, '').toLowerCase();
  if (nameNorm === 'destinationchainid' && isBareUintSolidityType(param.type)) {
    if (param.value.kind === 'primitive' && typeof param.value.raw === 'string') {
      const suffix = formatDestinationChainInterpretation(param.value.raw);
      if (suffix !== undefined) {
        const existing = param.value.interpretation;
        param.value.interpretation = existing ? `${existing} · ${suffix}` : suffix;
      }
    }
  }

  const v = param.value;
  if (v.kind === 'tuple') {
    for (const f of v.fields) enrichDestinationChainIdOnParam(f);
  } else if (v.kind === 'array') {
    for (const el of v.elements) {
      if (el.kind === 'tuple') {
        for (const f of el.fields) enrichDestinationChainIdOnParam(f);
      }
    }
  } else if (v.kind === 'bytes' && v.decoded) {
    for (const p of v.decoded.params) enrichDestinationChainIdOnParam(p);
  }
}

function enrichDestinationChainIdLabels(params: DecodedParam[]): void {
  for (const p of params) enrichDestinationChainIdOnParam(p);
}

/**
 * Enso `leaves` are `bytes32[]` route step ids (opaque on-chain), not ABI calldata — unlike `commands[]`, they do not
 * decode as nested function calls. Adds UI copy so users are not looking for a missing nested decode.
 */
function enrichEnsoExecuteShortcutLeavesInterpretation(
  params: DecodedParam[],
  selector: string,
  sig: FunctionSignature,
): void {
  if (selector.toLowerCase() !== ENSO_EXECUTE_SHORTCUT_SELECTOR) return;
  if (sig.name !== 'executeShortcut') return;
  const leaves = params.find(p => p.name === 'leaves');
  if (!leaves || leaves.value.kind !== 'array') return;
  if (leaves.value.elementType.replace(/\s/g, '') !== 'bytes32') return;
  const note = 'Enso route leaf id (opaque bytes32; nested calldata is under commands[])';
  for (const el of leaves.value.elements) {
    if (el.kind !== 'primitive') continue;
    const prev = el.interpretation;
    el.interpretation = prev ? `${prev} · ${note}` : note;
  }
}

function enrichWordAlignedAddressesInParam(param: DecodedParam, chainId: number): void {
  enrichWordAlignedAddressesInValue(param.value, chainId);
}

/** Surfaces left-padded addresses at 32-byte ABI word boundaries inside dynamic `bytes` (opaque Enso cells, etc.). */
function enrichWordAlignedAddressesInValue(v: DecodedValue, chainId: number): void {
  if (v.kind === 'bytes') {
    // Idempotent: skip rescans if enrichment runs twice on the same node; [] means scanned with no hits.
    if (v.wordAlignedAddresses === undefined) {
      v.wordAlignedAddresses = scanHexForWordAlignedPaddedAddresses(v.hex, chainId);
    }
    if (v.decoded) {
      for (const p of v.decoded.params) {
        enrichWordAlignedAddressesInParam(p, chainId);
      }
    }
    return;
  }
  if (v.kind === 'tuple') {
    for (const f of v.fields) enrichWordAlignedAddressesInParam(f, chainId);
    return;
  }
  if (v.kind === 'array') {
    for (const e of v.elements) enrichWordAlignedAddressesInValue(e, chainId);
  }
}

type AddressDecodedValue = Extract<DecodedValue, { kind: 'address' }>;
type PrimitiveDecodedValue = Extract<DecodedValue, { kind: 'primitive' }>;

type EnsTarget =
  | { kind: 'address'; node: AddressDecodedValue }
  | { kind: 'embedded'; primitive: PrimitiveDecodedValue }
  | { kind: 'bytesWordAddr'; hit: WordAlignedAddressHit };

function collectEnsTargets(value: DecodedValue, byKey: Map<string, EnsTarget[]>): void {
  if (value.kind === 'address') {
    const k = value.checksummed.toLowerCase();
    const arr = byKey.get(k) ?? [];
    arr.push({ kind: 'address', node: value });
    byKey.set(k, arr);
    return;
  }
  if (value.kind === 'primitive' && value.embeddedEvmAddress) {
    const k = value.embeddedEvmAddress.checksummed.toLowerCase();
    const arr = byKey.get(k) ?? [];
    arr.push({ kind: 'embedded', primitive: value });
    byKey.set(k, arr);
    return;
  }
  if (value.kind === 'tuple') {
    for (const f of value.fields) collectEnsTargets(f.value, byKey);
    return;
  }
  if (value.kind === 'array') {
    for (const e of value.elements) collectEnsTargets(e, byKey);
    return;
  }
  if (value.kind === 'bytes') {
    if (value.wordAlignedAddresses?.length) {
      for (const hit of value.wordAlignedAddresses) {
        const k = hit.checksummed.toLowerCase();
        const arr = byKey.get(k) ?? [];
        arr.push({ kind: 'bytesWordAddr', hit });
        byKey.set(k, arr);
      }
    }
    if (value.decoded) {
      for (const p of value.decoded.params) collectEnsTargets(p.value, byKey);
    }
  }
}

async function enrichAddressNodesWithEns(params: DecodedParam[], options: DecodeOptions): Promise<void> {
  if (options.offlineMode || options.resolveEns === false) return;

  const byKey = new Map<string, EnsTarget[]>();
  for (let pi = 0; pi < params.length; pi++) {
    throwIfDecodeAbortedEvery(options, pi);
    collectEnsTargets(params[pi].value, byKey);
  }
  if (byKey.size === 0) return;

  await Promise.all(
    [...byKey.values()].map(async (targets, ei) => {
      throwIfDecodeAbortedEvery(options, ei);
      const head = targets[0];
      const addr =
        head.kind === 'address'
          ? head.node.checksummed
          : head.kind === 'embedded'
            ? head.primitive.embeddedEvmAddress!.checksummed
            : head.hit.checksummed;
      const name = await reverseResolveEns(addr, {
        offlineMode: options.offlineMode,
        signal: options.signal,
      });
      if (!name) return;
      for (const t of targets) {
        if (t.kind === 'address') {
          t.node.ensName = name;
        } else if (t.kind === 'embedded') {
          const emb = t.primitive.embeddedEvmAddress;
          if (emb) emb.ensName = name;
        } else {
          t.hit.ensName = name;
        }
      }
    }),
  );
}

function tokenLookupCacheKeyPart(chainId: unknown): string {
  return typeof chainId === 'number' && Number.isFinite(chainId) ? String(Math.trunc(chainId)) : '__chain__';
}

async function resolveTokenInfo(
  address: string,
  options: DecodeOptions,
): Promise<TokenInfo | undefined> {
  const reg = getTokenInfo(address, options.chainId);
  if (reg) return reg;
  if (options.offlineMode || options.fetchTokenDecimalsOnChain === false) return undefined;

  const cache = options.tokenLookupSessionCache;
  if (!cache) {
    return fetchOnChainTokenDecimals(address, options.chainId, options.signal);
  }

  const key = `${tokenLookupCacheKeyPart(options.chainId)}:${address.toLowerCase()}`;
  let pending = cache.get(key);
  if (pending === undefined) {
    const p = fetchOnChainTokenDecimals(address, options.chainId, options.signal);
    pending = p.catch(e => {
      if (e instanceof DOMException && e.name === 'AbortError') {
        cache.delete(key);
      }
      throw e;
    });
    cache.set(key, pending);
  }
  return pending;
}

/**
 * For a decoded uint/int primitive next to a known `token`, set human-readable amount interpretation.
 * Skips timestamp hints (unless `fromKnownRouterAmount`), max-uint display, and zero values.
 */
function applyTokenContextToUintPrimitive(
  paramType: string,
  value: DecodedValue,
  token: TokenInfo,
  /** When true, override a prior `Timestamp:` heuristic (router args can be 10-digit wei-style values). */
  fromKnownRouterAmount = false,
): void {
  if (value.kind !== 'primitive') return;
  if (!paramType.startsWith('uint') && !paramType.startsWith('int')) return;
  if (!fromKnownRouterAmount && value.interpretation?.includes('Timestamp:')) return;
  if (value.display === 'type(uint256).max') {
    value.interpretation = `Unlimited ${token.symbol} approval`;
    return;
  }
  const val = BigInt(value.raw);
  if (val === 0n) return;
  if (tokenAmountWholePartExceedsPlausibleDisplay(value.raw, token.decimals)) {
    return;
  }
  const fmt = formatTokenAmount(value.raw, token.decimals, token.symbol);
  value.interpretation = fmt.interpretation;
}

/** `address[]` or fixed `address[k]` (e.g. Curve `_route`, `_pools`). */
function isAddressVectorType(solidityType: string): boolean {
  const t = solidityType.replace(/\s/g, '');
  if (t === 'address[]') return true;
  const fixed = parseFixedAbiArraySuffix(t);
  return fixed !== null && fixed.baseType === 'address';
}

/** Distinct addresses from `address` and `address[]` params (first-seen representative, stable order). */
function collectDistinctAddressParamValues(params: DecodedParam[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (addr: string) => {
    const lo = addr.toLowerCase();
    if (seen.has(lo)) return;
    seen.add(lo);
    out.push(addr);
  };
  for (const p of params) {
    if (p.value.kind === 'address') {
      add(p.value.address);
    }
    if (p.value.kind === 'array' && isAddressVectorType(p.type)) {
      for (const e of p.value.elements) {
        if (e.kind === 'address') add(e.address);
      }
    }
  }
  return out;
}

/**
 * Resolve distinct tokens from top-level `address` and `address[]` params (swap paths, etc.).
 * Runs RPC lookups in parallel; {@link DecodeOptions.signal} is checked before each task and passed into
 * {@link fetchOnChainTokenDecimals} so new work stops when aborted — in-flight JSON-RPC may still finish until timeout.
 */
async function collectResolvedTokensFromParams(
  params: DecodedParam[],
  options: DecodeOptions,
): Promise<Map<string, TokenInfo>> {
  const byLower = new Map<string, TokenInfo>();
  const addrs = collectDistinctAddressParamValues(params);
  await Promise.all(
    addrs.map(async addr => {
      throwIfDecodeAborted(options);
      const t = await resolveTokenInfo(addr, options);
      if (t) byLower.set(addr.toLowerCase(), t);
    }),
  );
  return byLower;
}

/**
 * Uniswap V2-style routers: map `amountIn` / `amountOutMin` to `path[0]` / `path[last]` tokens.
 * Returns true when this handler ran (skip generic single-token blanket for this frame).
 */
async function tryEnrichUniswapV2PathSwaps(
  params: DecodedParam[],
  options: DecodeOptions,
  sig: FunctionSignature,
): Promise<boolean> {
  const n = sig.name;
  if (
    n !== 'swapExactTokensForTokens' &&
    n !== 'swapExactTokensForETH' &&
    n !== 'swapExactETHForTokens'
  ) {
    return false;
  }

  const pathParam =
    params.find(p => p.name === 'path' && isAddressVectorType(p.type)) ??
    params.find(p => p.type.replace(/\s/g, '') === 'address[]');
  if (!pathParam || pathParam.value.kind !== 'array') return false;

  const pathAddrs = pathParam.value.elements.filter(
    (e): e is Extract<DecodedValue, { kind: 'address' }> => e.kind === 'address',
  );
  if (pathAddrs.length < 2) return false;

  const [tokenIn, tokenOut] = await Promise.all([
    resolveTokenInfo(pathAddrs[0].address, options),
    resolveTokenInfo(pathAddrs[pathAddrs.length - 1].address, options),
  ]);
  throwIfDecodeAborted(options);

  const amountIn = params.find(p => p.name === 'amountIn');
  const amountOutMin = params.find(p => p.name === 'amountOutMin');

  if (n === 'swapExactTokensForTokens' && amountIn && tokenIn) {
    applyTokenContextToUintPrimitive(amountIn.type, amountIn.value, tokenIn, true);
  }
  if ((n === 'swapExactTokensForTokens' || n === 'swapExactTokensForETH') && amountOutMin && tokenOut) {
    applyTokenContextToUintPrimitive(amountOutMin.type, amountOutMin.value, tokenOut, true);
  }
  if (n === 'swapExactETHForTokens' && amountOutMin && tokenOut) {
    applyTokenContextToUintPrimitive(amountOutMin.type, amountOutMin.value, tokenOut, true);
  }

  return true;
}

/**
 * Curve router `exchange`: `_amount` is in the first resolvable token in `_route`, `_min_dy` in the last.
 * Returns true when this frame matches the known selector so generic single-token uint enrichment is skipped.
 */
/**
 * ERC-4626 `withdraw(uint256,address,address)`: `assets` is in the **underlying** ERC-20 from `asset()` on the
 * vault ({@link DecodeOptions.callTarget}), not in the calldata `receiver` / `owner` addresses.
 */
async function tryEnrichErc4626Withdraw(
  params: DecodedParam[],
  options: DecodeOptions,
  sig: FunctionSignature,
): Promise<boolean> {
  if (sig.selector.toLowerCase() !== ERC4626_WITHDRAW_SELECTOR) return false;
  if (sig.name !== 'withdraw') return false;
  const vault = options.callTarget?.trim();
  if (!vault) return false;
  if (params.length !== 3) return false;

  const assetsP = params[0];
  const recvP = params[1];
  const ownerP = params[2];
  if (!assetsP.type.replace(/\s/g, '').startsWith('uint')) return false;
  if (recvP.type.replace(/\s/g, '').toLowerCase() !== 'address') return false;
  if (ownerP.type.replace(/\s/g, '').toLowerCase() !== 'address') return false;
  if (assetsP.value.kind !== 'primitive') return false;
  if (recvP.value.kind !== 'address' || ownerP.value.kind !== 'address') return false;

  throwIfDecodeAborted(options);
  const underlyingAddr = await fetchErc4626UnderlyingAsset(vault, options.chainId, options.signal);
  throwIfDecodeAborted(options);
  if (!underlyingAddr) return false;

  const token = await resolveTokenInfo(underlyingAddr, options);
  throwIfDecodeAborted(options);
  if (!token) return false;

  applyTokenContextToUintPrimitive(assetsP.type, assetsP.value, token, true);
  assetsP.fieldHint =
    'ERC-4626-style `withdraw`: this amount is **underlying assets** (not vault shares). Decimals follow the vault `asset()` token — set transaction **To** to the vault when decoding calldata alone.';
  return true;
}

/**
 * LayerZero V2 OFT: `send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),…)` — `amountLD` / `minAmountLD`
 * are denominated in the OFT token at {@link DecodeOptions.callTarget} (the called contract).
 */
async function tryEnrichLayerZeroOftSend(
  params: DecodedParam[],
  options: DecodeOptions,
  sig: FunctionSignature,
): Promise<boolean> {
  if (sig.selector.toLowerCase() !== LAYERZERO_OFT_SEND_SELECTOR) return false;
  const target = options.callTarget?.trim();
  if (!target) return false;

  const sendParam = params[0];
  if (!sendParam || sendParam.value.kind !== 'tuple') return false;
  const t = sendParam.type.replace(/\s/g, '');
  if (t !== '(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)') return false;

  const fields = sendParam.value.fields;
  if (fields.length < 4) return false;
  const amountT = fields[2].type.replace(/\s/g, '');
  const minT = fields[3].type.replace(/\s/g, '');
  if (!amountT.startsWith('uint') || !minT.startsWith('uint')) return false;

  const token = await resolveTokenInfo(target, options);
  throwIfDecodeAborted(options);
  if (!token) return false;

  applyTokenContextToUintPrimitive(fields[2].type, fields[2].value, token, true);
  applyTokenContextToUintPrimitive(fields[3].type, fields[3].value, token, true);
  return true;
}

/**
 * Across SpokePool V2 `deposit`: `inputAmount` / `outputAmount` follow `inputToken` / `outputToken` as bytes32-wrapped addresses.
 */
async function tryEnrichAcrossSpokeDeposit(
  params: DecodedParam[],
  options: DecodeOptions,
  sig: FunctionSignature,
): Promise<boolean> {
  if (sig.selector.toLowerCase() !== ACROSS_SPOKE_DEPOSIT_SELECTOR) return false;
  if (sig.name !== 'deposit') return false;
  if (params.length !== 12) return false;

  const inputTokenP = params.find(p => p.name === 'inputToken');
  const outputTokenP = params.find(p => p.name === 'outputToken');
  const inputAmountP = params.find(p => p.name === 'inputAmount');
  const outputAmountP = params.find(p => p.name === 'outputAmount');
  if (!inputTokenP || !outputTokenP || !inputAmountP || !outputAmountP) return false;

  const inT = inputTokenP.type.replace(/\s/g, '').toLowerCase();
  const outT = outputTokenP.type.replace(/\s/g, '').toLowerCase();
  if (inT !== 'bytes32' || outT !== 'bytes32') return false;

  const extractAddr = (p: DecodedParam): string | undefined => {
    if (p.value.kind !== 'primitive' || typeof p.value.raw !== 'string') return undefined;
    return extractLeftPaddedAddressFromBytes32(p.value.raw);
  };

  const inputAddr = extractAddr(inputTokenP);
  const outputAddr = extractAddr(outputTokenP);
  if (!inputAddr || !outputAddr) return false;

  const tokenIn = await resolveTokenInfo(inputAddr, options);
  throwIfDecodeAborted(options);
  const tokenOut = await resolveTokenInfo(outputAddr, options);
  throwIfDecodeAborted(options);

  if (tokenIn) applyTokenContextToUintPrimitive(inputAmountP.type, inputAmountP.value, tokenIn, true);
  if (tokenOut) applyTokenContextToUintPrimitive(outputAmountP.type, outputAmountP.value, tokenOut, true);

  return true;
}

async function tryEnrichCurveRouterExchange(
  params: DecodedParam[],
  options: DecodeOptions,
  sig: FunctionSignature,
): Promise<boolean> {
  if (sig.selector.toLowerCase() !== CURVE_ROUTER_EXCHANGE_SELECTOR) return false;

  const route = params.find(p => p.name === '_route');
  if (!route || route.value.kind !== 'array') return false;
  const routeFixed = parseFixedAbiArraySuffix(route.type.replace(/\s/g, ''));
  if (!routeFixed || routeFixed.baseType !== 'address') return false;

  const amountP = params.find(p => p.name === '_amount');
  const minDyP = params.find(p => p.name === '_min_dy');
  if (!amountP || !minDyP) return false;

  const pathAddrs = route.value.elements.filter(
    (e): e is Extract<DecodedValue, { kind: 'address' }> => e.kind === 'address',
  );

  let tokenIn: TokenInfo | undefined;
  for (const e of pathAddrs) {
    if (e.address.toLowerCase() === ZERO_ADDRESS_LOWER) continue;
    tokenIn = await resolveTokenInfo(e.address, options);
    throwIfDecodeAborted(options);
    if (tokenIn) break;
  }

  let tokenOut: TokenInfo | undefined;
  for (let i = pathAddrs.length - 1; i >= 0; i--) {
    const e = pathAddrs[i];
    if (e.address.toLowerCase() === ZERO_ADDRESS_LOWER) continue;
    tokenOut = await resolveTokenInfo(e.address, options);
    throwIfDecodeAborted(options);
    if (tokenOut) break;
  }

  if (tokenIn) applyTokenContextToUintPrimitive(amountP.type, amountP.value, tokenIn, true);
  if (tokenOut) applyTokenContextToUintPrimitive(minDyP.type, minDyP.value, tokenOut, true);

  const swapParamsP = params.find(p => p.name === '_swap_params');
  if (swapParamsP) {
    const ann = annotateCurveRouterSwapParams(swapParamsP.value);
    swapParamsP.value = ann.value;
  }

  return true;
}

/** Human-readable slot notes for 1inch `swap` `desc` tuples (anonymous `fieldN` in ABI). */
function annotateOneInchSwapDescFieldHints(desc: DecodedParam, selectorLower: string): void {
  if (desc.value.kind !== 'tuple') return;
  const fields = desc.value.fields;
  desc.fieldHint =
    '1inch swap descriptor: sell/buy tokens and amounts live in fields 4–5; later uints are router metadata (flags, deadline, …), not extra token balances.';

  if (selectorLower === ONEINCH_AGG_SWAP_SELECTOR_V6 && fields.length >= 10) {
    const hints = [
      'Token you sell (input to the route).',
      'Token you buy (output from the route).',
      'Address that receives leftover input token (often the router).',
      'Recipient of output token.',
      'Amount of srcToken to sell (srcToken decimals).',
      'Minimum dstToken to receive (dstToken decimals; slippage floor).',
      'Router flags (bitfield; not an ERC-20 amount).',
      'Often deadline (Unix seconds) or second control word — not a token amount.',
      'Auxiliary address (router-specific; e.g. permit / callback target).',
      'Opaque router bytes (not nested calldata in this decoder).',
    ];
    for (let i = 0; i < hints.length && i < fields.length; i++) {
      fields[i].fieldHint = hints[i];
    }
    return;
  }

  if (selectorLower === ONEINCH_AGG_SWAP_SELECTOR_V5 && fields.length >= 7) {
    const hints = [
      'Token you sell.',
      'Token you buy.',
      'Address receiving leftover input (often router).',
      'Recipient of output token.',
      'Amount of srcToken to sell (src decimals).',
      'Minimum dstToken out (dst decimals).',
      'Flags or deadline-style uint (router-specific; not a second min-out amount).',
    ];
    for (let i = 0; i < hints.length && i < fields.length; i++) {
      fields[i].fieldHint = hints[i];
    }
  }
}

/**
 * 1inch `swap(executor, desc, …)`: `desc.amount` is in `desc.srcToken` decimals, `desc.minReturnAmount` in `desc.dstToken`.
 * Generic tuple enrichment bails when multiple tokens appear in `desc`, so uints stay raw without this pass.
 */
async function tryEnrich1inchAggregationSwapDesc(
  params: DecodedParam[],
  options: DecodeOptions,
  sig: FunctionSignature,
  skipTupleParents: Set<DecodedParam>,
): Promise<boolean> {
  if (sig.name !== 'swap') return false;
  const sel = sig.selector.toLowerCase();
  if (sel !== ONEINCH_AGG_SWAP_SELECTOR_V5 && sel !== ONEINCH_AGG_SWAP_SELECTOR_V6) return false;

  const desc = params.find(p => p.name === 'desc');
  if (!desc || desc.value.kind !== 'tuple') return false;
  const fields = desc.value.fields;
  if (sel === ONEINCH_AGG_SWAP_SELECTOR_V6) {
    if (fields.length < 10) return false;
  } else if (fields.length < 6) {
    return false;
  }

  const srcTok = fields[0];
  const dstTok = fields[1];
  if (srcTok.type.replace(/\s/g, '').toLowerCase() !== 'address') return false;
  if (dstTok.type.replace(/\s/g, '').toLowerCase() !== 'address') return false;
  if (srcTok.value.kind !== 'address' || dstTok.value.kind !== 'address') return false;

  const amountP = fields[4];
  const minRetP = fields[5];
  if (!amountP.type.replace(/\s/g, '').startsWith('uint')) return false;
  if (!minRetP.type.replace(/\s/g, '').startsWith('uint')) return false;

  skipTupleParents.add(desc);

  const tokenIn = await resolveTokenInfo(srcTok.value.address, options);
  throwIfDecodeAborted(options);
  const tokenOut = await resolveTokenInfo(dstTok.value.address, options);
  throwIfDecodeAborted(options);

  if (tokenIn) applyTokenContextToUintPrimitive(amountP.type, amountP.value, tokenIn, true);
  if (tokenOut) applyTokenContextToUintPrimitive(minRetP.type, minRetP.value, tokenOut, true);

  annotateOneInchSwapDescFieldHints(desc, sel);

  return true;
}

/** Human-readable slot notes for Uniswap V3 `exactInputSingle` / `exactOutputSingle` `params` tuples. */
function annotateUniswapV3ExactSingleParamsHints(
  paramsParam: DecodedParam,
  fn: 'exactInputSingle' | 'exactOutputSingle',
): void {
  if (paramsParam.value.kind !== 'tuple') return;
  const fields = paramsParam.value.fields;
  if (fields.length !== 8) return;

  paramsParam.fieldHint =
    'Uniswap V3 single-pool swap: fields 5–6 are token amounts (which token depends on exactInput vs exactOutput); field 4 is deadline (Unix seconds); field 7 is sqrtPriceLimitX96 (price bound), not an ERC-20 amount.';

  const baseHints = [
    'Input token for this hop (sold from your perspective on exactInput).',
    'Output token (bought).',
    'Pool fee tier in hundredths of a bip (uint24): e.g. 500 = 0.05%, 3000 = 0.3%, 10000 = 1%.',
    'Address that receives the output tokens.',
    'Deadline: Unix timestamp (seconds) — swap must execute before this time.',
    '',
    '',
    'sqrtPriceLimitX96: Q64.96 square-root price cap/floor for the swap; 0 = no limit. Not a token balance.',
  ];

  if (fn === 'exactInputSingle') {
    baseHints[5] = 'amountIn: exact input you supply (tokenIn decimals).';
    baseHints[6] = 'amountOutMinimum: minimum output accepted (tokenOut decimals; slippage protection).';
  } else {
    baseHints[5] = 'amountOut: exact output you want (tokenOut decimals).';
    baseHints[6] = 'amountInMaximum: maximum input you allow (tokenIn decimals; slippage ceiling).';
  }

  for (let i = 0; i < baseHints.length; i++) {
    if (baseHints[i]) {
      fields[i].fieldHint = baseHints[i];
    }
  }
}

/**
 * Uniswap V3 single-pool swaps: only `amountIn`/`amountOutMinimum` (or output-flavor amounts) are token-denominated.
 * `deadline` and `sqrtPriceLimitX96` are uints in the same tuple — generic single-token tuple enrichment wrongly tags them.
 */
async function tryEnrichUniswapV3ExactSingleParamsTuple(
  params: DecodedParam[],
  options: DecodeOptions,
  sig: FunctionSignature,
  skipTupleParents: Set<DecodedParam>,
): Promise<void> {
  const sel = sig.selector.toLowerCase();
  if (sel !== UNISWAP_V3_EXACT_INPUT_SINGLE_SELECTOR && sel !== UNISWAP_V3_EXACT_OUTPUT_SINGLE_SELECTOR) {
    return;
  }
  const fn = sig.name;
  if (fn !== 'exactInputSingle' && fn !== 'exactOutputSingle') return;

  const p = params.find(q => q.name === 'params' && q.value.kind === 'tuple');
  if (!p || p.value.kind !== 'tuple') return;
  if (p.type.replace(/\s/g, '') !== UNISWAP_V3_EXACT_SINGLE_PARAMS_TUPLE) return;

  const fields = p.value.fields;
  if (fields.length !== 8) return;

  const tokenInF = fields[0];
  const tokenOutF = fields[1];
  if (tokenInF.type.replace(/\s/g, '').toLowerCase() !== 'address') return;
  if (tokenOutF.type.replace(/\s/g, '').toLowerCase() !== 'address') return;
  if (tokenInF.value.kind !== 'address' || tokenOutF.value.kind !== 'address') return;

  const amtA = fields[5];
  const amtB = fields[6];
  if (!amtA.type.replace(/\s/g, '').startsWith('uint256')) return;
  if (!amtB.type.replace(/\s/g, '').startsWith('uint256')) return;

  skipTupleParents.add(p);

  const tokenIn = await resolveTokenInfo(tokenInF.value.address, options);
  throwIfDecodeAborted(options);
  const tokenOut = await resolveTokenInfo(tokenOutF.value.address, options);
  throwIfDecodeAborted(options);

  if (fn === 'exactInputSingle') {
    if (tokenIn) applyTokenContextToUintPrimitive(amtA.type, amtA.value, tokenIn, true);
    if (tokenOut) applyTokenContextToUintPrimitive(amtB.type, amtB.value, tokenOut, true);
    annotateUniswapV3ExactSingleParamsHints(p, 'exactInputSingle');
  } else {
    if (tokenOut) applyTokenContextToUintPrimitive(amtA.type, amtA.value, tokenOut, true);
    if (tokenIn) applyTokenContextToUintPrimitive(amtB.type, amtB.value, tokenIn, true);
    annotateUniswapV3ExactSingleParamsHints(p, 'exactOutputSingle');
  }
}

async function enrichParamsWithTokenContext(
  params: DecodedParam[],
  options: DecodeOptions,
  sig: FunctionSignature,
  depth: number,
): Promise<void> {
  const skipTupleParents = new Set<DecodedParam>();
  await tryEnrichUniswapV3ExactSingleParamsTuple(params, options, sig, skipTupleParents);
  throwIfDecodeAborted(options);
  const inchSwapMatched = await tryEnrich1inchAggregationSwapDesc(params, options, sig, skipTupleParents);
  throwIfDecodeAborted(options);

  const tupleEnrichJobs: Promise<void>[] = [];
  for (const p of params) {
    if (p.value.kind === 'tuple' && !skipTupleParents.has(p)) {
      tupleEnrichJobs.push(enrichTupleWithTokenContext(p.value.fields, options));
    }
    if (p.value.kind === 'array') {
      for (const elem of p.value.elements) {
        if (elem.kind === 'tuple') {
          tupleEnrichJobs.push(enrichTupleWithTokenContext(elem.fields, options));
        }
      }
    }
  }
  await Promise.all(tupleEnrichJobs);
  throwIfDecodeAborted(options);

  if (inchSwapMatched) {
    return;
  }

  if (depth === 0 && (await tryEnrichErc4626Withdraw(params, options, sig))) {
    return;
  }
  if (depth === 0 && (await tryEnrichLayerZeroOftSend(params, options, sig))) {
    return;
  }
  if (depth === 0 && (await tryEnrichAcrossSpokeDeposit(params, options, sig))) {
    return;
  }
  if (await tryEnrichUniswapV2PathSwaps(params, options, sig)) {
    return;
  }
  if (await tryEnrichCurveRouterExchange(params, options, sig)) {
    return;
  }

  const resolvedMap = await collectResolvedTokensFromParams(params, options);
  throwIfDecodeAborted(options);
  if (resolvedMap.size >= 2) {
    return;
  }

  let token: TokenInfo | undefined =
    resolvedMap.size === 1 ? [...resolvedMap.values()][0] : undefined;
  if (!token) {
    const addressParams = params.filter(p => p.value.kind === 'address');
    if (addressParams.length > 0) {
      const resolved = await Promise.all(
        addressParams.map(p =>
          resolveTokenInfo((p.value as Extract<DecodedValue, { kind: 'address' }>).address, options),
        ),
      );
      throwIfDecodeAborted(options);
      for (const t of resolved) {
        if (t) {
          token = t;
          break;
        }
      }
    }
  }

  if (!token) return;

  for (const p of params) {
    applyTokenContextToUintPrimitive(p.type, p.value, token);
  }
}

async function enrichTupleWithTokenContext(
  fields: DecodedParam[],
  options: DecodeOptions,
): Promise<void> {
  const byLower = new Map<string, TokenInfo>();
  const addrs = collectDistinctAddressParamValues(fields);
  await Promise.all(
    addrs.map(async addr => {
      throwIfDecodeAborted(options);
      const t = await resolveTokenInfo(addr, options);
      if (t) byLower.set(addr.toLowerCase(), t);
    }),
  );

  if (byLower.size >= 2) {
    return;
  }

  let token: TokenInfo | undefined = byLower.size === 1 ? [...byLower.values()][0] : undefined;
  if (!token) {
    const addressFields = fields.filter(f => f.value.kind === 'address');
    if (addressFields.length > 0) {
      const resolved = await Promise.all(
        addressFields.map(f =>
          resolveTokenInfo((f.value as Extract<DecodedValue, { kind: 'address' }>).address, options),
        ),
      );
      throwIfDecodeAborted(options);
      for (const t of resolved) {
        if (t) {
          token = t;
          break;
        }
      }
    }
  }

  if (!token) return;

  for (const f of fields) {
    applyTokenContextToUintPrimitive(f.type, f.value, token);
  }
}

/**
 * Enso `executeShortcut` `commands[]` elements are often `abi.encode(uint256 length, bytes inner)` where `inner`
 * is nested contract calldata (or ABI-wrapped blobs with calldata at a later 32-byte-aligned offset).
 */
async function tryExpandEnsoShortcutCommandBytes(
  cleanHex: string,
  options: DecodeOptions,
  depth: number,
  outerPattern: MulticallPattern | undefined,
  patternNestingDepth: number,
): Promise<DecodedValue | null> {
  let buf: Uint8Array;
  try {
    buf = getBytes(cleanHex);
  } catch {
    return null;
  }
  const byteLen = buf.length;
  if (byteLen <= ABI_WORD_BYTE_LENGTH) return null;

  const claimedLenBn = BigInt(hexlify(buf.subarray(0, ABI_WORD_BYTE_LENGTH)));
  if (claimedLenBn <= 0n || claimedLenBn > BigInt(MAX_INPUT_BYTES)) return null;
  if (claimedLenBn > BigInt(byteLen - ABI_WORD_BYTE_LENGTH)) return null;

  const payloadLen = Number(claimedLenBn);
  const inner = buf.subarray(ABI_WORD_BYTE_LENGTH, ABI_WORD_BYTE_LENGTH + payloadLen);

  const globalNestCap = options.multicallNestLimit ?? DEFAULT_MULTICALL_PATTERN_NEST_LIMIT;
  const nestLimit = Math.min(
    options.maxDepth,
    globalNestCap,
    outerPattern?.maxRecursionDepth ?? Number.POSITIVE_INFINITY,
  );
  if (patternNestingDepth >= nestLimit) return null;

  const nextPatternNest = patternNestingDepth + 1;

  const maxWords = Math.min(Math.ceil(inner.length / ABI_WORD_BYTE_LENGTH), 96);

  for (let w = 0; w < maxWords; w++) {
    throwIfDecodeAbortedEvery(options, w);
    const start = w * ABI_WORD_BYTE_LENGTH;
    if (start + ABI_SELECTOR_BYTE_LENGTH > inner.length) break;
    if (
      inner[start] === 0 &&
      inner[start + 1] === 0 &&
      inner[start + 2] === 0 &&
      inner[start + 3] === 0
    ) {
      continue;
    }
    const sliceHex = hexlify(inner.subarray(start));
    const childSel = extractSelector(sliceHex);
    if (
      outerPattern?.allowRecursive === false &&
      childSel &&
      isKnownMulticallSelector(childSel)
    ) {
      continue;
    }
    const result = await decodeCalldata(sliceHex, options, depth + 1, nextPatternNest);
    throwIfDecodeAborted(options);
    if (result.status === 'success' || result.status === 'partial') {
      return { kind: 'bytes', hex: cleanHex, decoded: result.call };
    }
  }

  return null;
}

function swapCompactInnerDecodeOffsets(byteLen: number): number[] {
  const maxEnd = Math.min(byteLen - ABI_SELECTOR_BYTE_LENGTH, MAX_SWAP_COMPACT_INNER_SCAN_BYTES);
  if (maxEnd < 0) return [];

  const seen = new Set<number>();
  const push = (i: number): boolean => {
    if (i < 0 || i > maxEnd) return false;
    if (seen.size >= MAX_SWAP_COMPACT_INNER_DECODE_ATTEMPTS) return false;
    seen.add(i);
    return true;
  };

  push(0);
  for (let i = 1; i <= Math.min(127, maxEnd); i++) {
    if (!push(i)) break;
  }
  for (let i = 0; i <= maxEnd; i += ABI_SELECTOR_BYTE_LENGTH) {
    if (!push(i)) break;
  }

  return [...seen].sort((a, b) => a - b);
}

/**
 * Best-effort: find the strongest `decodeCalldata` result starting at any scanned offset in a packed tail.
 */
async function pickBestSwapCompactInnerCalldata(
  cleanHex: string,
  options: DecodeOptions,
  depth: number,
  nextPatternNest: number,
): Promise<DecodedCall | null> {
  let buf: Uint8Array;
  try {
    buf = getBytes(cleanHex);
  } catch {
    return null;
  }
  const len = buf.length;
  if (len < ABI_SELECTOR_BYTE_LENGTH) return null;

  type Cand = { offset: number; call: DecodedCall; outcome: 'success' | 'partial' };
  const cands: Cand[] = [];

  const offsets = swapCompactInnerDecodeOffsets(len);
  for (let oi = 0; oi < offsets.length; oi++) {
    throwIfDecodeAbortedEvery(options, oi);
    const offset = offsets[oi];
    const slice = buf.subarray(offset);
    if (slice.length < ABI_SELECTOR_BYTE_LENGTH) continue;
    if (slice[0] === 0 && slice[1] === 0 && slice[2] === 0 && slice[3] === 0) {
      continue;
    }

    const sliceHex = hexlify(slice);
    const result = await decodeCalldata(sliceHex, options, depth + 1, nextPatternNest);
    throwIfDecodeAborted(options);
    if (result.status === 'success' || result.status === 'partial') {
      cands.push({ offset, call: result.call, outcome: result.status });
    }
  }

  if (cands.length === 0) return null;

  const confRank = (c: DecodeConfidence): number =>
    c === 'exact' ? 0 : c === 'high' ? 1 : c === 'ambiguous' ? 2 : 3;

  cands.sort((a, b) => {
    const d = confRank(a.call.confidence) - confRank(b.call.confidence);
    if (d !== 0) return d;
    const pc = b.call.params.length - a.call.params.length;
    if (pc !== 0) return pc;
    const so =
      (a.outcome === 'success' ? 0 : 1) - (b.outcome === 'success' ? 0 : 1);
    if (so !== 0) return so;
    return a.offset - b.offset;
  });

  return cands[0].call;
}

async function convertValue(
  raw: unknown,
  type: string,
  calldataHints: CalldataIndex[],
  options: DecodeOptions,
  depth: number,
  outerPattern: MulticallPattern | undefined,
  patternNestingDepth: number,
): Promise<DecodedValue> {
  throwIfDecodeAborted(options);

  if (type === 'address' && typeof raw === 'string') {
    const fmt = formatAddress(raw, options.chainId);
    return {
      kind: 'address',
      address: raw,
      checksummed: fmt.checksummed,
      label: fmt.label,
    };
  }

  // Ethers returns real booleans for `bool`; `coerceAbiDecodedBool` avoids `Boolean("false") === true` and handles odd string/bigint forms.
  if (type === 'bool') {
    return {
      kind: 'primitive',
      display: formatBool(coerceAbiDecodedBool(raw)),
      raw: String(raw),
    };
  }

  // Fixed `T[k]` (any `T`): `uint256[5][5]`, `address[11]`, `bytes32[4]`, etc. `uint*`/`int*`/`bytes*`
  // must not hit scalar branches below; `bytes[k]` must not hit dynamic `bytes`.
  const fixedArrayEarly = parseFixedAbiArraySuffix(type);
  if (fixedArrayEarly && Array.isArray(raw)) {
    const innerType = fixedArrayEarly.baseType;
    const elements: DecodedValue[] = [];
    for (let fi = 0; fi < raw.length; fi++) {
      throwIfDecodeAbortedEvery(options, fi);
      const item = raw[fi];
      elements.push(
        await convertValue(item, innerType, calldataHints, options, depth, outerPattern, patternNestingDepth),
      );
      throwIfDecodeAborted(options);
    }
    return { kind: 'array', elementType: type, elements };
  }

  if (type.startsWith('uint') || type.startsWith('int')) {
    const str = String(raw);
    const fmt = formatUint256(str);
    return {
      kind: 'primitive',
      display: fmt.display,
      raw: str,
      interpretation: fmt.interpretation,
    };
  }

  if (type === 'string' && typeof raw === 'string') {
    return {
      kind: 'primitive',
      display: `"${sanitizeDecodedString(raw)}"`,
      raw,
    };
  }

  if (type === 'bytes32') {
    const asHex =
      typeof raw === 'string'
        ? raw
        : raw instanceof Uint8Array
          ? hexlify(raw)
          : undefined;
    if (asHex === undefined) {
      return { kind: 'primitive', display: String(raw), raw: String(raw) };
    }
    const fmt = formatBytes32(asHex);
    const embeddedCs = extractLeftPaddedAddressFromBytes32(asHex);
    const embeddedEvmAddress = embeddedCs ? { checksummed: embeddedCs } : undefined;
    const textNote = embeddedEvmAddress ? undefined : interpretBytes32AsLeftPaddedAddress(asHex);
    let interpretation = [fmt.asString, textNote].filter(Boolean).join(' · ') || undefined;
    if (!interpretation && !embeddedEvmAddress) {
      interpretation = 'Opaque 32-byte word';
    }
    return {
      kind: 'primitive',
      display: fmt.display,
      raw: asHex,
      interpretation,
      embeddedEvmAddress,
    };
  }

  // Dynamic `bytes`: ethers `AbiCoder.decode` usually yields hex `string`, but some paths return `Uint8Array`.
  if (type === 'bytes') {
    const cleanHex =
      typeof raw === 'string'
        ? normalizeHex(raw)
        : raw instanceof Uint8Array
          ? normalizeHex(hexlify(raw))
          : null;
    if (cleanHex !== null) {
      const nibbles = cleanHex.length - 2;
      const maxPayloadNibbles = MAX_INPUT_BYTES * HEX_NIBBLES_PER_BYTE;
      // Enforce hex length before odd-nibble early return so huge odd-length strings cannot bypass `MAX_INPUT_BYTES`.
      if (nibbles > maxPayloadNibbles) {
        pushDecodeWarning(options, {
          severity: 'warning',
          title: 'bytes parameter too large',
          context: `While decoding a \`bytes\` parameter (ABI type: ${type}). Decoder safety cap: ${MAX_INPUT_BYTES} bytes.`,
          message: `Hex payload exceeds maximum (${MAX_INPUT_BYTES} bytes when complete); nested decoding was skipped for this chunk.`,
        });
        const preview = truncateHexForErrorPreview(cleanHex);
        return { kind: 'bytes', hex: preview };
      }
      if (nibbles % 2 !== 0) {
        return { kind: 'bytes', hex: cleanHex };
      }

      const gnosisHint = calldataHints.find(h => h.kind === 'gnosis-multisend');
      if (gnosisHint?.kind === 'gnosis-multisend') {
        const maxOperations = gnosisHint.maxOperations ?? DEFAULT_MAX_MULTISEND_OPERATIONS;
        return convertGnosisMultiSend(cleanHex, options, depth, outerPattern, patternNestingDepth, maxOperations);
      }
      const directHint = calldataHints.some(h => h.kind === 'direct');
      const expandDirect = directHint && isDynamicBytesSolidityType(type);
      return convertBytesValue(cleanHex, expandDirect, options, depth, outerPattern, patternNestingDepth);
    }
  }

  if (type === 'bytes[]' && Array.isArray(raw)) {
    const isCalldata = calldataHints.some(h => h.kind === 'array-direct');
    const cap = effectiveArrayDirectCap(calldataHints);
    const total = raw.length;
    const limited = total > cap ? raw.slice(0, cap) : raw;
    if (total > cap) {
      pushDecodeWarning(options, {
        severity: 'warning',
        title: 'Large nested calldata array',
        context: `While decoding \`bytes[]\` treated as nested calldata (e.g. multicall batch). Showing first ${cap} of ${total} elements.`,
        message: `Remaining elements were not expanded to limit memory use.`,
      });
    }
    const elements: DecodedValue[] = [];
    for (let bi = 0; bi < limited.length; bi++) {
      throwIfDecodeAbortedEvery(options, bi);
      const item = limited[bi];
      const hex = typeof item === 'string' ? item : hexlify(getBytes(item as string));
      elements.push(
        await convertBytesValue(hex, isCalldata, options, depth, outerPattern, patternNestingDepth),
      );
      throwIfDecodeAborted(options);
    }
    return { kind: 'array', elementType: 'bytes', elements };
  }

  // Tuple arrays (e.g. (address,bytes)[]) must be checked BEFORE generic arrays
  // so that calldataHints propagate into the tuple fields
  if (type.startsWith('(') && type.endsWith(')[]') && Array.isArray(raw)) {
    const tupleType = type.slice(0, -2);
    const tupleHints = filterTupleFieldHintsByParent(type, calldataHints);
    const hasTupleFieldCalldata = tupleHints.some(h => h.kind === 'tuple-field');
    const cap = hasTupleFieldCalldata ? effectiveTupleArrayCap(tupleHints) : Number.POSITIVE_INFINITY;
    const total = raw.length;
    const limited = total > cap ? raw.slice(0, cap) : raw;
    if (hasTupleFieldCalldata && total > cap) {
      pushDecodeWarning(options, {
        severity: 'warning',
        title: 'Large batch call truncated',
        context: `While decoding \`tuple[]\` rows that contain inner \`bytes\` calldata (e.g. Multicall-style). Showing first ${cap} of ${total} rows.`,
        message: `Later rows were not expanded for nested decoding.`,
      });
    }
    const elements: DecodedValue[] = [];
    for (let ti = 0; ti < limited.length; ti++) {
      throwIfDecodeAbortedEvery(options, ti);
      const item = limited[ti];
      elements.push(
        await convertTupleValue(
          item,
          tupleType,
          tupleHints,
          options,
          depth,
          outerPattern,
          patternNestingDepth,
        ),
      );
      throwIfDecodeAborted(options);
    }
    return { kind: 'array', elementType: tupleType, elements };
  }

  if (type.endsWith('[]') && Array.isArray(raw)) {
    const elemType = type.slice(0, -2);
    const elements: DecodedValue[] = [];
    for (let ai = 0; ai < raw.length; ai++) {
      throwIfDecodeAbortedEvery(options, ai);
      const item = raw[ai];
      elements.push(
        await convertValue(item, elemType, [], options, depth, outerPattern, patternNestingDepth),
      );
      throwIfDecodeAborted(options);
    }
    return { kind: 'array', elementType: elemType, elements };
  }

  if (type.startsWith('(') && type.endsWith(')')) {
    const tupleHints = filterTupleFieldHintsByParent(type, calldataHints);
    return convertTupleValue(
      raw,
      type,
      tupleHints,
      options,
      depth,
      outerPattern,
      patternNestingDepth,
    );
  }

  return {
    kind: 'primitive',
    display: String(raw),
    raw: String(raw),
  };
}

/** Index of the first top-level `bytes` slot in an ABI tuple type string `(a,b,bytes,…)`. */
function firstTopLevelBytesFieldIndexInTupleType(tupleWithParens: string): number | undefined {
  const t = tupleWithParens.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return undefined;
  const parts = splitTupleTypes(t.slice(1, -1));
  for (let j = 0; j < parts.length; j++) {
    if (parts[j].replace(/\s/g, '') === 'bytes') return j;
  }
  return undefined;
}

/** Human-readable tuple field names for common shapes (multicall rows, etc.). */
function semanticTupleFieldNames(tupleType: string): string[] | undefined {
  const norm = tupleType.replace(/\s/g, '').toLowerCase();
  if (norm === '(address,bytes)') return ['target', 'callData'];
  if (norm === '(address,bool,bytes)') return ['target', 'allowFailure', 'callData'];
  if (norm === '(address,bool,uint256,bytes)')
    return ['target', 'allowFailure', 'value', 'callData'];
  return undefined;
}

async function convertTupleValue(
  raw: unknown,
  tupleType: string,
  calldataHints: CalldataIndex[],
  options: DecodeOptions,
  depth: number,
  outerPattern: MulticallPattern | undefined,
  patternNestingDepth: number,
): Promise<DecodedValue> {
  const innerTypes = splitTupleTypes(tupleType.slice(1, -1));
  const tuple = raw as readonly unknown[];
  const fields: DecodedParam[] = [];
  const fieldNames = semanticTupleFieldNames(tupleType);

  for (let i = 0; i < innerTypes.length; i++) {
    throwIfDecodeAbortedEvery(options, i);
    const fieldType = innerTypes[i];
    const fieldRaw = tuple[i];

    const fieldHints: CalldataIndex[] = [];
    for (const hint of calldataHints) {
      if (hint.kind !== 'tuple-field' || hint.fieldIndex !== i) continue;

      if (hint.expectedFieldType === 'bytes') {
        const ftNorm = fieldType.replace(/\s/g, '');
        if (ftNorm === 'bytes') {
          fieldHints.push({ kind: 'direct', paramIndex: 0 });
        } else if (isArrayOfTuplesType(ftNorm)) {
          const innerTuple = fieldType.trim().slice(0, -2).trim();
          const bytesIdx = firstTopLevelBytesFieldIndexInTupleType(innerTuple);
          if (bytesIdx === undefined) continue;
          fieldHints.push({
            kind: 'tuple-field',
            paramIndex: 0,
            fieldIndex: bytesIdx,
            expectedParentType: 'tuple[]',
            expectedFieldType: 'bytes',
          });
        } else if (isNonArrayTupleParamType(ftNorm)) {
          // Pendle `swapTokensToTokens` rows often use one `(uint8,address,bytes,bool)` step — not `(…)[]`. A bare
          // `direct` hint on the tuple is ignored (only `bytes` params expand); drill to the embedded `bytes` slot.
          const bytesIdx = firstTopLevelBytesFieldIndexInTupleType(ftNorm);
          if (bytesIdx === undefined) continue;
          fieldHints.push({
            kind: 'tuple-field',
            paramIndex: 0,
            fieldIndex: bytesIdx,
            expectedParentType: 'tuple',
            expectedFieldType: 'bytes',
          });
        } else if (!isDynamicBytesSolidityType(fieldType)) {
          continue;
        } else {
          fieldHints.push({ kind: 'direct', paramIndex: 0 });
        }
      } else {
        fieldHints.push({ kind: 'direct', paramIndex: 0 });
      }
    }

    const value = await convertValue(
      fieldRaw,
      fieldType,
      fieldHints,
      options,
      depth,
      outerPattern,
      patternNestingDepth,
    );
    throwIfDecodeAborted(options);

    fields.push({
      name: fieldNames?.[i] ?? `field${i}`,
      type: fieldType,
      value,
      rawHex: toRawHex(fieldRaw),
    });
  }

  return { kind: 'tuple', fields };
}

async function convertBytesValue(
  hex: string,
  isKnownCalldata: boolean,
  options: DecodeOptions,
  depth: number,
  outerPattern: MulticallPattern | undefined,
  patternNestingDepth: number,
): Promise<DecodedValue> {
  const cleanHex = normalizeHex(hex);
  const byteLen = (cleanHex.length - 2) / 2;

  if (byteLen > MAX_INPUT_BYTES) {
    pushDecodeWarning(options, {
      severity: 'warning',
      title: 'bytes payload too large',
      context: `While expanding nested calldata inside a parent \`bytes\` value (nested decode depth ${depth}). Limit: ${MAX_INPUT_BYTES} bytes.`,
      message: `This inner payload is ${byteLen} bytes; automatic expansion was skipped.`,
    });
    return { kind: 'bytes', hex: cleanHex };
  }

  if (byteLen < ABI_SELECTOR_BYTE_LENGTH) {
    return {
      kind: 'bytes',
      hex: cleanHex,
    };
  }

  const globalNestCap = options.multicallNestLimit ?? DEFAULT_MULTICALL_PATTERN_NEST_LIMIT;
  const nestLimit = Math.min(
    options.maxDepth,
    globalNestCap,
    outerPattern?.maxRecursionDepth ?? Number.POSITIVE_INFINITY,
  );

  const childSel = extractSelector(cleanHex);

  if (
    isKnownCalldata &&
    outerPattern?.selector === ENSO_EXECUTE_SHORTCUT_SELECTOR &&
    byteLen > ABI_WORD_BYTE_LENGTH
  ) {
    const enso = await tryExpandEnsoShortcutCommandBytes(
      cleanHex,
      options,
      depth,
      outerPattern,
      patternNestingDepth,
    );
    if (enso) return enso;
  }

  if (isKnownCalldata) {
    if (patternNestingDepth >= nestLimit) {
      return { kind: 'bytes', hex: cleanHex };
    }
    if (
      outerPattern?.allowRecursive === false &&
      childSel &&
      isKnownMulticallSelector(childSel)
    ) {
      return { kind: 'bytes', hex: cleanHex };
    }
  }

  const nextPatternNest = isKnownCalldata ? patternNestingDepth + 1 : patternNestingDepth;

  // Opaque dynamic `bytes` (not pattern-marked calldata): only probe nested `decodeCalldata` when there is **more**
  // than a bare 4-byte word. Selector-only blobs often match random noise or zero-arg DB entries → false positives;
  // known-multicall `bytes` still attempts decode at exactly 4 bytes (e.g. truncated segments).
  if (isKnownCalldata || byteLen > ABI_SELECTOR_BYTE_LENGTH) {
    throwIfDecodeAborted(options);

    if (
      isKnownCalldata &&
      outerPattern?.selector.toLowerCase() === SWAP_COMPACT_SELECTOR
    ) {
      const bestPacked = await pickBestSwapCompactInnerCalldata(
        cleanHex,
        options,
        depth,
        nextPatternNest,
      );
      throwIfDecodeAborted(options);
      if (bestPacked) {
        return {
          kind: 'bytes',
          hex: cleanHex,
          decoded: bestPacked,
        };
      }
      // `pickBestSwapCompactInnerCalldata` already attempted a full-buffer decode at offset 0 when allowed.
      return { kind: 'bytes', hex: cleanHex };
    }

    const result = await decodeCalldata(cleanHex, options, depth + 1, nextPatternNest);
    throwIfDecodeAborted(options);
    if (result.status === 'success' || result.status === 'partial') {
      return {
        kind: 'bytes',
        hex: cleanHex,
        decoded: result.call,
      };
    }
  }

  return {
    kind: 'bytes',
    hex: cleanHex,
  };
}

/** Gnosis Safe `multiSend` per-op byte: CALL, DELEGATECALL, CREATE (see Safe docs). */
const GNOSIS_MULTISEND_OP_LABELS: Record<number, string> = {
  0: 'CALL',
  1: 'DELEGATECALL',
  2: 'CREATE',
};

/**
 * Decode Gnosis Safe `multiSend(bytes)` payload: packed sequence of sub-transactions (not standard ABI tuple layout).
 *
 * **Packed layout per operation** (hex nibbles = half-bytes; each row is contiguous in the `bytes` payload):
 * | Segment     | Size   | Notes |
 * |------------|--------|--------|
 * | `operation`| {@link GNOSIS_MULTISEND_OPERATION_BYTE_LENGTH} byte | `0x00` = CALL, `0x01` = DELEGATECALL, `0x02` = CREATE |
 * | `to`       | 20 bytes (`ABI_ADDRESS_BYTE_LENGTH`) | callee address |
 * | `value`    | 32 bytes (`ABI_WORD_BYTE_LENGTH`) | big-endian uint256 (wei) |
 * | `dataLength` | 32 bytes | big-endian uint256, length of following `data` |
 * | `data`     | `dataLength` bytes | inner calldata |
 *
 * If `dataLength` claims more bytes than remain, parsing stops without throwing. Off-by-one or wrong `dataLength`
 * values cause misalignment for **subsequent** operations; the decoder only consumes what the length field allows
 * within the buffer, then continues from the next offset (which may be garbage if the payload was malformed).
 */
async function convertGnosisMultiSend(
  hex: string,
  options: DecodeOptions,
  depth: number,
  outerPattern: MulticallPattern | undefined,
  patternNestingDepth: number,
  maxOperations: number,
): Promise<DecodedValue> {
  const elements: DecodedValue[] = [];
  let bytes: Uint8Array;
  try {
    bytes = getBytes(normalizeHex(hex));
  } catch {
    return { kind: 'array', elementType: '(uint8,address,uint256,bytes)', elements };
  }

  let offset = 0;

  while (offset < bytes.length) {
    throwIfDecodeAbortedEvery(options, elements.length);
    if (elements.length >= maxOperations) {
      if (offset < bytes.length) {
        pushDecodeWarning(options, {
          severity: 'warning',
          title: 'multiSend payload truncated',
          context: `While parsing Gnosis Safe \`multiSend(bytes)\` packed operations. Limit: ${maxOperations} operations per decode.`,
          message: `Remaining packed bytes were not decoded.`,
        });
      }
      break;
    }
    if (offset + GNOSIS_MULTISEND_OPERATION_BYTE_LENGTH > bytes.length) break;
    const _operation = bytes[offset];
    offset += GNOSIS_MULTISEND_OPERATION_BYTE_LENGTH;

    if (offset + ABI_ADDRESS_BYTE_LENGTH > bytes.length) break;
    const to = hexlify(bytes.subarray(offset, offset + ABI_ADDRESS_BYTE_LENGTH));
    offset += ABI_ADDRESS_BYTE_LENGTH;

    if (offset + ABI_WORD_BYTE_LENGTH > bytes.length) break;
    const value = BigInt(hexlify(bytes.subarray(offset, offset + ABI_WORD_BYTE_LENGTH)));
    offset += ABI_WORD_BYTE_LENGTH;

    if (offset + ABI_WORD_BYTE_LENGTH > bytes.length) break;
    const dataLenBn = BigInt(hexlify(bytes.subarray(offset, offset + ABI_WORD_BYTE_LENGTH)));
    offset += ABI_WORD_BYTE_LENGTH;
    // Compare as BigInt before `Number(dataLenBn)`: decoder cap first, then JS safe-integer (MAX_INPUT_BYTES ≪ 2^53 today).
    if (dataLenBn > BigInt(MAX_INPUT_BYTES)) break;
    if (dataLenBn > BigInt(Number.MAX_SAFE_INTEGER)) break;
    const dataLen = Number(dataLenBn);

    if (offset + dataLen > bytes.length) break;
    const calldata = hexlify(bytes.subarray(offset, offset + dataLen));
    offset += dataLen;

    const nestLimit = Math.min(
      options.maxDepth,
      options.multicallNestLimit ?? DEFAULT_MULTICALL_PATTERN_NEST_LIMIT,
      outerPattern?.maxRecursionDepth ?? Number.POSITIVE_INFINITY,
    );
    const childSel = dataLen >= ABI_SELECTOR_BYTE_LENGTH ? extractSelector(calldata) : null;
    const mayExpandPatternCalldata =
      dataLen >= ABI_SELECTOR_BYTE_LENGTH &&
      patternNestingDepth < nestLimit &&
      !(
        outerPattern?.allowRecursive === false &&
        childSel &&
        isKnownMulticallSelector(childSel)
      );

    const calldataDecoded =
      mayExpandPatternCalldata
        ? await decodeCalldata(calldata, options, depth + 1, patternNestingDepth + 1)
        : null;
    throwIfDecodeAborted(options);

    const calldataValue: DecodedValue = calldataDecoded && (calldataDecoded.status === 'success' || calldataDecoded.status === 'partial')
      ? { kind: 'bytes', hex: calldata, decoded: calldataDecoded.call }
      : { kind: 'bytes', hex: calldata };

    const addrFmt = formatAddress(to, options.chainId);

    const multisendOpDisplay = GNOSIS_MULTISEND_OP_LABELS[_operation] ?? `UNKNOWN(${_operation})`;

    elements.push({
      kind: 'tuple',
      fields: [
        { name: 'operation', type: 'uint8', value: { kind: 'primitive', display: multisendOpDisplay, raw: String(_operation) } },
        { name: 'to', type: 'address', value: { kind: 'address', address: to, checksummed: addrFmt.checksummed, label: addrFmt.label } },
        { name: 'value', type: 'uint256', value: { kind: 'primitive', display: value.toString(), raw: value.toString(), interpretation: value > 0n ? `${value} wei` : undefined } },
        { name: 'data', type: 'bytes', value: calldataValue },
      ],
    });
  }

  return { kind: 'array', elementType: '(uint8,address,uint256,bytes)', elements };
}

/** Dynamic array of tuples: `(a,b)[]` (not fixed `(a,b)[3]` — handled before reaching tuple-array branch). */
function isArrayOfTuplesType(t: string): boolean {
  return t.startsWith('(') && /\)\[\]$/.test(t);
}

/** Single top-level tuple parameter (e.g. forwarder `execute((...))`), not `(…)[]`. */
function isNonArrayTupleParamType(t: string): boolean {
  return t.startsWith('(') && t.endsWith(')') && !/\)\[\]$/.test(t);
}

function filterTupleFieldHintsByParent(parentSolidityType: string, hints: CalldataIndex[]): CalldataIndex[] {
  return hints.filter(h => {
    if (h.kind !== 'tuple-field') return true;
    if (h.expectedParentType === 'tuple[]') return isArrayOfTuplesType(parentSolidityType);
    if (h.expectedParentType === 'tuple') return isNonArrayTupleParamType(parentSolidityType);
    return true;
  });
}

/**
 * True if the ABI type is dynamic `bytes` or a (possibly nested) tuple that contains dynamic `bytes` in any slot.
 * Handles `tuple(a,b)` and anonymous `(a,b)` forms used by ethers.
 */
export function isDynamicBytesSolidityType(fieldType: string): boolean {
  const t = fieldType.trim();
  if (t === 'bytes') return true;
  /** Dynamic array of tuples: recurse on the tuple shape (e.g. `(uint8,address,bytes,bool)[]`). */
  if (t.startsWith('(') && /\)\[\]$/.test(t)) {
    return isDynamicBytesSolidityType(t.slice(0, -2));
  }
  if (t.startsWith('tuple(') && t.endsWith(')')) {
    const inner = t.slice(6, -1);
    return splitTupleTypes(inner).some(part => isDynamicBytesSolidityType(part.trim()));
  }
  if (t.startsWith('(') && t.endsWith(')')) {
    const inner = t.slice(1, -1);
    return splitTupleTypes(inner).some(part => isDynamicBytesSolidityType(part.trim()));
  }
  return false;
}

/**
 * If the whole string is one balanced `(...)` group, return the inner slice; otherwise return `s` unchanged.
 * Used so callers who forget to strip the outermost tuple parens still split correctly.
 */
function stripMatchingOuterTupleParens(s: string): string {
  const t = s.trim();
  if (t.length < 2 || t[0] !== '(' || t[t.length - 1] !== ')') return t;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) return t;
      if (depth === 0 && i !== t.length - 1) return t;
    }
  }
  if (depth !== 0) return t;
  return t.slice(1, -1);
}

/**
 * Split **one** ABI tuple layer on commas.
 *
 * **Outer parentheses:** A fully wrapped `(…)` envelope is stripped repeatedly (e.g. `((uint256,bytes))` → inner)
 * so a mistaken extra wrap still splits correctly. Types like `(uint256),(bytes)` are unchanged (first `)` closes
 * before the string ends).
 *
 * **Empty components:** Commas at top level produce empty strings (e.g. `uint256,,bytes` → three slots). Solidity
 * forbids empty type names; this preserves arity for malformed or tooling-generated strings.
 *
 * **Whitespace:** Each component is `.trim()`’d; internal spaces inside a type token are preserved (invalid in Solidity).
 *
 * **State machine:** `parenDepth` and `bracketDepth` are tracked **independently** (parentheses nest tuples;
 * brackets nest array suffixes).
 *
 * @example Inner of `(string,(address,bytes)[])` is `string,(address,bytes)[]` →
 *   `["string", "(address,bytes)[]"]` (comma after `string` is at depth 0; comma inside `(address,bytes)` is not).
 */
export function splitTupleTypes(inner: string): string[] {
  let working = inner.trim();
  if (working === '') return [];

  for (let guard = 0; guard < 64; guard++) {
    const next = stripMatchingOuterTupleParens(working).trim();
    if (next === working) break;
    working = next;
    if (working === '') return [];
  }

  const trimmed = working;
  const result: string[] = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === '(') {
      parenDepth++;
      current += char;
    } else if (char === ')') {
      parenDepth--;
      current += char;
    } else if (char === '[') {
      bracketDepth++;
      current += char;
    } else if (char === ']') {
      bracketDepth--;
      current += char;
    } else if (char === ',' && parenDepth === 0 && bracketDepth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

/** @throws {RangeError} When `val` is a string with non-hexadecimal characters (see {@link normalizeHex}). */
export function toRawHex(val: unknown): string {
  if (val instanceof Uint8Array) {
    return hexlify(val);
  }
  if (typeof val === 'string') {
    return normalizeHex(val);
  }
  if (typeof val === 'bigint') {
    return `0x${val.toString(16)}`;
  }
  if (typeof val === 'boolean') {
    return val ? '0x01' : '0x00';
  }
  if (typeof val === 'number') {
    return `0x${val.toString(16)}`;
  }
  return String(val);
}

/**
 * Decode calldata with a user JSON ABI. Reuses the same `Interface` LRU as `lookupSelectorFromUserAbi` (keyed by ABI
 * content) unless {@link DecodeWithUserAbiOptions.iface} is supplied for hot-loop use.
 */
export interface DecodeWithUserAbiOptions {
  /** When set, skips JSON parse and shared cache (caller owns lifecycle). */
  iface?: Interface;
}

export function decodeWithUserAbi(
  calldata: string,
  abiJson: string,
  options?: DecodeWithUserAbiOptions,
): DecodedCalldataOutcome {
  let calldataHex: string;
  try {
    calldataHex = normalizeHex(calldata);
  } catch {
    return {
      status: 'error',
      error: 'Invalid hexadecimal in calldata',
      rawHex: truncateHexForErrorPreview(calldata),
    };
  }

  try {
    const iface =
      options?.iface ??
      (abiJson.length > MAX_USER_ABI_JSON_CHARS
        ? null
        : getCachedUserAbiInterface(abiJson));
    if (!iface) {
      const msg =
        abiJson.length > MAX_USER_ABI_JSON_CHARS
          ? `User ABI JSON exceeds maximum length (${MAX_USER_ABI_JSON_CHARS} characters)`
          : 'Invalid user ABI JSON or could not build contract interface';
      return { status: 'error', error: msg, rawHex: truncateHexForErrorPreview(calldataHex) };
    }

    const tx = iface.parseTransaction({ data: calldataHex });

    if (!tx) {
      const sel = extractSelector(calldataHex);
      return {
        status: 'error',
        error: sel ? `No matching function in ABI for selector ${sel}` : 'No matching function in ABI',
        rawHex: truncateHexForErrorPreview(calldataHex),
        selector: sel ?? undefined,
      };
    }

    const params: DecodedParam[] = tx.fragment.inputs.map((input, i) => ({
      name: input.name || `arg${i}`,
      type: input.type,
      value: { kind: 'primitive' as const, display: String(tx.args[i]), raw: String(tx.args[i]) },
    }));

    return {
      status: 'success',
      call: {
        selector: calldataHex.slice(0, SELECTOR_HEX_PREFIX_LENGTH),
        signature: {
          selector: calldataHex.slice(0, SELECTOR_HEX_PREFIX_LENGTH) as HexSelector,
          name: tx.name,
          textSignature: tx.fragment.format('sighash'),
          params: tx.fragment.inputs.map((i, idx) => ({
            name: i.name || `arg${idx}`,
            type: i.type,
          })),
          source: 'user-abi',
        },
        params,
        confidence: 'exact',
        alternatives: [],
        depth: 0,
        rawCalldata: calldataHex,
      },
    };
  } catch (e) {
    return {
      status: 'error',
      error: `ABI decode error: ${e instanceof Error ? e.message : String(e)}`,
      rawHex: truncateHexForErrorPreview(calldataHex),
    };
  }
}
