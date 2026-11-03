/**
 * Live check that every configured RPC answers for the right chain and is usable from a browser (CORS).
 * Public endpoints rot: in Nov 2026 eth.llamarpc.com served a Cloudflare 525 page, polygon-rpc.com answered
 * "API key disabled", and 1rpc.io's Arbitrum/Optimism endpoints sent no Access-Control-Allow-Origin.
 * Run: `npm run test:integration`
 */
import { describe, expect, it } from 'vitest';

import { CHAINS } from './chains.ts';

const ORIGIN = 'https://recdec.eth.limo';

async function probe(url: string): Promise<{ chainId: number | null; cors: string | null; detail: string }> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await resp.text();
    let chainId: number | null = null;
    try {
      const j = JSON.parse(text) as { result?: string };
      chainId = j.result ? Number(BigInt(j.result)) : null;
    } catch {
      /* not JSON */
    }
    return { chainId, cors: resp.headers.get('access-control-allow-origin'), detail: `${resp.status} ${text.slice(0, 80)}` };
  } catch (e) {
    return { chainId: null, cors: null, detail: e instanceof Error ? e.message : String(e) };
  }
}

describe('configured RPC endpoints (live)', () => {
  for (const chain of Object.values(CHAINS)) {
    for (const url of chain.rpcs) {
      it(`${chain.name}: ${url}`, async () => {
        const r = await probe(url);
        // A rate-limit answer (429) is acceptable for public endpoints; a dead or wrong-chain endpoint is not.
        if (r.detail.startsWith('429')) return;
        expect(r.chainId, r.detail).toBe(chain.id);
        expect(r.cors === '*' || r.cors === ORIGIN, `CORS header: ${r.cors}`).toBe(true);
      });
    }
  }
});
