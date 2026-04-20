import { JsonRpcProvider } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEnsLookupCaches,
  reverseResolveEns,
  reverseResolveEnsDetailed,
} from './ensLookup.ts';

describe('reverseResolveEns', () => {
  beforeEach(() => {
    clearEnsLookupCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for zero address without RPC', async () => {
    await expect(
      reverseResolveEns('0x0000000000000000000000000000000000000000', { offlineMode: false }),
    ).resolves.toBe(null);
  });

  it('returns null in offline mode', async () => {
    await expect(
      reverseResolveEns('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', { offlineMode: true }),
    ).resolves.toBe(null);
  });

  it('returns null for invalid hex', async () => {
    await expect(reverseResolveEns('not-an-address', { offlineMode: false })).resolves.toBe(null);
  });

  it('uses settled cache: second call does not invoke lookupAddress again', async () => {
    const spy = vi.spyOn(JsonRpcProvider.prototype, 'lookupAddress').mockResolvedValue('vitalik.eth');
    const addr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    await reverseResolveEns(addr);
    await reverseResolveEns(addr);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries lookupAddress after failure then succeeds', async () => {
    const spy = vi
      .spyOn(JsonRpcProvider.prototype, 'lookupAddress')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('vitalik.eth');
    const addr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    await expect(reverseResolveEns(addr)).resolves.toBe('vitalik.eth');
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('reverseResolveEnsDetailed', () => {
  beforeEach(() => {
    clearEnsLookupCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns not_applicable when offline', async () => {
    await expect(
      reverseResolveEnsDetailed('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', { offlineMode: true }),
    ).resolves.toEqual({ status: 'not_applicable' });
  });

  it('returns invalid_reverse_record when resolver returns a non-ENS name', async () => {
    vi.spyOn(JsonRpcProvider.prototype, 'lookupAddress').mockResolvedValue('not..valid');
    await expect(
      reverseResolveEnsDetailed('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
    ).resolves.toMatchObject({ status: 'invalid_reverse_record', raw: 'not..valid' });
    await expect(reverseResolveEns('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).resolves.toBe(null);
  });

  it('returns no_reverse_record when lookupAddress resolves null on all RPCs', async () => {
    vi.spyOn(JsonRpcProvider.prototype, 'lookupAddress').mockResolvedValue(null);
    await expect(
      reverseResolveEnsDetailed('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
    ).resolves.toEqual({ status: 'no_reverse_record' });
  });
});
