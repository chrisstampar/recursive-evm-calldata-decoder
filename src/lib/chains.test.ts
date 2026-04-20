import { describe, expect, it } from 'vitest';

import {
  CHAINS,
  getBundledChainlistNameCount,
  getKnownEvmChainName,
  parseChainIdFromDecodedUint,
  parseDecodedChainId,
} from './chains.ts';

describe('CHAINS', () => {
  it('lists multiple RPC fallbacks for HyperEVM (999)', () => {
    expect(CHAINS[999]?.rpcs.length).toBeGreaterThanOrEqual(2);
    expect(CHAINS[999]?.rpcs[0]).toContain('hyperliquid');
  });
});

describe('getKnownEvmChainName', () => {
  it('uses CHAINS name when the chain is configured (Ethereum, HyperEVM)', () => {
    expect(getKnownEvmChainName(1)).toBe('Ethereum');
    expect(getKnownEvmChainName(999)).toBe('HyperEVM');
  });

  it('resolves IDs from bundled chainlist when not in CHAINS', () => {
    expect(getKnownEvmChainName(59144)).toBe('Linea');
    expect(getKnownEvmChainName(534352)).toBe('Scroll');
    expect(getKnownEvmChainName(56)).toBe('BNB Smart Chain Mainnet');
  });

  it('bundles thousands of chainlist names', () => {
    expect(getBundledChainlistNameCount()).toBeGreaterThan(2000);
  });
});

describe('parseDecodedChainId', () => {
  it('uses canonical decimalLabel from BigInt (no display/lookup mismatch)', () => {
    expect(parseDecodedChainId('0100')).toEqual({ decimalLabel: '100', lookup: 100 });
    expect(parseDecodedChainId('999')).toEqual({ decimalLabel: '999', lookup: 999 });
  });
});

describe('parseChainIdFromDecodedUint', () => {
  it('parses decimal string from decoded calldata', () => {
    expect(parseChainIdFromDecodedUint('999')).toBe(999);
    expect(parseChainIdFromDecodedUint(' 42161 ')).toBe(42161);
  });

  it('returns undefined for out-of-safe-integer range', () => {
    expect(parseChainIdFromDecodedUint((BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString())).toBeUndefined();
  });
});
