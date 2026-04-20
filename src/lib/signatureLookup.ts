import { keccak256, toUtf8Bytes, Interface, type FunctionFragment } from 'ethers';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import type { FunctionSignature, HexSelector, SignatureSource } from '../types/index.ts';
import { lookupBundledSelector } from './abiRegistry.ts';
import { isValidFunctionSelector } from './sanitize.ts';
import { validateTextSignature, parseTextSignature, canonicalizeTextSignature } from './signatureValidator.ts';

const API_TIMEOUT_MS = 5000;

/** Transient HTTP statuses worth retrying before giving up. */
const FETCH_RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

const API_FETCH_MAX_ATTEMPTS = 3;

/** Exponential backoff base between attempts (skipped in Vitest for speed). */
const API_RETRY_BASE_DELAY_MS = import.meta.env.MODE === 'test' ? 0 : 400;

/**
 * If Sourcify + OpenChain yield at least this many **deduped** candidates (by `textSignature`),
 * skip 4byte.directory (slow / noisy) and merge only the two signature-DB sources.
 */
export const SIGNATURE_LOOKUP_FOURBYTE_SKIP_MIN_PRIOR = 5;

/** Max concurrent `lookupSelector` calls per {@link warmCache} batch (reduces burst rate limits). */
const WARM_CACHE_CHUNK_SIZE = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @internal Exported for unit tests (prior-merge gate for 4byte). */
export function shouldFetchFourbyteAfterPriorMerge(priorDedupedCount: number): boolean {
  return priorDedupedCount < SIGNATURE_LOOKUP_FOURBYTE_SKIP_MIN_PRIOR;
}

/** OpenChain-compatible JSON shape (also used by Sourcify 4byte API). */
const SignatureDatabaseLookupResponseSchema = z.object({
  result: z
    .object({
      function: z.record(
        z.string(),
        z.union([z.array(z.object({ name: z.string() })), z.null()]),
      ),
    })
    .optional(),
});

const FourbyteResponseSchema = z.object({
  results: z.array(z.object({ text_signature: z.string() })).optional(),
});

/** @see https://api.openchain.xyz — legacy host; response shape matches Sourcify below. */
const OPENCHAIN_SIGNATURE_DB_LOOKUP = 'https://api.openchain.xyz/signature-database/v1/lookup';
/**
 * Sourcify-hosted OpenChain-compatible lookup (verified + aggregated DB).
 * Path is `/signature-database/v1/lookup` (not `/v1/lookup`).
 * @see https://docs.sourcify.dev/docs/repository/signature-database/
 */
const SOURCIFY_SIGNATURE_DB_LOOKUP = 'https://api.4byte.sourcify.dev/signature-database/v1/lookup';

/** TTL for cached OpenChain/Sourcify/4byte merge results (bundled hits are not cached here). */
const API_LOOKUP_CACHE_TTL_MS = 1000 * 60 * 15;

/**
 * Bump when bundled signatures change so stale merged API rows are not reused under old keys.
 * (Bundled rows are read live from the registry; this only invalidates API cache entries.)
 */
export const SIGNATURE_LOOKUP_CACHE_VERSION = 1;

/** Max characters for pasted user ABI JSON (DoS guard before `JSON.parse` / `Interface`). */
export const MAX_USER_ABI_JSON_CHARS = 500_000;

const SELECTOR_LOOKUP_CACHE = new LRUCache<string, FunctionSignature[]>({
  max: 512,
  ttl: API_LOOKUP_CACHE_TTL_MS,
  ttlAutopurge: true,
  updateAgeOnGet: true,
});

const USER_ABI_INTERFACE_CACHE = new LRUCache<string, Interface>({
  max: 32,
  ttl: 1000 * 60 * 60,
  ttlAutopurge: true,
  updateAgeOnGet: true,
});

function apiCacheKey(selector: string): string {
  return `${SIGNATURE_LOOKUP_CACHE_VERSION}:${selector}`;
}

function cacheSetApiResults(selector: string, sigs: FunctionSignature[]): void {
  SELECTOR_LOOKUP_CACHE.set(apiCacheKey(selector), sigs, { ttl: API_LOOKUP_CACHE_TTL_MS });
}

function cacheGetApiResults(selector: string): FunctionSignature[] | undefined {
  return SELECTOR_LOOKUP_CACHE.get(apiCacheKey(selector));
}

/** Clears selector API LRU and parsed user-ABI `Interface` LRU (tests). */
export function clearSelectorLookupCache(): void {
  SELECTOR_LOOKUP_CACHE.clear();
  USER_ABI_INTERFACE_CACHE.clear();
}

function abiJsonCacheKey(abiJson: string): string {
  return keccak256(toUtf8Bytes(abiJson)).slice(2);
}

/**
 * Parse ABI JSON once; reuse `Interface` for repeated lookups with the same paste (LRU keyed by `keccak256(abiJson)`).
 * Also used by {@link decodeWithUserAbi} when no `iface` override is passed.
 */
export function getCachedUserAbiInterface(abiJson: string): Interface | null {
  const key = abiJsonCacheKey(abiJson);
  const hit = USER_ABI_INTERFACE_CACHE.get(key);
  if (hit) return hit;
  try {
    const abi = JSON.parse(abiJson) as ReadonlyArray<string>;
    const iface = new Interface(abi);
    USER_ABI_INTERFACE_CACHE.set(key, iface);
    return iface;
  } catch {
    return null;
  }
}

/** Options for {@link lookupSelector}. */
export interface LookupOptions {
  offlineMode: boolean;
  /** `source` is `openchain`, `sourcify`, or `4byte`. */
  onError?: (source: string, error: unknown) => void;
}

/**
 * Prewarm the selector LRU by resolving signatures (network unless `offlineMode`).
 * Runs lookups in chunks of eight at a time to limit parallel API bursts.
 */
export async function warmCache(
  selectors: string[],
  options: LookupOptions = { offlineMode: false },
): Promise<void> {
  for (let i = 0; i < selectors.length; i += WARM_CACHE_CHUNK_SIZE) {
    const chunk = selectors.slice(i, i + WARM_CACHE_CHUNK_SIZE);
    await Promise.all(chunk.map((s) => lookupSelector(s, options)));
  }
}

/**
 * Merge API batches in order; drop duplicate `textSignature` (case-insensitive), keeping the first.
 * In dev, logs when a later source repeats the same text as an earlier one for the same selector.
 */
function dedupeApiSignaturesByTextSignature(
  selectorHex: string,
  batches: FunctionSignature[][],
): FunctionSignature[] {
  const seen = new Set<string>();
  const out: FunctionSignature[] = [];
  for (const batch of batches) {
    for (const sig of batch) {
      const key = sig.textSignature.trim().toLowerCase();
      if (seen.has(key)) {
        if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
          console.debug(
            `[signatureLookup] duplicate text_signature dropped for selector ${selectorHex} (${sig.source}): ${key}`,
          );
        }
        continue;
      }
      seen.add(key);
      out.push(sig);
    }
  }
  return out;
}

async function fetchWithTimeout(url: string, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Like {@link fetchWithTimeout} but retries on network errors, timeouts, and retryable HTTP statuses.
 * Does not retry after a successful HTTP response with parseable body handling (caller's job).
 */
async function fetchWithTimeoutAndRetries(url: string, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < API_FETCH_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(API_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
    try {
      const resp = await fetchWithTimeout(url, timeoutMs);
      if (resp.ok) return resp;
      if (FETCH_RETRYABLE_STATUS.has(resp.status) && attempt < API_FETCH_MAX_ATTEMPTS - 1) {
        continue;
      }
      return resp;
    } catch (e) {
      lastError = e;
      if (attempt < API_FETCH_MAX_ATTEMPTS - 1) continue;
      throw e;
    }
  }
  throw lastError ?? new Error('fetchWithTimeoutAndRetries: exhausted');
}

function textSigToFunctionSignature(
  textSig: string,
  source: SignatureSource,
  /** Lower index = higher assumed popularity (API result order). */
  rankIndex = 0,
): FunctionSignature | null {
  if (!validateTextSignature(textSig).valid) return null;

  const parsed = parseTextSignature(textSig);
  if (!parsed) return null;

  const canonical = canonicalizeTextSignature(textSig) ?? textSig;
  const selector = keccak256(toUtf8Bytes(canonical)).slice(0, 10);

  return {
    selector: selector as HexSelector,
    name: parsed.name,
    textSignature: textSig,
    params: parsed.paramTypes.map((type, i) => ({ name: `arg${i}`, type })),
    source,
    popularity: Math.max(0, 95 - rankIndex * 15),
  };
}

export async function initEthers(): Promise<void> {
  // no-op: ethers is now statically imported
}

/** OpenChain-compatible `/signature-database/v1/lookup?function=` response. */
async function lookupSignatureDatabaseLookup(
  source: 'openchain' | 'sourcify',
  baseUrl: string,
  selector: string,
  onError?: LookupOptions['onError'],
): Promise<FunctionSignature[]> {
  try {
    const url = `${baseUrl}?function=${encodeURIComponent(selector)}`;
    const resp = await fetchWithTimeoutAndRetries(url);
    if (!resp.ok) {
      onError?.(source, new Error(`${source} HTTP ${resp.status}`));
      return [];
    }

    let raw: unknown;
    try {
      raw = await resp.json();
    } catch (err) {
      onError?.(source, err);
      return [];
    }

    const parsed = SignatureDatabaseLookupResponseSchema.safeParse(raw);
    if (!parsed.success) {
      onError?.(source, parsed.error);
      return [];
    }

    const entries = parsed.data.result?.function?.[selector];
    if (!entries || !Array.isArray(entries)) return [];

    const results: FunctionSignature[] = [];
    for (let i = 0; i < entries.length; i++) {
      const sig = textSigToFunctionSignature(entries[i].name, source, i);
      if (!sig) continue;
      if (sig.selector.toLowerCase() !== selector) continue;
      sig.selector = selector as HexSelector;
      results.push(sig);
    }
    return results;
  } catch (err) {
    onError?.(source, err);
    return [];
  }
}

async function lookup4byte(
  selector: string,
  onError?: LookupOptions['onError'],
): Promise<FunctionSignature[]> {
  try {
    const resp = await fetchWithTimeoutAndRetries(
      `https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}&ordering=created_at`,
    );
    if (!resp.ok) {
      onError?.('4byte', new Error(`4byte HTTP ${resp.status}`));
      return [];
    }

    let raw: unknown;
    try {
      raw = await resp.json();
    } catch (err) {
      onError?.('4byte', err);
      return [];
    }

    const parsed = FourbyteResponseSchema.safeParse(raw);
    if (!parsed.success) {
      onError?.('4byte', parsed.error);
      return [];
    }

    const rows = parsed.data.results ?? [];
    const results: FunctionSignature[] = [];
    for (let i = 0; i < rows.length; i++) {
      const sig = textSigToFunctionSignature(rows[i].text_signature, '4byte', i);
      if (!sig) continue;
      if (sig.selector.toLowerCase() !== selector) continue;
      sig.selector = selector as HexSelector;
      results.push(sig);
    }
    return results;
  } catch (err) {
    onError?.('4byte', err);
    return [];
  }
}

/**
 * Resolve a function selector to candidate signatures.
 *
 * On cache miss, Sourcify and OpenChain are fetched in parallel. If the merged list has fewer than
 * {@link SIGNATURE_LOOKUP_FOURBYTE_SKIP_MIN_PRIOR} distinct `textSignature` values, 4byte.directory
 * is queried as well (then merged; Sourcify/OpenChain stay first for dedupe priority). HTTP fetches
 * use brief retries with exponential backoff for transient failures.
 *
 * Stale-while-revalidate is not implemented: a future option is `lru-cache` `fetchMethod` + `allowStale`
 * to return TTL-expired entries while refreshing in the background.
 */
export async function lookupSelector(
  selector: string,
  options: LookupOptions,
): Promise<FunctionSignature[]> {
  if (!isValidFunctionSelector(selector)) {
    return [];
  }
  const normalizedSelector = selector.trim().toLowerCase();

  const cachedApi = cacheGetApiResults(normalizedSelector);
  if (cachedApi !== undefined) return cachedApi;

  const bundled = lookupBundledSelector(normalizedSelector);
  if (bundled.length > 0) {
    // Bundled registry is authoritative and in-memory; do not TTL-cache (always fresh).
    return bundled;
  }

  if (options.offlineMode) return [];

  const onError = options.onError;
  // Sourcify first in merge order so verified/aggregated DB wins on duplicate text with OpenChain.
  const [sourcify, openchain] = await Promise.all([
    lookupSignatureDatabaseLookup('sourcify', SOURCIFY_SIGNATURE_DB_LOOKUP, normalizedSelector, onError),
    lookupSignatureDatabaseLookup('openchain', OPENCHAIN_SIGNATURE_DB_LOOKUP, normalizedSelector, onError),
  ]);
  const priorDeduped = dedupeApiSignaturesByTextSignature(normalizedSelector, [sourcify, openchain]);
  let fourByte: FunctionSignature[] = [];
  if (shouldFetchFourbyteAfterPriorMerge(priorDeduped.length)) {
    fourByte = await lookup4byte(normalizedSelector, onError);
  }
  const merged = dedupeApiSignaturesByTextSignature(normalizedSelector, [sourcify, openchain, fourByte]);
  cacheSetApiResults(normalizedSelector, merged);
  return merged;
}

export interface LookupSelectorFromUserAbiOptions {
  /**
   * Invoked when the selector string is normalized (trim + lowercase), e.g. `0xA9059CBB` → `0xa9059cbb`.
   * Function selectors are not EIP-55 checksummed; this is mainly for observability.
   */
  onNonCanonicalSelector?: (requested: string, normalized: string) => void;
}

export function lookupSelectorFromUserAbi(
  selector: string,
  abiJson: string,
  options?: LookupSelectorFromUserAbiOptions,
): FunctionSignature[] {
  if (!isValidFunctionSelector(selector)) {
    return [];
  }
  const trimmed = selector.trim();
  const normalizedSelector = trimmed.toLowerCase();
  if (options?.onNonCanonicalSelector && trimmed !== normalizedSelector) {
    options.onNonCanonicalSelector(trimmed, normalizedSelector);
  }

  if (abiJson.length > MAX_USER_ABI_JSON_CHARS) {
    return [];
  }
  const iface = getCachedUserAbiInterface(abiJson);
  if (!iface) return [];

  try {
    const results: FunctionSignature[] = [];
    for (const fragment of iface.fragments) {
      if (fragment.type === 'function') {
        const fnFragment = fragment as FunctionFragment;
        // Per-fragment selector — do not use getFunction(name), which returns the first overload only.
        const fnSelector = fnFragment.selector;
        if (fnSelector.toLowerCase() === normalizedSelector) {
          results.push({
            selector: normalizedSelector as HexSelector,
            name: fnFragment.name,
            textSignature: fnFragment.format('sighash'),
            params: fnFragment.inputs.map((i, idx) => ({
              name: i.name || `arg${idx}`,
              type: i.type,
            })),
            source: 'user-abi',
            popularity: Math.max(0, 100 - results.length * 12),
          });
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}
