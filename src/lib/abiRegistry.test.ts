import { describe, expect, it } from 'vitest';
import { getAddress } from 'ethers';
import type { DecodedCall, FunctionSignature } from '../types/index.ts';
import {
  compareBundledSignaturesByRank,
  getContractName,
  getContractRegistryEntry,
  lookupBundledSelector,
} from './abiRegistry.ts';
import { analyzeWarnings } from './warningAnalyzer.ts';

function stubCall(fnName: string): DecodedCall {
  return {
    selector: '0xa9059cbb',
    signature: {
      selector: '0xa9059cbb',
      name: fnName,
      textSignature: `${fnName}(address,uint256)`,
      params: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      source: 'bundled',
    },
    params: [],
    confidence: 'exact',
    alternatives: [],
    depth: 0,
    rawCalldata: '0x',
  };
}

function stubKnownPatternCall(selector: string, name: string, textSignature: string): DecodedCall {
  return {
    selector,
    signature: {
      selector: selector as `0x${string}`,
      name,
      textSignature,
      params: [],
      source: 'bundled',
    },
    params: [],
    confidence: 'exact',
    alternatives: [],
    depth: 0,
    rawCalldata: '0x',
  };
}

describe('abiRegistry', () => {
  it('evaluates bundled entries: selector must match keccak(textSignature) at load', () => {
    const transfer = lookupBundledSelector('0xa9059cbb');
    expect(transfer.some(s => s.textSignature === 'transfer(address,uint256)')).toBe(true);
  });

  it('compareBundledSignaturesByRank: non-deprecated first, then popularity desc, then textSignature', () => {
    const base = {
      selector: '0xdeadbeef' as const,
      name: 'x',
      params: [] as FunctionSignature['params'],
      source: 'bundled' as const,
    };
    const deprecatedHigh: FunctionSignature = {
      ...base,
      name: 'old',
      textSignature: 'old()',
      popularity: 999,
      deprecated: true,
    };
    const hi: FunctionSignature = { ...base, name: 'hi', textSignature: 'hi()', popularity: 50 };
    const lo: FunctionSignature = { ...base, name: 'lo', textSignature: 'lo()', popularity: 10 };
    const tieB: FunctionSignature = { ...base, name: 'b', textSignature: 'b()', popularity: 5 };
    const tieA: FunctionSignature = { ...base, name: 'a', textSignature: 'a()', popularity: 5 };
    expect([deprecatedHigh, lo, hi].sort(compareBundledSignaturesByRank).map(s => s.textSignature)).toEqual([
      'hi()',
      'lo()',
      'old()',
    ]);
    expect([tieB, tieA].sort(compareBundledSignaturesByRank).map(s => s.textSignature)).toEqual(['a()', 'b()']);
  });

  it('resolves contract labels via EIP-55 map (lowercase input still matches)', () => {
    const wethLower = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    expect(getContractName(wethLower, 1)).toBe('WETH');
    expect(getContractName(getAddress(wethLower), 1)).toBe('WETH');
  });

  it('flags Aave V3 Pool as upgradeable proxy with EIP-1967 slot and critical risk', () => {
    const e = getContractRegistryEntry('0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', 1);
    expect(e?.isProxy).toBe(true);
    expect(e?.implementationSlot?.toLowerCase()).toMatch(/^0x360894a1/);
    expect(e?.riskLevel).toBe('critical');
  });

  it('marks Aave V2 Lending Pool as critical risk', () => {
    const e = getContractRegistryEntry('0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9', 1);
    expect(e?.name).toBe('Aave V2 Lending Pool');
    expect(e?.riskLevel).toBe('critical');
    expect(e?.isProxy).toBe(true);
  });

  it('resolves Aave V3 Pool on Polygon with critical risk', () => {
    const e = getContractRegistryEntry('0x794a61358d6845594f94dc1db02a252b5b4814ad', 137);
    expect(e?.name).toBe('Aave V3 Pool');
    expect(e?.riskLevel).toBe('critical');
  });

  it('does not apply Ethereum mainnet registry entries on other chains (no false positive)', () => {
    const mainnetUsdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    expect(getContractName(mainnetUsdc, 1)).toBe('USDC');
    expect(getContractName(mainnetUsdc, 42161)).toBeUndefined();
    expect(getContractRegistryEntry(mainnetUsdc, 8453)).toBeUndefined();
  });

  it('uses token symbol as address label when no contract name exists (mainnet)', () => {
    const steth = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
    expect(getContractRegistryEntry(steth, 1)).toBeUndefined();
    expect(getContractName(steth, 1)).toBe('stETH');
  });

  it('resolves L2 canonical token addresses from per-chain token map (Arbitrum native USDC)', () => {
    const arbUsdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
    expect(getContractName(arbUsdc, 42161)).toBe('USDC');
    expect(getContractName(arbUsdc, 1)).toBeUndefined();
  });
});

describe('proxy warning', () => {
  it('adds info when txTo matches a marked proxy', () => {
    const warnings = analyzeWarnings(stubCall('transfer'), undefined, {
      txTo: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
      chainId: 1,
    });
    expect(warnings.some(w => w.title === 'Proxy contract target')).toBe(true);
  });

  it('adds critical-sensitivity warning when txTo matches registry riskLevel critical', () => {
    const warnings = analyzeWarnings(stubCall('transfer'), undefined, {
      txTo: '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9',
      chainId: 1,
    });
    expect(warnings.some(w => w.title === 'Critical-sensitivity contract')).toBe(true);
  });

  it('adds high-sensitivity warning when txTo matches registry riskLevel high', () => {
    const warnings = analyzeWarnings(stubCall('transfer'), undefined, {
      txTo: '0xd9db270c1b5e3bd161e8c8503c55ceabee709552',
      chainId: 1,
    });
    expect(warnings.some(w => w.title === 'High-sensitivity contract')).toBe(true);
  });

  it('skips proxy warning when txTo is omitted', () => {
    const warnings = analyzeWarnings(stubCall('transfer'), undefined);
    expect(warnings.some(w => w.title === 'Proxy contract target')).toBe(false);
  });

  it('adds sensitive-pattern warning for known multicall selectors', () => {
    const warnings = analyzeWarnings(
      stubKnownPatternCall('0xac9650d8', 'multicall', 'multicall(bytes[])'),
      undefined,
    );
    expect(warnings.some(w => w.title.startsWith('Sensitive pattern:'))).toBe(true);
    expect(warnings.some(w => w.message.includes('arbitrary'))).toBe(true);
  });

  it('dedupes sensitive-pattern warnings when the same selector appears nested', () => {
    const inner = stubKnownPatternCall('0xac9650d8', 'multicall', 'multicall(bytes[])');
    const outer: DecodedCall = {
      ...stubKnownPatternCall('0xac9650d8', 'multicall', 'multicall(bytes[])'),
      params: [
        {
          name: 'data',
          type: 'bytes',
          value: {
            kind: 'bytes',
            hex: '0x',
            decoded: inner,
          },
        },
      ],
    };
    const warnings = analyzeWarnings(outer, undefined);
    expect(warnings.filter(w => w.title.startsWith('Sensitive pattern:'))).toHaveLength(1);
  });

  it('dedupes Ambiguous decode when the same selector+name appears in many nested frames', () => {
    const signature = {
      selector: '0x12345678' as const,
      name: 'mystery',
      textSignature: 'mystery()',
      params: [] as { name: string; type: string }[],
      source: '4byte' as const,
    };
    const leaf: DecodedCall = {
      selector: '0x12345678',
      signature,
      params: [],
      confidence: 'ambiguous',
      alternatives: [],
      depth: 2,
      rawCalldata: '0x',
    };
    const mid: DecodedCall = {
      selector: '0x12345678',
      signature,
      params: [
        {
          name: 'd',
          type: 'bytes',
          value: { kind: 'bytes', hex: '0x', decoded: leaf },
        },
      ],
      confidence: 'ambiguous',
      alternatives: [],
      depth: 1,
      rawCalldata: '0x',
    };
    const root: DecodedCall = {
      selector: '0x12345678',
      signature,
      params: [
        {
          name: 'd',
          type: 'bytes',
          value: { kind: 'bytes', hex: '0x', decoded: mid },
        },
      ],
      confidence: 'ambiguous',
      alternatives: [],
      depth: 0,
      rawCalldata: '0x',
    };
    const warnings = analyzeWarnings(root, undefined);
    expect(warnings.filter(w => w.title === 'Ambiguous decode')).toHaveLength(1);
  });
});
