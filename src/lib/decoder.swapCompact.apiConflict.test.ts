import { describe, expect, it, vi } from 'vitest';

import type { HexSelector } from '../types/index.ts';
import { DEFAULT_DECODE_OPTIONS } from '../types/index.ts';

vi.mock('./signatureLookup.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./signatureLookup.ts')>();
  return {
    ...actual,
    lookupSelector: async (selector: string, options: Parameters<typeof actual.lookupSelector>[1]) => {
      if (selector.trim().toLowerCase() === '0x83bd37f9') {
        return [
          {
            selector: '0x83bd37f9' as HexSelector,
            name: 'swapCompact',
            textSignature: 'swapCompact()',
            params: [],
            source: 'openchain' as const,
          },
        ];
      }
      return actual.lookupSelector(selector, options);
    },
  };
});

const { decodeCalldata } = await import('./decoder.ts');

const opts = { ...DEFAULT_DECODE_OPTIONS, chainId: 1 as const, offlineMode: true };

describe('swapCompact (0x83bd37f9) vs zero-arg API signature', () => {
  it('still expands packed tail when signature DB returns swapCompact() with no parameters', async () => {
    const approveBody =
      '095ea7b3' +
      '0000000000000000000000001111111111111111111111111111111111111111' +
      '000000000000000000000000000000000000000000000000000000000000000001';
    const tail = `deadbeef${approveBody}`;
    const hex = `0x83bd37f9${tail}`;

    const res = await decodeCalldata(hex, opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;

    expect(res.call.params).toHaveLength(1);
    expect(res.call.params[0].name).toBe('compactPayload');
    expect(res.call.params[0].value.kind).toBe('bytes');
    if (res.call.params[0].value.kind !== 'bytes') return;
    expect(res.call.params[0].value.decoded?.signature.name).toBe('approve');
  });
});
