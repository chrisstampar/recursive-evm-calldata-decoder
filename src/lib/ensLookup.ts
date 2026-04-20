import { getAddress, isValidName, JsonRpcProvider } from 'ethers';
import { LRUCache } from 'lru-cache';
import { CHAINS } from './chains.ts';

const ENS_LOOKUP_CHAIN_ID = 1;
const ENS_LOOKUP_TIMEOUT_MS = 6000;
const ENS_SETTLED_CACHE_TTL_MS = 5 * 60 * 1000;
const ENS_RPC_FAIL_CACHE_TTL_MS = 45_000;
const ENS_SETTLED_CACHE_MAX = 256;
const ENS_PER_RPC_ATTEMPTS = 3;
const ENS_RETRY_BASE_DELAY_MS = 200;
const ENS_RETRY_MAX_DELAY_MS = 3000;

const ZERO_LOWER = '0x0000000000000000000000000000000000000000';

export type EnsReverseResolveStatus =
  | { status: 'resolved'; name: string }
  | { status: 'no_reverse_record' }
  | { status: 'rpc_unavailable' }
  | { status: 'invalid_reverse_record'; raw: string }
  | { status: 'not_applicable' };

type EnsSettledEntry =
  | { kind: 'name'; name: string }
  | { kind: 'no_reverse' }
  | { kind: 'rpc_failed' }
  | { kind: 'invalid'; raw: string };

const ensSettledCache = new LRUCache<string, EnsSettledEntry>({
  max: ENS_SETTLED_CACHE_MAX,
  ttl: ENS_SETTLED_CACHE_TTL_MS,
  ttlAutopurge: true,
  updateAgeOnGet: true,
});

const ensLookupPromises = new Map<string, Promise<EnsReverseResolveStatus>>();

const jsonRpcProviderByUrl = new Map<string, JsonRpcProvider>();

function getEnsProvider(rpcUrl: string): JsonRpcProvider {
  let p = jsonRpcProviderByUrl.get(rpcUrl);
  if (p === undefined) {
    p = new JsonRpcProvider(rpcUrl, ENS_LOOKUP_CHAIN_ID, { staticNetwork: true });
    jsonRpcProviderByUrl.set(rpcUrl, p);
  }
  return p;
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, rej) => {
    setTimeout(() => rej(new Error('timeout')), ms);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function ensBackoffDelayMs(attemptIndex: number): number {
  const exp = ENS_RETRY_BASE_DELAY_MS * 2 ** attemptIndex;
  return Math.min(exp, ENS_RETRY_MAX_DELAY_MS);
}

function settledEntryToStatus(entry: EnsSettledEntry): EnsReverseResolveStatus {
  switch (entry.kind) {
    case 'name':
      return { status: 'resolved', name: entry.name };
    case 'no_reverse':
      return { status: 'no_reverse_record' };
    case 'invalid':
      return { status: 'invalid_reverse_record', raw: entry.raw };
    case 'rpc_failed':
      return { status: 'rpc_unavailable' };
  }
}

function applySettledCache(result: EnsReverseResolveStatus, key: string): void {
  switch (result.status) {
    case 'resolved':
      ensSettledCache.set(key, { kind: 'name', name: result.name }, { ttl: ENS_SETTLED_CACHE_TTL_MS });
      break;
    case 'no_reverse_record':
      ensSettledCache.set(key, { kind: 'no_reverse' }, { ttl: ENS_SETTLED_CACHE_TTL_MS });
      break;
    case 'invalid_reverse_record':
      ensSettledCache.set(key, { kind: 'invalid', raw: result.raw }, { ttl: ENS_SETTLED_CACHE_TTL_MS });
      break;
    case 'rpc_unavailable':
      ensSettledCache.set(key, { kind: 'rpc_failed' }, { ttl: ENS_RPC_FAIL_CACHE_TTL_MS });
      break;
    case 'not_applicable':
      break;
  }
}

async function lookupEnsOnMainnetDetailed(
  checksummed: string,
  signal: AbortSignal | undefined,
): Promise<EnsReverseResolveStatus> {
  const chain = CHAINS[ENS_LOOKUP_CHAIN_ID];
  if (!chain?.rpcs?.length) return { status: 'rpc_unavailable' };

  let receivedResolverResponse = false;

  outer: for (const rpcUrl of chain.rpcs) {
    throwIfAborted(signal);
    const provider = getEnsProvider(rpcUrl);

    for (let attempt = 0; attempt < ENS_PER_RPC_ATTEMPTS; attempt++) {
      throwIfAborted(signal);
      try {
        const name = await Promise.race([
          provider.lookupAddress(checksummed) as Promise<string | null>,
          rejectAfter(ENS_LOOKUP_TIMEOUT_MS),
        ]);
        receivedResolverResponse = true;
        if (typeof name === 'string' && name.trim().length > 0) {
          const trimmed = name.trim();
          if (!isValidName(trimmed)) {
            return { status: 'invalid_reverse_record', raw: trimmed };
          }
          return { status: 'resolved', name: trimmed };
        }
        continue outer;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        if (attempt < ENS_PER_RPC_ATTEMPTS - 1) {
          await sleep(ensBackoffDelayMs(attempt), signal);
        }
      }
    }
  }

  if (receivedResolverResponse) return { status: 'no_reverse_record' };
  return { status: 'rpc_unavailable' };
}

function getEnsResolvePromise(
  key: string,
  checksummed: string,
  signal: AbortSignal | undefined,
): Promise<EnsReverseResolveStatus> {
  const cached = ensSettledCache.get(key);
  if (cached !== undefined) {
    return Promise.resolve(settledEntryToStatus(cached));
  }

  let pending = ensLookupPromises.get(key);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const st = await lookupEnsOnMainnetDetailed(checksummed, signal);
        applySettledCache(st, key);
        return st;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        const st: EnsReverseResolveStatus = { status: 'rpc_unavailable' };
        applySettledCache(st, key);
        return st;
      }
    })();
    void pending.finally(() => {
      ensLookupPromises.delete(key);
    });
    ensLookupPromises.set(key, pending);
  }
  return pending;
}

/**
 * Reverse-resolve an Ethereum address to its primary ENS name via **Ethereum mainnet** RPC.
 * Returns a discriminated status (no reverse vs RPC failure vs invalid resolver value vs skipped input).
 */
export async function reverseResolveEnsDetailed(
  checksummedOrRaw: string,
  opts?: { offlineMode?: boolean; signal?: AbortSignal },
): Promise<EnsReverseResolveStatus> {
  if (opts?.offlineMode) return { status: 'not_applicable' };
  throwIfAborted(opts?.signal);

  let checksummed: string;
  try {
    checksummed = getAddress(checksummedOrRaw);
  } catch {
    return { status: 'not_applicable' };
  }

  if (checksummed.toLowerCase() === ZERO_LOWER) return { status: 'not_applicable' };

  const key = checksummed.toLowerCase();
  return getEnsResolvePromise(key, checksummed, opts?.signal);
}

/**
 * Reverse-resolve an Ethereum address to its primary ENS name via **Ethereum mainnet** RPC.
 * Uses a shared in-flight map plus a short-lived settled LRU cache so duplicate addresses dedupe across decoder and UI.
 *
 * Explorer links for other chains still use the selected chain; ENS reverse records live on L1.
 */
export async function reverseResolveEns(
  checksummedOrRaw: string,
  opts?: { offlineMode?: boolean; signal?: AbortSignal },
): Promise<string | null> {
  const st = await reverseResolveEnsDetailed(checksummedOrRaw, opts);
  return st.status === 'resolved' ? st.name : null;
}

/** Clears settled cache, in-flight dedupe, and reused providers (tests). */
export function clearEnsLookupCaches(): void {
  ensSettledCache.clear();
  ensLookupPromises.clear();
  for (const p of jsonRpcProviderByUrl.values()) {
    try {
      p.destroy();
    } catch {
      /* ignore */
    }
  }
  jsonRpcProviderByUrl.clear();
}
