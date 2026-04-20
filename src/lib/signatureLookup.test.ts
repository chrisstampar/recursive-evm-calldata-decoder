import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSelectorLookupCache,
  lookupSelector,
  lookupSelectorFromUserAbi,
  MAX_USER_ABI_JSON_CHARS,
  SIGNATURE_LOOKUP_FOURBYTE_SKIP_MIN_PRIOR,
  shouldFetchFourbyteAfterPriorMerge,
  warmCache,
} from './signatureLookup.ts';
import { canonicalizeTextSignature } from './signatureValidator.ts';

function isSignatureDbLookupUrl(u: string): boolean {
  return u.includes('openchain.xyz') || u.includes('4byte.sourcify.dev');
}

const OVERLOADED_ABI = [
  {
    type: 'function',
    name: 'foo',
    inputs: [{ type: 'uint256', name: 'x' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'foo',
    inputs: [
      { type: 'address', name: 'a' },
      { type: 'uint256', name: 'b' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

describe('lookupSelectorFromUserAbi', () => {
  afterEach(() => {
    clearSelectorLookupCache();
  });

  it('returns [] for invalid selector', () => {
    expect(lookupSelectorFromUserAbi('0x1234567', '[]')).toEqual([]);
  });

  it('returns [] when ABI JSON exceeds the size limit', () => {
    const huge = ' '.repeat(MAX_USER_ABI_JSON_CHARS + 1);
    expect(lookupSelectorFromUserAbi('0xa9059cbb', huge)).toEqual([]);
  });

  it('matches the correct overload by selector, not first name match', () => {
    const iface = new Interface(OVERLOADED_ABI);
    const selUint = iface.getFunction('foo(uint256)')!.selector;
    const selAddrUint = iface.getFunction('foo(address,uint256)')!.selector;
    expect(selUint).not.toBe(selAddrUint);

    const abiJson = JSON.stringify(OVERLOADED_ABI);

    const r0 = lookupSelectorFromUserAbi(selUint, abiJson);
    expect(r0).toHaveLength(1);
    expect(r0[0].textSignature).toBe('foo(uint256)');

    const r1 = lookupSelectorFromUserAbi(selAddrUint, abiJson);
    expect(r1).toHaveLength(1);
    expect(r1[0].textSignature).toBe('foo(address,uint256)');
  });

  it('calls onNonCanonicalSelector when hex casing differs from normalized form', () => {
    const iface = new Interface(OVERLOADED_ABI);
    const sel = iface.getFunction('foo(uint256)')!.selector;
    const upper = (sel.slice(0, 3) + sel.slice(3).toUpperCase()) as typeof sel;
    const abiJson = JSON.stringify(OVERLOADED_ABI);
    const seen: { requested: string; normalized: string }[] = [];
    lookupSelectorFromUserAbi(upper, abiJson, {
      onNonCanonicalSelector: (requested, normalized) => seen.push({ requested, normalized }),
    });
    expect(seen).toEqual([{ requested: upper, normalized: sel }]);
  });
});

describe('shouldFetchFourbyteAfterPriorMerge', () => {
  it('is true when Sourcify+OpenChain yield fewer than the skip threshold', () => {
    expect(shouldFetchFourbyteAfterPriorMerge(0)).toBe(true);
    expect(shouldFetchFourbyteAfterPriorMerge(SIGNATURE_LOOKUP_FOURBYTE_SKIP_MIN_PRIOR - 1)).toBe(true);
  });

  it('is false at or above the skip threshold', () => {
    expect(shouldFetchFourbyteAfterPriorMerge(SIGNATURE_LOOKUP_FOURBYTE_SKIP_MIN_PRIOR)).toBe(false);
    expect(shouldFetchFourbyteAfterPriorMerge(20)).toBe(false);
  });
});

describe('warmCache', () => {
  afterEach(() => {
    clearSelectorLookupCache();
    vi.unstubAllGlobals();
  });

  it('does not fetch when offlineMode is true', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await warmCache(['0xa9059cbb', '0xdeadbeef'], { offlineMode: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('lookupSelector', () => {
  afterEach(() => {
    clearSelectorLookupCache();
    vi.unstubAllGlobals();
  });

  it('returns [] for invalid selector without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(lookupSelector('0x1234567', { offlineMode: false })).resolves.toEqual([]);
    await expect(lookupSelector('not-hex', { offlineMode: false })).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('ignores signature-DB rows whose text signature does not hash to the requested selector', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (isSignatureDbLookupUrl(u)) {
          return {
            ok: true,
            json: async () => ({
              result: {
                function: {
                  '0xdeadbeef': [{ name: 'transfer(address,uint256)' }],
                },
              },
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    await expect(lookupSelector('0xdeadbeef', { offlineMode: false })).resolves.toEqual([]);
  });

  it('ignores 4byte rows whose text signature does not hash to the requested selector', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (isSignatureDbLookupUrl(u)) {
          return { ok: false, json: async () => ({}) };
        }
        if (u.includes('4byte.directory')) {
          return {
            ok: true,
            json: async () => ({
              results: [{ text_signature: 'transfer(address,uint256)' }],
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    await expect(lookupSelector('0xdeadbeef', { offlineMode: false })).resolves.toEqual([]);
  });

  it('accepts signature-DB rows when the text signature hashes to the requested selector', async () => {
    const textSig = 'zzUnbundledLookupTestFn_y7k3()';
    const sel = keccak256(toUtf8Bytes(textSig)).slice(0, 10).toLowerCase();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (isSignatureDbLookupUrl(u)) {
          return {
            ok: true,
            json: async () => ({
              result: {
                function: {
                  [sel]: [{ name: textSig }],
                },
              },
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const r = await lookupSelector(sel, { offlineMode: false });
    expect(r).toHaveLength(1);
    expect(r[0].textSignature).toBe(textSig);
    expect(r[0].source).toBe('sourcify');
  });

  it('dedupes the same text signature when multiple APIs return it (Sourcify wins over OpenChain)', async () => {
    const textSig = 'zzBothApisDupFn_m4k7()';
    const sel = keccak256(toUtf8Bytes(canonicalizeTextSignature(textSig)!)).slice(0, 10).toLowerCase();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (isSignatureDbLookupUrl(u)) {
          return {
            ok: true,
            json: async () => ({
              result: {
                function: {
                  [sel]: [{ name: textSig }],
                },
              },
            }),
          };
        }
        if (u.includes('4byte.directory')) {
          return {
            ok: true,
            json: async () => ({
              results: [{ text_signature: textSig }],
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const r = await lookupSelector(sel, { offlineMode: false });
    expect(r).toHaveLength(1);
    expect(r[0].source).toBe('sourcify');
  });

  it('concatenates signature DB then 4byte when texts differ but share a selector (alias)', async () => {
    const fromOpen = 'zzAliasMergeFn(uint256)';
    const fromFour = 'zzAliasMergeFn(uint)';
    const sel = keccak256(toUtf8Bytes(canonicalizeTextSignature(fromOpen)!)).slice(0, 10).toLowerCase();
    expect(sel).toBe(
      keccak256(toUtf8Bytes(canonicalizeTextSignature(fromFour)!)).slice(0, 10).toLowerCase(),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (isSignatureDbLookupUrl(u)) {
          return {
            ok: true,
            json: async () => ({
              result: {
                function: {
                  [sel]: [{ name: fromOpen }],
                },
              },
            }),
          };
        }
        if (u.includes('4byte.directory')) {
          return {
            ok: true,
            json: async () => ({
              results: [{ text_signature: fromFour }],
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const r = await lookupSelector(sel, { offlineMode: false });
    expect(r).toHaveLength(2);
    expect(r[0].textSignature).toBe(fromOpen);
    expect(r[1].textSignature).toBe(fromFour);
    expect(r[0].source).toBe('sourcify');
    expect(r[1].source).toBe('4byte');
  });

  it('invokes onError when OpenChain JSON does not match the schema', async () => {
    const errors: { source: string; err: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('openchain.xyz')) {
          return {
            ok: true,
            json: async () => ({ result: { function: { '0xdeadbeef': 'not-an-array' } } }),
          };
        }
        if (u.includes('4byte.sourcify.dev')) {
          return {
            ok: true,
            json: async () => ({ result: { function: {} } }),
          };
        }
        if (u.includes('4byte.directory')) {
          return { ok: false, json: async () => ({}) };
        }
        return { ok: false, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    await lookupSelector('0xdeadbeef', {
      offlineMode: false,
      onError: (source, err) => errors.push({ source, err }),
    });

    expect(errors.some((e) => e.source === 'openchain')).toBe(true);
  });

  it('retries Sourcify fetch on 503 then succeeds', async () => {
    const textSig = 'zzRetryTestFn_q9w2()';
    const sel = keccak256(toUtf8Bytes(textSig)).slice(0, 10).toLowerCase();
    let sourcifyHits = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('4byte.sourcify.dev')) {
          sourcifyHits += 1;
          if (sourcifyHits < 3) {
            return { ok: false, status: 503, json: async () => ({}) };
          }
          return {
            ok: true,
            json: async () => ({
              result: {
                function: {
                  [sel]: [{ name: textSig }],
                },
              },
            }),
          };
        }
        if (u.includes('openchain.xyz')) {
          return {
            ok: true,
            json: async () => ({ result: { function: {} } }),
          };
        }
        if (u.includes('4byte.directory')) {
          return { ok: false, json: async () => ({}) };
        }
        return { ok: false, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );

    const r = await lookupSelector(sel, { offlineMode: false });
    expect(r).toHaveLength(1);
    expect(r[0].textSignature).toBe(textSig);
    expect(sourcifyHits).toBe(3);
  });
});
