/**
 * Protocol-specific decoding checked against real mainnet transactions (Nov 2026 corpus run).
 */
import { describe, expect, it } from 'vitest';

import { decodeCalldata } from './decoder.ts';
import { DEFAULT_DECODE_OPTIONS, type DecodedValue } from '../types/index.ts';
import { COW_SETTLE_MAINNET, ONEINCH_V6_SWAP_USDC_TO_ETH_MAINNET } from '../fixtures/decoderCalldataHex.ts';

const opts = { ...DEFAULT_DECODE_OPTIONS, chainId: 1, offlineMode: true, resolveEns: false, fetchTokenDecimalsOnChain: false };

function fields(v: DecodedValue | undefined) {
  if (v?.kind !== 'tuple') throw new Error('expected tuple');
  return Object.fromEntries(v.fields.map(f => [f.name, f.value]));
}
const interp = (v: DecodedValue | undefined) => (v?.kind === 'primitive' ? v.interpretation : undefined);

describe('CoW Protocol settle', () => {
  it('decodes with named trade fields, a real uint256[] and per-trade token units', async () => {
    const r = await decodeCalldata(COW_SETTLE_MAINNET, opts);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    // clearingPrices is uint256[]: an array of values, not one comma-joined "number".
    expect(r.call.params[1].value.kind).toBe('array');
    const trades = r.call.params[2].value;
    if (trades.kind !== 'array') throw new Error('array');
    const t0 = fields(trades.elements[0]);
    expect(interp(t0.sellAmount)).toMatch(/^2\.002703 USDT/);
    expect(interp(t0.buyAmount)).toMatch(/ETH$/);
    expect(interp(t0.executedAmount)).toMatch(/USDT/); // sell order: executed amount is in the sell token
  });
});

describe('1inch Aggregation Router V6 swap', () => {
  it('labels amount in the sell token and minReturnAmount in the buy token (native ETH placeholder)', async () => {
    const r = await decodeCalldata(ONEINCH_V6_SWAP_USDC_TO_ETH_MAINNET, opts);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.call.signature.source).toBe('bundled');
    const desc = fields(r.call.params[1].value);
    expect(interp(desc.amount)).toMatch(/USDC/);
    expect(interp(desc.minReturnAmount)).toMatch(/ETH/);
    expect(interp(desc.minReturnAmount)).not.toMatch(/USDC/);
    const dst = desc.dstToken;
    expect(dst.kind === 'address' && dst.label).toMatch(/native ETH/);
  });
});
