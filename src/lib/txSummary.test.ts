import { describe, expect, it } from 'vitest';
import { Interface } from 'ethers';

import { decodeCalldata } from './decoder.ts';
import { analyzeWarnings } from './warningAnalyzer.ts';
import { listDecodedCalls, pathToCall } from './callTree.ts';
import { humanizeFunctionName, summarizeTransaction, type SummaryStep } from './txSummary.ts';
import { DEFAULT_DECODE_OPTIONS, type DecodedCall } from '../types/index.ts';
import {
  ONEINCH_V6_SWAP_USDC_TO_ETH_MAINNET,
  UR_PERMIT_V3_EXACT_OUT_MAINNET,
  UR_V4_SWAP_ETH_IN_MAINNET,
} from '../fixtures/decoderCalldataHex.ts';

const opts = { ...DEFAULT_DECODE_OPTIONS, chainId: 1, offlineMode: true, resolveEns: false, fetchTokenDecimalsOnChain: false };

async function decode(hex: string): Promise<DecodedCall> {
  const r = await decodeCalldata(hex, opts);
  if (r.status !== 'success') throw new Error(r.status === 'error' ? r.error : 'partial');
  return r.call;
}

/** A step as plain text (addresses by label or full address, paths as symbols). */
function line(step: SummaryStep): string {
  return step.parts
    .map(p => {
      if (p.kind === 'text' || p.kind === 'amount') return p.text;
      if (p.kind === 'address') return p.label ?? p.address;
      const t = p.path.exactOut ? [...p.path.tokens].reverse() : p.path.tokens;
      return t.map(x => x.symbol ?? x.address).join(' > ');
    })
    .join('');
}

describe('summarizeTransaction', () => {
  it('spells out a Universal Router permit + exact-out swap + balance check', async () => {
    const call = await decode(UR_PERMIT_V3_EXACT_OUT_MAINNET);
    const { steps } = summarizeTransaction(call, 1);
    const lines = steps.map(line);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Permit2: let Uniswap Universal Router v2 spend 100\.108212 USDT \(this block only\)$/);
    // Exact-out paths are encoded output-first; the summary shows them in trade order (USDT in, NAORIS out).
    expect(lines[1]).toMatch(/^Swap up to 100\.108212 USDT for 3017000000000000000000 0x1b37\w+ via USDT > 0x1b37\w+ → 0x8Bb8/);
    expect(lines[2]).toMatch(/^Check that 0x8Bb8.* holds at least 123505500000000000000000 0x1b37/);
    // Each step points at its own tree node.
    const calls = listDecodedCalls(call);
    expect(steps.map(s => calls[s.callIndex].signature.name)).toEqual(['PERMIT2_PERMIT', 'V3_SWAP_EXACT_OUT', 'BALANCE_CHECK_ERC20']);
  });

  it('nests v4 actions under the V4_SWAP step and reads the native coin', async () => {
    const { steps } = summarizeTransaction(await decode(UR_V4_SWAP_ETH_IN_MAINNET), 1);
    expect(steps.map(s => [s.nesting, line(s)])).toEqual([
      [0, 'Uniswap v4 swap:'],
      [1, expect.stringMatching(/^Swap 0\.0297\d* ETH for any amount \(no minimum\)$/)],
      [1, expect.stringMatching(/^Pay up to 0\.0297\d* ETH$/)],
      [1, expect.stringMatching(/^Receive all 0x2a07\w+ owed \(no minimum\)$/)],
    ]);
  });

  it('reads ERC-20 calls as sentences', async () => {
    const erc20 = new Interface(['function approve(address spender,uint256 amount)', 'function transfer(address to,uint256 amount)']);
    const spender = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af';
    const approve = await decodeCalldata(erc20.encodeFunctionData('approve', [spender, (1n << 256n) - 1n]), {
      ...opts,
      callTarget: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    });
    if (approve.status !== 'success') throw new Error('decode');
    expect(line(summarizeTransaction(approve.call, 1).steps[0])).toBe('Approve Uniswap Universal Router v2 to spend Unlimited USDT approval');
  });

  it('falls back to the function name with addresses and amounts', async () => {
    const { steps } = summarizeTransaction(await decode(ONEINCH_V6_SWAP_USDC_TO_ETH_MAINNET), 1);
    expect(steps).toHaveLength(1);
    expect(line(steps[0])).toMatch(/^Swap/);
  });

  it('humanizes function names', () => {
    expect(humanizeFunctionName('V3_SWAP_EXACT_OUT')).toBe('V3 swap exact out');
    expect(humanizeFunctionName('swapExactTokensForTokens')).toBe('Swap exact tokens for tokens');
  });
});

describe('call tree helpers', () => {
  it('warnings carry the index of the call they are about', async () => {
    const call = await decode(UR_PERMIT_V3_EXACT_OUT_MAINNET);
    const calls = listDecodedCalls(call);
    const permit = analyzeWarnings(call, undefined, { chainId: 1 }).find(w => w.title === 'Permit2 allowance');
    expect(permit?.callIndex).toBeDefined();
    expect(calls[permit!.callIndex!].signature.name).toBe('PERMIT2_PERMIT');
  });

  it('pathToCall runs from the root to the target', async () => {
    const call = await decode(UR_PERMIT_V3_EXACT_OUT_MAINNET);
    const target = listDecodedCalls(call)[2];
    const path = pathToCall(call, target);
    expect(path[0]).toBe(call);
    expect(path[path.length - 1]).toBe(target);
  });
});
