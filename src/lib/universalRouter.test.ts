import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface } from 'ethers';

import { decodeCalldata } from './decoder.ts';
import { analyzeWarnings } from './warningAnalyzer.ts';
import { DEFAULT_DECODE_OPTIONS, type DecodedCall, type DecodedValue } from '../types/index.ts';
import {
  UR_PERMIT_V3_EXACT_OUT_MAINNET,
  UR_V3_SWAP_HOP_LIMITS_MAINNET,
  UR_V4_SWAP_ETH_IN_MAINNET,
} from '../fixtures/decoderCalldataHex.ts';

const opts = { ...DEFAULT_DECODE_OPTIONS, chainId: 1, offlineMode: true, resolveEns: false, fetchTokenDecimalsOnChain: false };

async function decode(hex: string): Promise<DecodedCall> {
  const r = await decodeCalldata(hex, opts);
  if (r.status !== 'success') throw new Error(r.status === 'error' ? r.error : 'partial');
  return r.call;
}

/** Decoded router steps under `execute`'s `inputs` (or a nested `params` list). */
function steps(list: DecodedValue): DecodedCall[] {
  if (list.kind !== 'array') throw new Error('expected array');
  return list.elements.map(e => {
    if (e.kind !== 'bytes' || !e.decoded) throw new Error('step not decoded');
    return e.decoded;
  });
}

function prim(v: DecodedValue | undefined): Extract<DecodedValue, { kind: 'primitive' }> {
  if (v?.kind !== 'primitive') throw new Error('expected primitive');
  return v;
}

describe('Universal Router execute (real transactions)', () => {
  it('decodes V4_SWAP actions instead of treating inputs as calldata', async () => {
    const call = await decode(UR_V4_SWAP_ETH_IN_MAINNET);
    const cmds = steps(call.params[1].value);
    expect(cmds.map(c => c.signature.name)).toEqual(['V4_SWAP']);
    const actions = steps(cmds[0].params[1].value);
    expect(actions.map(a => a.signature.name)).toEqual(['SWAP_EXACT_IN_SINGLE', 'SETTLE_ALL', 'TAKE_ALL']);

    // ETH in (zeroForOne with currency0 = address(0)): amountIn reads as ETH, and SETTLE_ALL's currency is labelled.
    const swap = actions[0].params[0].value;
    if (swap.kind !== 'tuple') throw new Error('tuple');
    expect(prim(swap.fields[2].value).interpretation).toMatch(/^0\.0297 ETH/);
    const settleCurrency = actions[1].params[0].value;
    expect(settleCurrency.kind === 'address' && settleCurrency.label).toMatch(/native ETH/);
    // No junk nested calls anywhere.
    expect(JSON.stringify(call)).not.toMatch(/f7836435186477227/);
  });

  it('decodes the newer V3_SWAP_EXACT_IN layout with per-hop limits and CONTRACT_BALANCE', async () => {
    const call = await decode(UR_V3_SWAP_HOP_LIMITS_MAINNET);
    const v3 = steps(call.params[1].value).find(c => c.signature.name.startsWith('V3_SWAP_EXACT_IN'));
    expect(v3).toBeDefined();
    expect(v3!.params.map(p => p.name)).toContain('hopLimits');
    expect(prim(v3!.params[1].value).interpretation).toMatch(/CONTRACT_BALANCE/);
  });

  it('labels V3 exact-out amounts by path direction and warns on the permit', async () => {
    const call = await decode(UR_PERMIT_V3_EXACT_OUT_MAINNET);
    const cmds = steps(call.params[1].value);
    expect(cmds.map(c => c.signature.name)).toEqual(['PERMIT2_PERMIT', 'V3_SWAP_EXACT_OUT', 'BALANCE_CHECK_ERC20']);
    // Exact-out v3 paths are encoded output-first, so amountInMax is in the path's last token (USDT here).
    expect(prim(cmds[1].params[2].value).interpretation).toMatch(/USDT/);
    const titles = analyzeWarnings(call, undefined, { chainId: 1 }).map(w => w.title);
    expect(titles.some(t => t === 'Permit2 allowance' || t === 'Unlimited token approval')).toBe(true);
  });

  it('flags swaps with a zero minimum output', async () => {
    const call = await decode(UR_V4_SWAP_ETH_IN_MAINNET);
    expect(analyzeWarnings(call, undefined, { chainId: 1 }).map(w => w.title)).toContain('No slippage limit');
  });

  it('does not flag zero slippage on the swap when a later TAKE_ALL enforces a minimum', async () => {
    const c = AbiCoder.defaultAbiCoder();
    const ZERO = '0x0000000000000000000000000000000000000000';
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const swap = c.encode(
      ['((address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],
      [[[ZERO, USDC, 500, 10, ZERO], true, 10n ** 17n, 0n, '0x']],
    );
    const settle = c.encode(['address', 'uint256'], [ZERO, 10n ** 17n]);
    const take = c.encode(['address', 'uint256'], [USDC, 300_000_000n]); // min 300 USDC enforced here
    const v4 = c.encode(['bytes', 'bytes[]'], ['0x060c0f', [swap, settle, take]]);
    const ur = new Interface(['function execute(bytes commands,bytes[] inputs,uint256 deadline)']);
    const call = await decode(ur.encodeFunctionData('execute', ['0x10', [v4], 0]));
    const titles = analyzeWarnings(call, undefined, { chainId: 1 }).map(w => w.title);
    expect(titles).not.toContain('No slippage limit');
    const take0 = steps(steps(call.params[1].value)[0].params[1].value)[2];
    expect(take0.signature.name).toBe('TAKE_ALL');
    expect(prim(take0.params[1].value).interpretation).toMatch(/^300 USDC/);
  });
});
