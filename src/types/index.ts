import type { TokenInfo } from '../lib/abiRegistry.ts';

export type SignatureSource = 'bundled' | 'sourcify' | 'openchain' | '4byte' | 'user-abi';

/**
 * Function selector: `0x` plus four bytes of hex (10 characters total).
 * The template only enforces the `0x` prefix; length and hex shape are validated when parsing calldata (not at the type level).
 */
export type HexSelector = `0x${string}`;

/** One ABI parameter slot in a resolved signature (name + Solidity type). */
export interface SignatureParam {
  name: string;
  /** Canonical Solidity type; tuples use the `(a,b)` / `(a,b)[]` form, never ethers' `tuple(...)`. */
  type: string;
  /** Field names for tuple (or tuple-array) types, when the ABI provides them. */
  components?: SignatureParam[];
}

export interface FunctionSignature {
  selector: HexSelector;
  name: string;
  textSignature: string;
  /** Single source of truth for parameter order, types, and names. */
  params: SignatureParam[];
  source: SignatureSource;
  /**
   * Higher values break ties when multiple signatures share the same selector and all decode.
   * API lookups get a descending default by result order when unset.
   */
  popularity?: number;
  /** When true, ranked below non-deprecated candidates with similar scores. */
  deprecated?: boolean;
}

export interface DecodedParam {
  name: string;
  type: string;
  value: DecodedValue;
  rawHex?: string;
  /** Short explanation for known ABI shapes (shown in the tree under the param name). */
  fieldHint?: string;
}

/** When a `bytes32` (or similar) decodes to a left-padded EVM address, the UI can link + resolve ENS like `address`. */
export type EmbeddedEvmAddress = { checksummed: string; ensName?: string };

/**
 * Left-padded address at a 32-byte ABI word inside dynamic `bytes` (opaque strategy data, Enso command cells, etc.).
 * Filled post-decode so explorers / registry labels appear even when the blob is not fully ABI-decoded.
 */
export interface WordAlignedAddressHit {
  /** Zero-based index of the 32-byte word in the payload. */
  wordIndex: number;
  checksummed: string;
  label?: string;
  ensName?: string;
}

/** Token unit attached to an amount by the decoder (structured, so warnings never parse display text). */
export interface TokenAmountContext {
  symbol: string;
  decimals: number;
  /** Symbol/decimals were read from the token contract itself (attacker-controlled), not the curated registry. */
  unverified?: boolean;
  /** The unit was inferred from another address in the call, not from a known parameter layout. */
  guessed?: boolean;
}

export type DecodedValue =
  | {
      kind: 'primitive';
      display: string;
      raw: string;
      interpretation?: string;
      embeddedEvmAddress?: EmbeddedEvmAddress;
      tokenAmount?: TokenAmountContext;
    }
  | { kind: 'address'; address: string; checksummed: string; label?: string; ensName?: string }
  | {
      kind: 'bytes';
      hex: string;
      decoded?: DecodedCall;
      /** After decode enrichment: 32-byte word scan (may be `[]`); omitted until enrichment runs. */
      wordAlignedAddresses?: WordAlignedAddressHit[];
    }
  | { kind: 'array'; elementType: string; elements: DecodedValue[] }
  | { kind: 'tuple'; fields: DecodedParam[] };

export type DecodeConfidence = 'exact' | 'high' | 'ambiguous' | 'failed';

export interface DecodedCall {
  selector: string;
  signature: FunctionSignature;
  params: DecodedParam[];
  confidence: DecodeConfidence;
  alternatives: FunctionSignature[];
  depth: number;
  rawCalldata: string;
  /**
   * Bytes after the ABI-encoded arguments. The ABI decoder ignores them (so does Solidity), but contracts can still
   * read them via `msg.data` — ERC-2771 forwarders append the sender there, hostile contracts can hide data there.
   */
  unparsedTrailingHex?: string;
  /**
   * Arguments decoded but do not re-encode to the same bytes: out-of-range small ints / bools (shown masked by the
   * decoder, rejected by Solidity's ABI v2 decoder) or unusual dynamic offsets.
   */
  nonCanonicalEncoding?: boolean;
  /**
   * Found by probing opaque bytes (an unhinted `bytes` param, or an offset scan in a packed payload) rather than a
   * known calldata layout. It may be a coincidental match.
   */
  speculative?: boolean;
}

export type WarningSeverity = 'info' | 'warning' | 'danger';

export interface TxWarning {
  severity: WarningSeverity;
  title: string;
  message: string;
  /** Where/why this alert applies (call frame, tx field, decoder limit). Shown under the title in the UI. */
  context?: string;
}

export type DecodeResult =
  | { status: 'success'; call: DecodedCall; warnings?: TxWarning[] }
  | { status: 'partial'; call: DecodedCall; errors: string[]; warnings?: TxWarning[] }
  | { status: 'error'; error: string; rawHex: string; selector?: string }
  | {
      status: 'native_transfer';
      message: string;
      hash: string;
      from: string;
      to: string | null;
      value: string;
      isPending: boolean;
      warnings?: TxWarning[];
    };

/** Decoder output only (`native_transfer` is set by the app after a tx-hash fetch, not by `decodeCalldata`). */
export type DecodedCalldataOutcome = Exclude<DecodeResult, { status: 'native_transfer' }>;

export interface DecodeOptions {
  maxDepth: number;
  /**
   * Max nested calldata expansions along known multicall / batch patterns (distinct from `maxDepth`,
   * which still bounds every `decodeCalldata` frame including generic `bytes` decoding).
   */
  multicallNestLimit?: number;
  offlineMode: boolean;
  userAbi?: string;
  /** Chain for address/token registry lookups (labels, decimals). */
  chainId: number;
  /**
   * Contract address this calldata is executed against (e.g. transaction `to`). Used for patterns where the
   * token is implicit—LayerZero V2 OFT `send` amounts refer to the OFT at `to`, not an in-calldata address.
   * Cleared automatically for nested `decodeCalldata` frames so inner calls are not mis-labeled.
   */
  callTarget?: string;
  /**
   * When true (default), token amounts for addresses not in the static registry call `decimals()` via chain RPCs.
   * Ignored when `offlineMode` is true.
   */
  fetchTokenDecimalsOnChain?: boolean;
  /**
   * When true (default), resolved addresses get a primary **ENS** name (reverse lookup on Ethereum mainnet).
   * Ignored when `offlineMode` is true.
   */
  resolveEns?: boolean;
  /**
   * Optional hook when signature API lookup fails (HTTP, JSON, or response shape).
   * `source` is `'sourcify'`, `'openchain'`, or `'4byte'`.
   */
  onSignatureLookupError?: (source: string, error: unknown) => void;
  /**
   * When user ABI is used, called if the pasted selector was normalized (trim / lowercase).
   */
  onUserAbiNonCanonicalSelector?: (requested: string, normalized: string) => void;
  /**
   * When set, the decoder appends {@link TxWarning} entries here (e.g. truncated large `bytes[]` / batch arrays).
   * The UI should merge with heuristic warnings from {@link analyzeWarnings}.
   */
  decodeWarningSink?: TxWarning[];
  /**
   * @internal Dedupes `decimals()` RPC calls across a single top-level decode (created at depth 0 when omitted).
   * Key: normalized chain id string + `:` + lowercased address; invalid `chainId` values use `__chain__` so keys never
   * collide with `"undefined:0x…"`.
   */
  tokenLookupSessionCache?: Map<string, Promise<TokenInfo | undefined>>;
  /**
   * @internal Remaining third-party signature lookups for this top-level decode (created at depth 0). Every unknown
   * selector costs up to three requests to public APIs from the viewer's browser, and packed-payload scans probe many
   * offsets, so the total is capped.
   */
  remoteLookupBudget?: { remaining: number; exhaustedWarned: boolean };
  /**
   * @internal Resolve selectors from bundled signatures and cache only. Set for speculative offset scans, where most
   * probed "selectors" are random bytes and would otherwise each become a public API request.
   */
  bundledOnlySignatureLookup?: boolean;
  /**
   * Cooperative cancellation: `decodeCalldata` checks `signal.aborted` after `await`s and on a throttled schedule
   * in long indexed loops (see `ABORT_CHECK_INTERVAL` in `decoder.ts`)—not on every scalar step. For on-chain token
   * metadata, `fetchOnChainTokenDecimals` races `decimals()` / `symbol()` against the signal so new work stops when
   * aborted; an in-flight JSON-RPC request may still complete until its own timeout. The signal is **not** forwarded
   * into `lookupSelector` HTTP `fetch` today.
   */
  signal?: AbortSignal;
}

export const DEFAULT_DECODE_OPTIONS: Omit<DecodeOptions, 'chainId'> = {
  maxDepth: 10,
  multicallNestLimit: 5,
  offlineMode: false,
  fetchTokenDecimalsOnChain: true,
  resolveEns: true,
};
