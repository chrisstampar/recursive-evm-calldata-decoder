/**
 * Live check of the curated registry against each chain: registry labels are the most trusted text in the UI,
 * so a stale symbol, wrong decimals or a label on an empty address misleads as much as a spoofed one.
 * Run: `npm run test:integration`
 */
import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface } from 'ethers';

import { CHAINS } from './chains.ts';
import { getTokenInfo, iterateKnownContractRegistryRows, iterateStaticRegistryAddressLiterals } from './abiRegistry.ts';

const ERC20 = new Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

/**
 * Deliberate differences from `symbol()` (lowercased `chainId:address` → why). Anything else that differs fails.
 */
const SYMBOL_EXCEPTIONS: Record<string, string> = {
  '1:0x6c96de32cea08842dcc4058c14d3aaad7fa41dee': 'USDT0 OFT adapter, not an ERC-20 (calls revert)',
  '10:0x7f5c764cbc14f9669b88837ca1490cca17c31607': 'bridged USDC labelled USDC.e (on-chain symbol is USDC)',
  '137:0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'bridged USDC labelled USDC.e',
  '42161:0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'bridged USDC labelled USDC.e',
  '42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'on-chain symbol is "USD₮0"; registry uses ASCII USDT0',
};
/** Labelled addresses that intentionally have no code. */
const NO_CODE_OK = new Set(['0x0000000000000000000000000000000000000000']);

async function rpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
  const urls = CHAINS[chainId].rpcs;
  let lastErr: unknown = new Error('no RPC answered');
  for (let i = 0; i < urls.length * 2; i++) {
    try {
      const r = await fetch(urls[i % urls.length], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
      if ('result' in j) return j.result;
      if (method === 'eth_call' && /revert/i.test(j.error?.message ?? '')) return null;
      lastErr = new Error(j.error?.message ?? `HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise(res => setTimeout(res, 300));
  }
  throw lastErr;
}

async function readToken(chainId: number, address: string): Promise<{ symbol: string | null; decimals: number | null }> {
  const call = (data: string) => rpc(chainId, 'eth_call', [{ to: address, data }, 'latest']);
  const [d, s] = await Promise.all([call(ERC20.encodeFunctionData('decimals')), call(ERC20.encodeFunctionData('symbol'))]);
  let decimals: number | null = null;
  let symbol: string | null;
  try {
    decimals = Number(ERC20.decodeFunctionResult('decimals', d as string)[0]);
  } catch {
    /* not ERC-20 */
  }
  try {
    symbol = String(ERC20.decodeFunctionResult('symbol', s as string)[0]);
  } catch {
    try {
      const b = AbiCoder.defaultAbiCoder().decode(['bytes32'], s as string)[0] as string;
      symbol = Buffer.from(b.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
    } catch {
      symbol = null;
    }
  }
  return { symbol, decimals };
}

describe('curated registry vs chain (live)', () => {
  const tokens = [...iterateStaticRegistryAddressLiterals()].filter(r => r.kind === 'token-map-key');

  it('every registry token has code, matching decimals and symbol', async () => {
    const problems: string[] = [];
    for (const t of tokens) {
      const key = `${t.chainId}:${t.literal.toLowerCase()}`;
      const info = getTokenInfo(t.literal, t.chainId);
      const code = await rpc(t.chainId, 'eth_getCode', [t.literal, 'latest']);
      if (typeof code !== 'string' || code === '0x') {
        problems.push(`${key} ${info?.symbol}: no code`);
        continue;
      }
      if (SYMBOL_EXCEPTIONS[key]) continue;
      const onChain = await readToken(t.chainId, t.literal);
      if (onChain.decimals !== info?.decimals) problems.push(`${key} ${info?.symbol}: decimals ${info?.decimals} vs chain ${onChain.decimals}`);
      if (onChain.symbol?.toLowerCase() !== info?.symbol.toLowerCase()) problems.push(`${key}: symbol ${info?.symbol} vs chain ${onChain.symbol}`);
    }
    expect(problems).toEqual([]);
  }, 900_000);

  it('every labelled contract has code', async () => {
    const problems: string[] = [];
    for (const row of iterateKnownContractRegistryRows()) {
      if (NO_CODE_OK.has(row.addressKey.toLowerCase())) continue;
      const code = await rpc(row.chainId, 'eth_getCode', [row.addressKey, 'latest']);
      if (typeof code !== 'string' || code === '0x') problems.push(`${row.chainId}:${row.addressKey} "${row.entry.name}"`);
    }
    expect(problems).toEqual([]);
  }, 900_000);
});
