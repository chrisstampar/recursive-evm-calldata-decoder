/**
 * Live-RPC check: Enso tx `0xe4c28236…` — `executeShortcut` `commands[]` expands (swap + nested shortcut).
 * Run: `npm run test:integration`
 */
import { describe, expect, it } from 'vitest';

import { CHAINS } from './chains.ts';
import { decodeCalldata } from './decoder.ts';
import { DEFAULT_DECODE_OPTIONS } from '../types/index.ts';

const TX_HASH =
  '0xe4c28236ec36ede0910c397a9b50633b5d2bf8fb648946527e849135d5137ccd';

const MAINNET_RPCS = CHAINS[1]?.rpcs ?? [
  'https://eth.llamarpc.com',
  'https://ethereum-rpc.publicnode.com',
];

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(r => {
    setTimeout(r, ms);
  });
}

async function fetchTxByHash(hash: string): Promise<{ input: string; to: string } | null> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getTransactionByHash',
    params: [hash],
  });
  for (const url of MAINNET_RPCS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rpc = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        const text = await rpc.text();
        let j: unknown;
        try {
          j = JSON.parse(text);
        } catch {
          await sleep(300 * (attempt + 1));
          continue;
        }
        const parsed = j as { result?: { input?: string; to?: string } | null };
        if (parsed.result?.input && parsed.result.input.length > 10) {
          return { input: parsed.result.input, to: parsed.result.to ?? '' };
        }
      } catch {
        await sleep(300 * (attempt + 1));
      }
    }
  }
  return null;
}

describe('Enso tx 0xe4c28236… command scan (live RPC)', () => {
  it('decodes routeData and expands commands[] (swap + nested executeShortcut)', async (ctx) => {
    const tx = await fetchTxByHash(TX_HASH);
    if (!tx) {
      ctx.skip('No Ethereum RPC returned this tx (rate limit or network). Retry `npm run test:integration`.');
      return;
    }

    const res = await decodeCalldata(tx.input, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
      callTarget: tx.to,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;

    expect(res.call.signature.name).toBe('routeMulti');
    const routeData = res.call.params.find((p) => p.name === 'routeData');
    expect(routeData?.value.kind).toBe('bytes');
    if (routeData?.value.kind !== 'bytes') return;
    expect(routeData.value.decoded?.signature.name).toBe('executeShortcut');

    const commands = routeData.value.decoded?.params.find((p) => p.name === 'commands');
    expect(commands?.value.kind).toBe('array');
    if (commands?.value.kind !== 'array') return;

    const decodedCommands = commands.value.elements.filter(
      e => e.kind === 'bytes' && e.decoded,
    );

    expect(commands.value.elements.length).toBe(18);
    expect(decodedCommands.length).toBeGreaterThanOrEqual(2);
    const decodedNames = decodedCommands.map(
      e => (e.kind === 'bytes' && e.decoded ? e.decoded.signature.name : ''),
    );
    expect(decodedNames).toContain('swap');
    expect(decodedNames).toContain('executeShortcut');
  });
});
