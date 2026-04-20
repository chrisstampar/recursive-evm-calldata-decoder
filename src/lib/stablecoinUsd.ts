import { formatUnits } from 'ethers';
import { sanitizeDecodedString } from './sanitize.ts';

const MAX_SYM_CHARS = 32;

/** Match {@link formatTokenAmount}: peg USD line should not show long `formatUnits` tails (wrong decimals or noise). */
const MAX_STABLE_PEG_FRACTION_DIGITS = 6;

/** Trim `ethers.formatUnits` style decimal string to at most `maxFrac` fractional digits (truncate); strip trailing zeros. */
export function capStablePegUsdAmountDisplay(untrimmed: string, maxFrac: number): string {
  if (maxFrac < 0) return untrimmed;
  const neg = untrimmed.startsWith('-');
  const body = neg ? untrimmed.slice(1) : untrimmed;
  const [intPart, frac = ''] = body.split('.');
  const baseInt = intPart === '' ? '0' : intPart;
  const cappedFrac = frac.slice(0, maxFrac).replace(/0+$/, '');
  let out = cappedFrac ? `${baseInt}.${cappedFrac}` : baseInt;
  if (neg) out = `-${out}`;
  return out;
}

/**
 * Curated symbols we treat as **USD-pegged for display only** (assumes ~$1 unit).
 * Not exhaustive; on-chain `symbol()` must match after sanitization. Depeg / FX stables are user risk.
 */
const USD_PEG_SYMBOL_KEYS = new Set<string>([
  'USDC',
  'USDC.E',
  'USDB',
  'USDT',
  'USDT0',
  'DAI',
  'GHO',
  'FXUSD',
  'FRAX',
  'LUSD',
  'TUSD',
  'USDP',
  'PYUSD',
  'USDD',
  'GUSD',
  'BUSD',
  'CRVUSD',
  'USDE',
  'DAI.E',
  'SUSDS',
  'USDS',
]);

/** Normalize API/registry/on-chain symbol for set lookup. */
export function stablecoinSymbolKey(symbol: string): string {
  const s = sanitizeDecodedString(symbol.trim(), MAX_SYM_CHARS).toUpperCase();
  return s.replace(/[^A-Z0-9.]/g, '');
}

/**
 * Whether we may append an **approximate USD** line (1:1 peg assumption).
 * Deliberately conservative: unknown or exotic symbols are excluded.
 */
export function isUsdPeggedStablecoinSymbol(symbol: string): boolean {
  const k = stablecoinSymbolKey(symbol);
  if (k === '' || k === 'UNKNOWN' || k === 'TOKEN') return false;
  if (USD_PEG_SYMBOL_KEYS.has(k)) return true;
  if (k.startsWith('USDC.') || k.startsWith('USDT.') || k.startsWith('DAI.')) return true;
  return false;
}

/**
 * One-line disclaimer suffix for interpretations (not a market price).
 * Returns undefined if not a listed stable or unparsable.
 */
export function formatStableUsdPegClause(raw: string, decimals: number, displaySymbol: string): string | undefined {
  if (!isUsdPeggedStablecoinSymbol(displaySymbol)) return undefined;
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 1_000) return undefined;
  try {
    const v = BigInt(typeof raw === 'string' ? raw.trim() : String(raw));
    let s = formatUnits(v, decimals);
    s = capStablePegUsdAmountDisplay(s, MAX_STABLE_PEG_FRACTION_DIGITS);
    if (s.includes('.')) {
      s = s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
    }
    return `≈ $${s} USD (assumes $1 peg; not a live quote)`;
  } catch {
    return undefined;
  }
}

/** Append peg clause to an existing token interpretation when applicable. */
export function appendStableUsdPegClause(
  interpretation: string,
  raw: string,
  decimals: number,
  displaySymbol: string,
): string {
  const clause = formatStableUsdPegClause(raw, decimals, displaySymbol);
  if (!clause) return interpretation;
  return `${interpretation} · ${clause}`;
}
