import { describe, expect, it } from 'vitest';
import {
  appendStableUsdPegClause,
  capStablePegUsdAmountDisplay,
  formatStableUsdPegClause,
  isUsdPeggedStablecoinSymbol,
  stablecoinSymbolKey,
} from './stablecoinUsd.ts';

describe('stablecoinUsd', () => {
  it('stablecoinSymbolKey normalizes', () => {
    expect(stablecoinSymbolKey('  usdc.e  ')).toBe('USDC.E');
  });

  it('isUsdPeggedStablecoinSymbol recognizes curated stables', () => {
    expect(isUsdPeggedStablecoinSymbol('USDC')).toBe(true);
    expect(isUsdPeggedStablecoinSymbol('usdt')).toBe(true);
    expect(isUsdPeggedStablecoinSymbol('USDT0')).toBe(true);
    expect(isUsdPeggedStablecoinSymbol('GHO')).toBe(true);
    expect(isUsdPeggedStablecoinSymbol('fxUSD')).toBe(true);
    expect(isUsdPeggedStablecoinSymbol('crvUSD')).toBe(true);
    expect(isUsdPeggedStablecoinSymbol('ETH')).toBe(false);
    expect(isUsdPeggedStablecoinSymbol('UNKNOWN')).toBe(false);
  });

  it('capStablePegUsdAmountDisplay truncates long fractional tails', () => {
    expect(capStablePegUsdAmountDisplay('1.234567890123456789', 6)).toBe('1.234567');
    expect(capStablePegUsdAmountDisplay('0.000000000000000001', 6)).toBe('0');
  });

  it('formatStableUsdPegClause formats units and skips non-stables', () => {
    expect(formatStableUsdPegClause('1000000', 6, 'USDC')).toMatch(/\$1/);
    expect(formatStableUsdPegClause('1000000', 6, 'ETH')).toBeUndefined();
  });

  it('formatStableUsdPegClause caps peg USD fractional digits (wrong decimals / long formatUnits)', () => {
    const clause = formatStableUsdPegClause('1234567890123456789', 18, 'USDC');
    expect(clause).toBeDefined();
    expect(clause).toMatch(/\$1\.234567 /);
    expect(clause).not.toMatch(/\.[0-9]{7,}/);
  });

  it('appendStableUsdPegClause leaves base interpretation when not stable', () => {
    const base = '1.0 ETH';
    expect(appendStableUsdPegClause(base, '1000000000000000000', 18, 'ETH')).toBe(base);
  });
});
