import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'ethers';

import * as abiRegistry from './abiRegistry.ts';
import {
  clearWordAlignedAddressScanCacheForTests,
  coerceAbiDecodedBool,
  formatBytes32,
  formatTokenAmount,
  formatUint256,
  tokenAmountWholePartExceedsPlausibleDisplay,
  extractLeftPaddedAddressFromBytes32,
  interpretBytes32AsLeftPaddedAddress,
  scanHexForWordAlignedPaddedAddresses,
  tryFormatUint256,
  tryParseBigInt,
} from './valueFormatter.ts';

const MAX_UINT256_STR = ((1n << 256n) - 1n).toString();

describe('tryParseBigInt', () => {
  it('accepts decimal and 0x hex', () => {
    expect(tryParseBigInt('123')).toBe(123n);
    expect(tryParseBigInt('  42  ')).toBe(42n);
    expect(tryParseBigInt('0x10')).toBe(16n);
    expect(tryParseBigInt('-7')).toBe(-7n);
  });

  it('returns null for empty, invalid, or fractional strings', () => {
    expect(tryParseBigInt('')).toBeNull();
    expect(tryParseBigInt('   ')).toBeNull();
    expect(tryParseBigInt('abc')).toBeNull();
    expect(tryParseBigInt('1.5')).toBeNull();
    expect(tryParseBigInt('0x')).toBeNull();
  });

  it('parses zero', () => {
    expect(tryParseBigInt('0')).toBe(0n);
    expect(tryParseBigInt('0x0')).toBe(0n);
  });
});

describe('formatUint256', () => {
  it('does not throw on invalid raw; echoes display', () => {
    const r = formatUint256('not-a-number');
    expect(r.display).toBe('not-a-number');
    expect(r.interpretation).toBeUndefined();
  });

  it('still formats valid integers', () => {
    const r = formatUint256('1000');
    expect(r.display).toBe('1000');
  });

  it('does not label 9-digit values as timestamps (narrow window)', () => {
    const r = formatUint256('978307200');
    expect(r.display).toBe('978307200');
    expect(r.interpretation).toBeUndefined();
  });

  it('labels plausible 10-digit Unix seconds as timestamps', () => {
    const r = formatUint256('1700000000');
    expect(r.interpretation).toMatch(/^Timestamp:/);
  });

  it('does not label 10-digit ERC-20 approve amounts as timestamps (above 2³¹−1)', () => {
    const r = formatUint256('5000148499');
    expect(r.display).toBe('5000148499');
    expect(r.interpretation).toBeUndefined();
  });

  it('does not assume 18 decimals for large integers', () => {
    const r = formatUint256('1000000000000000000');
    expect(r.display).toBe('1000000000000000000');
    expect(r.interpretation).toBeUndefined();
  });

  it('formats zero and echoes invalid bare 0x without throwing', () => {
    expect(formatUint256('0')).toEqual({ display: '0', interpretation: undefined });
    expect(formatUint256('0x')).toEqual({ display: '0x', interpretation: undefined });
  });

  it('detects max uint256', () => {
    const r = formatUint256(MAX_UINT256_STR);
    expect(r.display).toBe('type(uint256).max');
    expect(r.interpretation).toContain('unlimited');
  });
});

describe('tryFormatUint256', () => {
  it('returns null for non-string input', () => {
    expect(tryFormatUint256(null)).toBeNull();
    expect(tryFormatUint256(123)).toBeNull();
    expect(tryFormatUint256(undefined)).toBeNull();
  });

  it('mirrors formatUint256 for strings', () => {
    expect(tryFormatUint256('1000')).toEqual({ display: '1000' });
    const ts = tryFormatUint256('1700000000');
    expect(ts).toMatchObject({ interpretation: expect.stringMatching(/^Timestamp:/) });
  });
});

describe('extractLeftPaddedAddressFromBytes32', () => {
  it('returns checksummed address for twelve zero bytes + address', () => {
    const hex =
      '0x0000000000000000000000001808db50d1f8c8b2cd0b0f00938f2ccf94b2b563';
    expect(extractLeftPaddedAddressFromBytes32(hex)).toBe(
      getAddress('0x1808db50d1f8c8b2cd0b0f00938f2ccf94b2b563'),
    );
  });

  it('returns undefined when high word is non-zero', () => {
    expect(
      extractLeftPaddedAddressFromBytes32(
        '0x0000000000000000000000010000000000000000000000000000000000000001',
      ),
    ).toBeUndefined();
  });
});

describe('interpretBytes32AsLeftPaddedAddress', () => {
  it('recognizes twelve zero bytes + address', () => {
    const hex =
      '0x0000000000000000000000001808db50d1f8c8b2cd0b0f00938f2ccf94b2b563';
    expect(interpretBytes32AsLeftPaddedAddress(hex)).toBe(
      `EVM address (bytes32-wrapped): ${getAddress('0x1808db50d1f8c8b2cd0b0f00938f2ccf94b2b563')}`,
    );
  });

  it('returns undefined when high word is non-zero', () => {
    const hex =
      '0x0000000000000000000000010000000000000000000000000000000000000001';
    expect(interpretBytes32AsLeftPaddedAddress(hex)).toBeUndefined();
  });

  it('returns undefined for wrong length', () => {
    expect(interpretBytes32AsLeftPaddedAddress('0x00')).toBeUndefined();
  });
});

describe('formatBytes32', () => {
  it('decodes valid hex to ASCII when printable', () => {
    const hex =
      '0x' +
      Array.from('hello', (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('') +
      '00'.repeat(32 - 5);
    const r = formatBytes32(hex);
    expect(r.asString).toBe('"hello"');
  });

  it('returns no ASCII for invalid hex', () => {
    expect(formatBytes32('0xgg').asString).toBeUndefined();
    expect(formatBytes32('0xabc').asString).toBeUndefined();
  });

  it('shows full bytes32-length hex without truncating', () => {
    const hex = `0x${'00'.repeat(32)}`;
    expect(hex.length).toBe(66);
    const r = formatBytes32(hex);
    expect(r.display).toBe(hex);
  });

  it('truncates only when longer than bytes32 (0x + 64 hex)', () => {
    const hex = `0x${'00'.repeat(40)}`;
    expect(hex.length).toBeGreaterThan(66);
    const r = formatBytes32(hex);
    expect(r.display).toMatch(/^\S{10}\.\.\.\S{8} \(40 bytes\)$/);
    expect(r.display).toContain('...');
  });
});

describe('tokenAmountWholePartExceedsPlausibleDisplay', () => {
  it('flags integer parts with more than 18 decimal digits', () => {
    expect(tokenAmountWholePartExceedsPlausibleDisplay('1' + '0'.repeat(19), 0)).toBe(true);
    expect(tokenAmountWholePartExceedsPlausibleDisplay('1' + '0'.repeat(25), 6)).toBe(true);
  });

  it('allows normal supplies and zero fractional whole', () => {
    expect(tokenAmountWholePartExceedsPlausibleDisplay('1500000', 6)).toBe(false);
    expect(tokenAmountWholePartExceedsPlausibleDisplay('999', 18)).toBe(false);
  });
});

describe('formatTokenAmount', () => {
  it('does not throw on invalid raw', () => {
    const r = formatTokenAmount('xyz', 18, 'TKN');
    expect(r.display).toBe('xyz');
    expect(r.interpretation).toContain('Unparseable');
  });

  it('handles bogus decimals without throwing', () => {
    const r = formatTokenAmount('1000000000000000000', Number.NaN, 'ETH');
    expect(r.display).toBe('1000000000000000000');
    expect(r.interpretation).toContain('invalid decimals');
  });

  it('formats normal token amounts', () => {
    const r = formatTokenAmount('1000000000000000000', 18, 'ETH');
    expect(r.interpretation).toMatch(/1 .*ETH/);
    expect(r.interpretation).not.toContain('USD');
  });

  it('appends USD peg disclaimer for curated stablecoins', () => {
    const r = formatTokenAmount('1500000', 6, 'USDC');
    expect(r.interpretation).toContain('USDC');
    expect(r.interpretation).toMatch(/\$1\.5/);
    expect(r.interpretation.toLowerCase()).toContain('peg');
  });

  it('rejects absurd scale (wrong slot / decimals) — no USD peg', () => {
    const raw = '1' + '0'.repeat(40);
    const r = formatTokenAmount(raw, 6, 'USDC');
    expect(r.interpretation).toMatch(/Unlikely USDC/i);
    expect(r.interpretation).toMatch(/no USD peg/i);
    expect(r.interpretation.toLowerCase()).not.toContain('assumes $1 peg');
  });

  it('uses whole units when decimals is 0 (no leading-dot bug)', () => {
    const r = formatTokenAmount('12345', 0, 'NFT');
    expect(r.display).toBe('12345');
    expect(r.interpretation).toBe('12345 NFT');
  });

  it('sanitizes symbol for display (control chars, empty fallback)', () => {
    const r = formatTokenAmount('1', 18, 'E\x00TH');
    expect(r.interpretation).toContain('ETH');
    expect(r.interpretation).not.toContain('\x00');
    const empty = formatTokenAmount('1', 18, '   \t  ');
    expect(empty.interpretation).toContain('TOKEN');
  });

  it('formats zero amount and max uint256', () => {
    const z = formatTokenAmount('0', 18, 'ETH');
    expect(z.display).toBe('0');
    expect(z.interpretation).toBe('0.0 ETH');
    const max = formatTokenAmount(MAX_UINT256_STR, 18, 'USDC');
    expect(max.display).toBe('type(uint256).max');
    expect(max.interpretation).toContain('Unlimited');
  });
});

describe('scanHexForWordAlignedPaddedAddresses', () => {
  afterEach(() => {
    clearWordAlignedAddressScanCacheForTests();
  });

  it('reuses LRU cache for identical chainId+hex', () => {
    const w0 = '0'.repeat(24) + 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const hex = `0x${w0}${'f'.repeat(64)}`;
    const spy = vi.spyOn(abiRegistry, 'getContractName');
    scanHexForWordAlignedPaddedAddresses(hex, 1);
    const afterFirst = spy.mock.calls.length;
    scanHexForWordAlignedPaddedAddresses(hex, 1);
    expect(spy.mock.calls.length).toBe(afterFirst);
    spy.mockRestore();
  });

  it('finds left-padded USDC in first ABI word', () => {
    const w0 = '0'.repeat(24) + 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const w1 = 'f'.repeat(64);
    const hex = `0x${w0}${w1}`;
    const hits = scanHexForWordAlignedPaddedAddresses(hex, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.wordIndex).toBe(0);
    expect(hits[0]!.checksummed).toBe(getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'));
  });

  it('returns empty for short hex and skips zero-address word', () => {
    expect(scanHexForWordAlignedPaddedAddresses('0xabcd', 1)).toEqual([]);
    const zeroWord = '0'.repeat(64);
    expect(scanHexForWordAlignedPaddedAddresses(`0x${zeroWord}`, 1)).toEqual([]);
  });
});

describe('coerceAbiDecodedBool', () => {
  it('maps common forms without string truthiness bugs', () => {
    expect(coerceAbiDecodedBool(true)).toBe(true);
    expect(coerceAbiDecodedBool(false)).toBe(false);
    expect(coerceAbiDecodedBool(0n)).toBe(false);
    expect(coerceAbiDecodedBool(1n)).toBe(true);
    expect(coerceAbiDecodedBool('false')).toBe(false);
    expect(coerceAbiDecodedBool('true')).toBe(true);
    expect(coerceAbiDecodedBool('0')).toBe(false);
    expect(coerceAbiDecodedBool('1')).toBe(true);
  });
});
