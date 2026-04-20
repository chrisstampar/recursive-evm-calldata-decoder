import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import {
  getBundledSignaturesForTests,
  getContractRegistryEntry,
  iterateKnownContractRegistryRows,
  iterateStaticRegistryAddressLiterals,
} from './abiRegistry.ts';
import { CHAINS } from './chains.ts';
import {
  REGISTRY_SECURITY_WATCHLIST,
  registryMeetsWatchlistRisk,
} from './securityWatchlist.ts';

function expectedSelector(textSignature: string): string {
  return keccak256(toUtf8Bytes(textSignature)).slice(0, 10).toLowerCase();
}

describe('abiRegistry invariants', () => {
  it('validates every bundled selector against keccak256(textSignature)', () => {
    for (const sig of getBundledSignaturesForTests()) {
      expect(expectedSelector(sig.textSignature)).toBe(sig.selector.toLowerCase());
    }
  });

  it('rejects duplicate bundled rows with the same selector and identical textSignature', () => {
    const seen = new Set<string>();
    for (const sig of getBundledSignaturesForTests()) {
      const key = `${sig.selector.toLowerCase()}\0${sig.textSignature}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('ensures static registry address literals are valid and EIP-55–correct when mixed-case', () => {
    for (const { literal } of iterateStaticRegistryAddressLiterals()) {
      expect(literal).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const lower = literal.toLowerCase();
      expect(getAddress(lower)).toBeDefined();
      if (literal !== lower) {
        expect(() => getAddress(literal)).not.toThrow();
        expect(getAddress(literal)).toBe(literal);
      }
    }
  });

  it('has no duplicate normalized 20-byte addresses within the same chain (contracts)', () => {
    const byChain = new Map<number, Set<string>>();
    for (const { chainId, literal, kind } of iterateStaticRegistryAddressLiterals()) {
      if (kind !== 'contract-map-key' && kind !== 'contract-extra-address') continue;
      const norm = getAddress(literal.toLowerCase());
      let set = byChain.get(chainId);
      if (!set) {
        set = new Set();
        byChain.set(chainId, set);
      }
      expect(set.has(norm)).toBe(false);
      set.add(norm);
    }
  });

  it('has no duplicate normalized 20-byte addresses within the same chain (tokens)', () => {
    const byChain = new Map<number, Set<string>>();
    for (const { chainId, literal, kind } of iterateStaticRegistryAddressLiterals()) {
      if (kind !== 'token-map-key') continue;
      const norm = getAddress(literal.toLowerCase());
      let set = byChain.get(chainId);
      if (!set) {
        set = new Set();
        byChain.set(chainId, set);
      }
      expect(set.has(norm)).toBe(false);
      set.add(norm);
    }
  });

  it('validates implementationSlot values on marked proxies (32-byte hex)', () => {
    for (const { entry } of iterateKnownContractRegistryRows()) {
      if (!entry.isProxy) continue;
      const slot = entry.implementationSlot;
      expect(slot, `proxy ${entry.name} should declare implementationSlot`).toBeDefined();
      expect(slot!).toMatch(/^0x[0-9a-fA-F]{64}$/i);
    }
  });

  it('keeps security watchlist deployments in the registry at or above the listed sensitivity tier', () => {
    for (const row of REGISTRY_SECURITY_WATCHLIST) {
      const addr = getAddress(row.address.toLowerCase());
      const entry = getContractRegistryEntry(addr, row.chainId);
      expect(entry, `${row.note}: expected registry entry for ${addr} on chain ${row.chainId}`).toBeDefined();
      expect(
        registryMeetsWatchlistRisk(entry!.riskLevel, row.riskLevel),
        `${row.note}: registry tier for ${addr} on ${row.chainId}`,
      ).toBe(true);
    }
  });

  it('security watchlist: valid addresses, unique keys, chains in app CHAINS config', () => {
    const seen = new Set<string>();
    for (const row of REGISTRY_SECURITY_WATCHLIST) {
      expect(row.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(() => getAddress(row.address.toLowerCase())).not.toThrow();
      const checksummed = getAddress(row.address.toLowerCase());
      if (row.address !== row.address.toLowerCase()) {
        expect(getAddress(row.address)).toBe(row.address);
      }
      expect(CHAINS[row.chainId], `chain ${row.chainId}`).toBeDefined();

      const key = `${row.chainId}:${checksummed}`;
      expect(seen.has(key), `duplicate watchlist key ${key}`).toBe(false);
      seen.add(key);
    }
  });
});
