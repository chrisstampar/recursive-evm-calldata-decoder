import { getAddress } from 'ethers';
import { LRUCache } from 'lru-cache';
import type { WordAlignedAddressHit } from '../types/index.ts';
import { getContractName } from './abiRegistry.ts';
import { getExplorerUrl, DEFAULT_CHAIN_ID } from './chains.ts';
import { sanitizeDecodedString } from './sanitize.ts';
import { appendStableUsdPegClause } from './stablecoinUsd.ts';

const MAX_TOKEN_SYMBOL_DISPLAY_CHARS = 32;

/** Upper bound for the “Unix seconds” heuristic: 2³¹−1 (~2038). Larger 10-digit values are often raw token amounts (e.g. ~5e9 wei of a 6-decimal stable). */
const MAX_UNIX_SECONDS_TIMESTAMP_HEURISTIC = 2_147_483_647n;

/**
 * Reject token / USD-peg display when the integer part (raw / 10^decimals) has an absurd digit count — usually a
 * mis-tagged slot (deadline, sqrt price X96, flags) or wrong decimals, not a real balance.
 */
const MAX_PLAUSIBLE_TOKEN_WHOLE_DECIMAL_DIGITS = 18;

export function tokenAmountWholePartExceedsPlausibleDisplay(raw: string, decimals: number): boolean {
  const value = tryParseBigInt(raw);
  if (value === null) return false;
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 255) return false;
  let whole: bigint;
  try {
    whole = value / 10n ** BigInt(decimals);
  } catch {
    return true;
  }
  if (whole === 0n) return false;
  return whole.toString().length > MAX_PLAUSIBLE_TOKEN_WHOLE_DECIMAL_DIGITS;
}

/** Plain integer formatting (no thousands separators). */
const INTEGER_DISPLAY_FORMAT = new Intl.NumberFormat('en-US', {
  useGrouping: false,
  maximumFractionDigits: 0,
});

/**
 * Parse a decimal or `0x`-prefixed hex integer string. Returns null if empty, whitespace-only, or not a valid integer
 * literal for `BigInt` (e.g. fractional `"1.5"`, garbage `"abc"`).
 *
 * Note: `BigInt("")` is `0n` in some engines; we treat empty / whitespace as null to avoid misleading zeros.
 */
export function tryParseBigInt(raw: string): bigint | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

export function formatAddress(raw: string, chainId: number = DEFAULT_CHAIN_ID): {
  checksummed: string;
  label: string | undefined;
  explorerUrl: string;
} {
  let checksummed: string;
  try {
    checksummed = getAddress(raw);
  } catch {
    checksummed = raw;
  }

  const label = getContractName(raw, chainId);

  return {
    checksummed,
    label,
    explorerUrl: `${getExplorerUrl(chainId)}/address/${checksummed}`,
  };
}

/**
 * Formats a decoded integer string (typically `uint256` / `int256` calldata) for display.
 *
 * - **`raw`**: decimal integer string, or hex integer string with `0x` prefix (same rules as {@link tryParseBigInt}).
 * - **Heuristics**: `type(uint256).max` → unlimited-approval copy; 10-digit values in
 *   [1e9, 2³¹−1] (fits signed 32-bit time_t) → optional timestamp interpretation. Values above that are usually not
 *   on-chain deadlines. Token-style amounts use {@link formatTokenAmount} when decimals/symbol are known.
 *
 * @returns `display` (grouped with en-US separators) and optional `interpretation` text.
 * @throws Never — unparsable input is echoed in `display` with no interpretation.
 */
export function formatUint256(raw: string): {
  display: string;
  interpretation: string | undefined;
} {
  const value = tryParseBigInt(raw);
  if (value === null) {
    return { display: raw, interpretation: undefined };
  }

  const MAX_UINT256 = (1n << 256n) - 1n;
  if (value === MAX_UINT256) {
    return {
      display: 'type(uint256).max',
      interpretation: 'Maximum uint256 (unlimited approval)',
    };
  }

  const str = value.toString();
  // Only treat as Unix seconds when the decimal form is exactly 10 digits and the value fits 32-bit time_t.
  // Avoids labeling 10-digit token raw amounts (often ~5e9 for 6-decimal stables) as years 2128+.
  if (
    value >= 1_000_000_000n &&
    value <= MAX_UNIX_SECONDS_TIMESTAMP_HEURISTIC &&
    str.length === 10
  ) {
    const date = new Date(Number(value) * 1000);
    return {
      display: formatBigIntPlain(value),
      interpretation: `Timestamp: ${date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`,
    };
  }

  return {
    display: formatBigIntPlain(value),
    interpretation: undefined,
  };
}

/**
 * Safe wrapper for {@link formatUint256}: returns `null` if `raw` is not a string; on unexpected errors returns
 * `{ display, error }` instead of throwing. Valid strings always yield `{ display, interpretation? }`.
 */
export function tryFormatUint256(raw: unknown): {
  display: string;
  interpretation?: string;
  error?: string;
} | null {
  if (typeof raw !== 'string') return null;
  try {
    const { display, interpretation } = formatUint256(raw);
    return interpretation === undefined ? { display } : { display, interpretation };
  } catch (err) {
    return {
      display: raw,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function sanitizeTokenSymbol(symbol: string): string {
  const cleaned = sanitizeDecodedString(symbol.trim(), MAX_TOKEN_SYMBOL_DISPLAY_CHARS);
  return cleaned.length > 0 ? cleaned : 'TOKEN';
}

/**
 * Human-readable token amount. `symbol` is trimmed, control characters removed, and capped for safe UI text; if nothing
 * remains, the label **`TOKEN`** is used.
 */
export function formatTokenAmount(raw: string, decimals: number, symbol: string): {
  display: string;
  interpretation: string;
} {
  const sym = sanitizeTokenSymbol(symbol);
  const value = tryParseBigInt(raw);
  if (value === null) {
    return {
      display: raw,
      interpretation: `Unparseable amount (${sym})`,
    };
  }

  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 1_000) {
    return {
      display: formatBigIntPlain(value),
      interpretation: `Amount in ${sym} (invalid decimals metadata)`,
    };
  }

  const MAX_UINT256 = (1n << 256n) - 1n;
  if (value === MAX_UINT256) {
    return {
      display: 'type(uint256).max',
      interpretation: `Unlimited ${sym} approval`,
    };
  }

  const str = value.toString();
  const formatted = formatBigIntPlain(value);

  if (tokenAmountWholePartExceedsPlausibleDisplay(raw, decimals)) {
    return {
      display: formatted,
      interpretation: `Unlikely ${sym} amount (scale too large — wrong field, decimals, or non-token uint); no USD peg`,
    };
  }

  if (decimals === 0) {
    const interpretation = `${formatIntegerDecimalStringPlain(str)} ${sym}`;
    return {
      display: formatted,
      interpretation: appendStableUsdPegClause(interpretation, raw, decimals, sym),
    };
  }

  if (str.length > decimals) {
    const wholePart = str.slice(0, str.length - decimals);
    const fracPart = str.slice(str.length - decimals);
    const trimmedFrac = fracPart.slice(0, Math.min(6, decimals)).replace(/0+$/, '');
    const readable = trimmedFrac
      ? `${formatIntegerDecimalStringPlain(wholePart)}.${trimmedFrac}`
      : formatIntegerDecimalStringPlain(wholePart);
    const interpretation = `${readable} ${sym}`;
    return {
      display: formatted,
      interpretation: appendStableUsdPegClause(interpretation, raw, decimals, sym),
    };
  }

  const padded = str.padStart(decimals, '0');
  const trimmedFrac = padded.slice(0, Math.min(6, decimals)).replace(/0+$/, '') || '0';
  const interpretation = `0.${trimmedFrac} ${sym}`;
  return {
    display: formatted,
    interpretation: appendStableUsdPegClause(interpretation, raw, decimals, sym),
  };
}

/** `0x` + 64 hex nibbles = canonical ABI-encoded bytes32 string length. */
const BYTES32_HEX_STRING_MAX_LEN = 66;

/**
 * Twelve leading zero bytes + 20-byte address inside a `bytes32` (Across SpokePool V2, some bridges).
 * Returns checksummed `0x…` or `undefined` if the pattern does not match.
 */
export function extractLeftPaddedAddressFromBytes32(hex: string): string | undefined {
  const raw = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return undefined;
  if (raw.slice(0, 24) !== '0'.repeat(24)) return undefined;
  try {
    return getAddress(`0x${raw.slice(24)}`);
  } catch {
    return undefined;
  }
}

/** Cap per `bytes` node so huge payloads stay bounded (each hit is one `getAddress` + registry lookup). */
const MAX_WORD_ALIGNED_ADDRESS_SCAN_WORDS = 512;

/** Deduplicate scans for identical `(chainId, hex)` across repeated decodes / duplicate blobs (bounded). */
const WORD_ALIGNED_ADDRESS_SCAN_CACHE = new LRUCache<string, WordAlignedAddressHit[]>({
  max: 256,
  ttl: 1000 * 60 * 15,
  ttlAutopurge: true,
  updateAgeOnGet: true,
});

/** Clears {@link scanHexForWordAlignedPaddedAddresses} LRU (Vitest). */
export function clearWordAlignedAddressScanCacheForTests(): void {
  WORD_ALIGNED_ADDRESS_SCAN_CACHE.clear();
}

function normalizeHexForScan(h: string): string {
  const t = h.trim();
  if (t.startsWith('0X')) return `0x${t.slice(2).toLowerCase()}`;
  if (t.startsWith('0x')) return `0x${t.slice(2).toLowerCase()}`;
  return `0x${t.toLowerCase()}`;
}

/**
 * Scans dynamic `bytes` hex for standard ABI-style 32-byte words whose last 20 bytes are a valid address
 * (12 leading zero bytes). Used when calldata is opaque or only partially decoded.
 * Results are memoized per `(chainId, normalized hex)` with a small TTL LRU so identical payloads are not
 * rescanned on every decode pass.
 */
export function scanHexForWordAlignedPaddedAddresses(
  hex: string,
  chainId: number = DEFAULT_CHAIN_ID,
): WordAlignedAddressHit[] {
  const clean = normalizeHexForScan(hex);
  const cacheKey = `${chainId}:${clean}`;
  const cached = WORD_ALIGNED_ADDRESS_SCAN_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached.map((h) => ({ ...h }));
  }

  const body = clean.slice(2);
  if (!/^[0-9a-f]*$/.test(body)) return [];
  if (body.length % 2 !== 0) return [];
  const numBytes = body.length / 2;
  const maxWords = Math.min(Math.floor(numBytes / 32), MAX_WORD_ALIGNED_ADDRESS_SCAN_WORDS);
  const out: WordAlignedAddressHit[] = [];
  for (let w = 0; w < maxWords; w++) {
    const startHex = w * 64;
    const slice64 = body.slice(startHex, startHex + 64);
    if (slice64.length !== 64) break;
    const wordHex = `0x${slice64}`;
    const addr = extractLeftPaddedAddressFromBytes32(wordHex);
    if (!addr) continue;
    if (addr.toLowerCase() === '0x0000000000000000000000000000000000000000') continue;
    const nm = getContractName(addr, chainId);
    out.push({ wordIndex: w, checksummed: addr, label: nm || undefined });
  }
  WORD_ALIGNED_ADDRESS_SCAN_CACHE.set(cacheKey, out);
  return out;
}

/** Plain-text note for left-padded addresses when the tree UI does not add a structured address row. */
export function interpretBytes32AsLeftPaddedAddress(hex: string): string | undefined {
  const checksummed = extractLeftPaddedAddressFromBytes32(hex);
  if (!checksummed) return undefined;
  if (checksummed.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return 'Zero address (bytes32-wrapped)';
  }
  return `EVM address (bytes32-wrapped): ${checksummed}`;
}

export function formatBytes32(hex: string): {
  display: string;
  asString: string | undefined;
} {
  const ascii = hexToAscii(hex);
  const isPrintable = ascii.length > 0 && /^[\x20-\x7e]+$/.test(ascii);

  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  const byteLen = clean.length / 2;

  const display =
    hex.length > BYTES32_HEX_STRING_MAX_LEN
      ? `${hex.slice(0, 10)}...${hex.slice(-8)} (${byteLen} bytes)`
      : hex;

  return {
    display,
    asString: isPrintable ? `"${ascii}"` : undefined,
  };
}

function hexToAscii(hex: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    return '';
  }
  let result = '';
  for (let i = 0; i < clean.length; i += 2) {
    const byte = parseInt(clean.slice(i, i + 2), 16);
    if (byte === 0) break;
    result += String.fromCharCode(byte);
  }
  return result;
}

function formatBigIntPlain(value: bigint): string {
  return INTEGER_DISPLAY_FORMAT.format(value);
}

/** Plain digits for integer part; preserves an optional fractional suffix (fractional segment left as-is). */
function formatIntegerDecimalStringPlain(str: string): string {
  const parts = str.split('.');
  const intRaw = parts[0];
  if (intRaw === '') {
    parts[0] = INTEGER_DISPLAY_FORMAT.format(0n);
  } else {
    try {
      parts[0] = INTEGER_DISPLAY_FORMAT.format(BigInt(intRaw));
    } catch {
      parts[0] = intRaw;
    }
  }
  return parts.join('.');
}

export function formatBool(value: boolean): string {
  return value ? 'true' : 'false';
}

/**
 * Coerce ABI-decoded values for Solidity `bool` without JavaScript truthiness traps (e.g. `Boolean("false")` is `true`).
 * Ethers normally returns real booleans; this hardens odd inputs (strings, bigints).
 */
export function coerceAbiDecodedBool(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'bigint') return raw !== 0n;
  if (typeof raw === 'number') return raw !== 0 && Number.isFinite(raw);
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0' || s === '') return false;
    try {
      return BigInt(s) !== 0n;
    } catch {
      return false;
    }
  }
  return Boolean(raw);
}

export function formatBytesLength(hex: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return `${clean.length / 2} bytes`;
}
