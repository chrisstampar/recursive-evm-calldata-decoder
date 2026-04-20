/**
 * Transaction calldata fetch over **HTTP JSON-RPC** only. WebSocket / `eth_subscribe` is not implemented:
 * the UI loads txs on demand (paste hash), and browser WS to arbitrary RPCs often hits CORS, auth, and
 * keep-alive complexity for limited gain versus one-shot `eth_getTransactionByHash`.
 */
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import { getChain, DEFAULT_CHAIN_ID } from './chains';

/** From `vite.config.ts` `define` → package.json `version`. */
const APP_VERSION = __PACKAGE_VERSION__;

const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS_PER_ENDPOINT = 3;
const RETRY_BASE_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 8_000;
const DEFAULT_RPC_STAGGER_MS = 25;
/** Cap `index * rpcStaggerMs` so late endpoints are not delayed unnecessarily when earlier RPCs may run for the full timeout. */
const MAX_RPC_STAGGER_OFFSET_MS = 60;
const TX_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;

/** After {@link MAX_ATTEMPTS_PER_ENDPOINT} failed attempts on one endpoint, skip it until this window elapses. */
const DEFAULT_ENDPOINT_CIRCUIT_OPEN_MS = 30_000;

let endpointCircuitOpenMs = DEFAULT_ENDPOINT_CIRCUIT_OPEN_MS;

/** @internal Vitest only — short window so circuit tests need no fake timers. */
export function setTxFetcherCircuitOpenMsForTests(ms: number): void {
  if (import.meta.env.MODE !== 'test') {
    throw new Error('setTxFetcherCircuitOpenMsForTests is only available in test mode');
  }
  endpointCircuitOpenMs = ms;
}

/** @internal Vitest — restore production default and clear open circuits. */
export function resetTxFetcherCircuitConfigForTests(): void {
  if (import.meta.env.MODE !== 'test') return;
  endpointCircuitOpenMs = DEFAULT_ENDPOINT_CIRCUIT_OPEN_MS;
  endpointCircuitOpenUntil.clear();
}

/** Max `eth_getTransactionByHash` calls in one JSON-RPC batch (DoS / payload size guard). */
const MAX_BATCH_TX_LOOKUP = 32;

const TX_INFO_CACHE_MAX = 64;
const TX_INFO_CACHE_TTL_MS = 60_000;

const txInfoCache = new LRUCache<string, TxInfo>({
  max: TX_INFO_CACHE_MAX,
  ttl: TX_INFO_CACHE_TTL_MS,
});

/** `endpoint` URL → epoch ms when the circuit closes (exclusive of calls before then). */
const endpointCircuitOpenUntil = new Map<string, number>();

function isEndpointCircuitOpen(endpoint: string): boolean {
  const until = endpointCircuitOpenUntil.get(endpoint);
  if (until == null) return false;
  if (Date.now() >= until) {
    endpointCircuitOpenUntil.delete(endpoint);
    return false;
  }
  return true;
}

function tripEndpointCircuit(endpoint: string): void {
  endpointCircuitOpenUntil.set(endpoint, Date.now() + endpointCircuitOpenMs);
}

function clearEndpointCircuit(endpoint: string): void {
  endpointCircuitOpenUntil.delete(endpoint);
}

/** Clears per-RPC circuit state (e.g. tests). Does not reset {@link setTxFetcherCircuitOpenMsForTests}. */
export function clearTxFetcherEndpointCircuits(): void {
  endpointCircuitOpenUntil.clear();
}

/** Thrown when an RPC URL is temporarily skipped after repeated failures ({@link ENDPOINT_CIRCUIT_OPEN_MS}). */
export class RpcEndpointCircuitOpenError extends Error {
  override readonly name = 'RpcEndpointCircuitOpenError';
  readonly endpoint: string;
  constructor(endpoint: string) {
    super(
      `RPC endpoint temporarily skipped after repeated failures (retry after ~${Math.ceil(endpointCircuitOpenMs / 1000)}s).`,
    );
    this.endpoint = endpoint;
  }
}

function buildRpcHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    // `Origin` and often `User-Agent` cannot be set from browser JS (forbidden headers). `X-Client` is always sent.
    'User-Agent': `RecDec/${APP_VERSION} (EVM transaction calldata fetch)`,
    'X-Client': `RecDec/${APP_VERSION}`,
  };
}

/** JSON-RPC 2.0 response body: only `error` / `result` are interpreted; other keys allowed. */
const jsonRpcEnvelopeSchema = z
  .object({
    error: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

const rpcErrorObjectSchema = z
  .object({
    message: z.string().optional(),
  })
  .passthrough();

const jsonRpcBatchItemSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    error: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

const ethTransactionSchema = z
  .object({
    input: z.string(),
    to: z.union([z.string(), z.null()]),
    from: z.string(),
    value: z.string(),
    blockNumber: z.union([z.string(), z.null()]),
  })
  .passthrough();

type EthTransaction = z.infer<typeof ethTransactionSchema>;

interface RpcCallContext {
  endpoint: string;
  timeoutMs: number;
  rpcHeaders: Record<string, string>;
  signal: AbortSignal;
  /** When false, null `getTransactionByHash` does not call `getTransactionReceipt`. */
  receiptProbeOnNull: boolean;
}

/** Transient failure: same endpoint may succeed after backoff (429, 5xx, network, bad JSON). */
class RetryableRpcError extends Error {
  override readonly name = 'RetryableRpcError';
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * `eth_getTransactionByHash` returned `null` and `eth_getTransactionReceipt` did not show a mined receipt
 * on this endpoint (unknown hash, mempool-only view, or lag). Not the same as {@link TxIndexingLagError}.
 */
export class TxNotFoundError extends Error {
  override readonly name = 'TxNotFoundError';
  constructor(message?: string) {
    super(
      message ??
        'Transaction not found on this RPC: no transaction body and no receipt. The hash may be wrong, the tx may still be pending, or nodes may not have indexed it yet.',
    );
  }
}

/**
 * Mined transaction: receipt exists but `eth_getTransactionByHash` returned `null` (indexing / pruning lag on this node).
 */
export class TxIndexingLagError extends Error {
  override readonly name = 'TxIndexingLagError';
  constructor(message?: string) {
    super(
      message ??
        'This transaction looks mined (receipt found) but the full transaction is not available from this RPC yet. Retry shortly or switch endpoint.',
    );
  }
}

export interface TxInfo {
  /** Same hex as user input after trim (EIP-55 / casing preserved); RPC uses lowercase. */
  hash: string;
  calldata: string;
  from: string;
  to: string | null;
  value: string;
  isPending: boolean;
}

/** Fields passed to the decoder UI when a tx hash fetch produced the calldata (e.g. native-transfer detection). */
export type TxFetchContext = Pick<TxInfo, 'hash' | 'from' | 'to' | 'value' | 'isPending'>;

export interface FetchTxCalldataOptions {
  /** Bypass {@link txInfoCache} (e.g. tests or explicit refresh). */
  skipCache?: boolean;
  /**
   * After null `eth_getTransactionByHash`, call `eth_getTransactionReceipt` to distinguish indexing lag vs missing tx.
   * When false, saves one RPC per endpoint on misses (see `ChainConfig.receiptProbeOnNullTx`).
   */
  receiptProbeOnNull?: boolean;
  /**
   * When aborted, in-flight RPC work stops; callers should ignore stale results (e.g. user switched chain).
   * Wired through {@link fetchWithTimeout}: linked to the per-request timeout `AbortController`, so both
   * timeout and this signal abort the underlying `fetch`.
   */
  signal?: AbortSignal;
}

export function isValidTxHash(input: string): boolean {
  return TX_HASH_REGEX.test(input.trim());
}

/** Drop cached entries (e.g. after tests). Does not reset endpoint circuits. */
export function clearTxCalldataCache(): void {
  txInfoCache.clear();
}

function cacheKey(chainId: number, rpcHashLower: string): string {
  return `${chainId}:${rpcHashLower}`;
}

function parseJsonRpcEnvelope(json: unknown): z.infer<typeof jsonRpcEnvelopeSchema> {
  const r = jsonRpcEnvelopeSchema.safeParse(json);
  if (!r.success) {
    const detail =
      import.meta.env.DEV ? `: ${r.error.message}` : '';
    throw new Error(`Invalid JSON-RPC response body${detail}`);
  }
  return r.data;
}

function rpcErrorUserMessage(errorField: unknown): string | null {
  const r = rpcErrorObjectSchema.safeParse(errorField);
  if (!r.success || r.data.message === undefined) return null;
  return r.data.message;
}

function parseEthTransactionResult(result: unknown): EthTransaction {
  const r = ethTransactionSchema.safeParse(result);
  if (!r.success) {
    const detail = import.meta.env.DEV ? ` (${r.error.message})` : '';
    throw new Error(`Malformed transaction object from RPC${detail}`);
  }
  return r.data;
}

function hasJsonContentType(resp: Response): boolean {
  const ct = resp.headers.get('content-type') ?? '';
  return ct.toLowerCase().includes('application/json');
}

function isRetryableHttpStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function parseRetryAfterMs(resp: Response): number | null {
  const raw = resp.headers.get('retry-after')?.trim();
  if (!raw) return null;
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec < 0) return null;
  return Math.min(Math.round(sec * 1000), MAX_RETRY_DELAY_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffDelayMs(attemptIndex: number, retryAfterMs?: number): number {
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  }
  const exp = RETRY_BASE_DELAY_MS * 2 ** attemptIndex;
  return Math.min(exp, MAX_RETRY_DELAY_MS);
}

/**
 * POST JSON-RPC to `url` with `timeoutMs` ceiling. `outerSignal` (e.g. from {@link fetchTxCalldata} options)
 * aborts the same `fetch` by aborting the internal controller when the outer signal fires.
 */
async function fetchWithTimeout(
  url: string,
  body: string,
  timeoutMs: number,
  rpcHeaders: Record<string, string>,
  outerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) {
      clearTimeout(id);
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await fetch(url, {
      method: 'POST',
      headers: rpcHeaders,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(id);
    if (outerSignal && !outerSignal.aborted) {
      outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }
}

function txInfoFromResult(tx: EthTransaction, displayHash: string): TxInfo {
  const rawInput = tx.input?.trim() ?? '';
  const calldata = rawInput === '' || rawInput === '0x' ? '0x' : rawInput;
  return {
    hash: displayHash,
    calldata,
    from: tx.from,
    to: tx.to,
    value: tx.value,
    isPending: tx.blockNumber === null,
  };
}

/**
 * When `getTransactionByHash` is `null`, a present receipt implies the tx is mined but the tx payload is not
 * served yet (lag). Absent receipt is inconclusive (pending, bad hash, or not indexed).
 */
async function receiptLooksMined(
  txHash: string,
  ctx: RpcCallContext,
): Promise<boolean> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'eth_getTransactionReceipt',
    params: [txHash],
    id: 2,
  });
  let resp: Response;
  try {
    resp = await fetchWithTimeout(ctx.endpoint, body, ctx.timeoutMs, ctx.rpcHeaders, ctx.signal);
  } catch {
    return false;
  }
  if (!resp.ok) return false;
  if (!hasJsonContentType(resp)) return false;
  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    return false;
  }
  const env = jsonRpcEnvelopeSchema.safeParse(parsed);
  if (!env.success) return false;
  const d = env.data;
  if (d.error != null && d.error !== undefined) return false;
  if (!('result' in d)) return false;
  const res = d.result;
  return res !== null && typeof res === 'object' && !Array.isArray(res);
}

async function readTxFromSuccessfulResponse(
  resp: Response,
  displayHash: string,
  rpcHash: string,
  ctx: RpcCallContext,
): Promise<TxInfo> {
  if (!hasJsonContentType(resp)) {
    throw new Error('RPC response must be application/json (check Content-Type)');
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    throw new RetryableRpcError('Invalid JSON response from RPC');
  }

  const d = parseJsonRpcEnvelope(parsed);

  if (d.error != null && d.error !== undefined) {
    const msg = rpcErrorUserMessage(d.error);
    throw msg !== null ? new Error(msg) : new Error('Invalid JSON-RPC error payload from RPC');
  }

  if (!('result' in d)) {
    throw new Error('Missing result in JSON-RPC response');
  }

  if (d.result === null) {
    const mined = ctx.receiptProbeOnNull ? await receiptLooksMined(rpcHash, ctx) : false;
    if (mined) {
      throw new TxIndexingLagError();
    }
    throw new TxNotFoundError();
  }

  const tx = parseEthTransactionResult(d.result);
  return txInfoFromResult(tx, displayHash);
}

async function tryEndpointOnce(
  endpoint: string,
  rpcBody: string,
  displayHash: string,
  rpcHash: string,
  timeoutMs: number,
  rpcHeaders: Record<string, string>,
  outerSignal: AbortSignal,
  receiptProbeOnNull: boolean,
): Promise<TxInfo> {
  const ctx: RpcCallContext = {
    endpoint,
    timeoutMs,
    rpcHeaders,
    signal: outerSignal,
    receiptProbeOnNull,
  };
  let resp: Response;
  try {
    resp = await fetchWithTimeout(endpoint, rpcBody, timeoutMs, rpcHeaders, outerSignal);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw e;
    }
    throw new RetryableRpcError(e instanceof Error ? e.message : 'Network error while calling RPC');
  }

  if (!resp.ok) {
    if (isRetryableHttpStatus(resp.status)) {
      const ra = parseRetryAfterMs(resp);
      throw new RetryableRpcError(`HTTP ${resp.status} from RPC`, ra ?? undefined);
    }
    throw new Error(`HTTP ${resp.status} from RPC`);
  }

  return readTxFromSuccessfulResponse(resp, displayHash, rpcHash, ctx);
}

async function tryEndpointWithRetries(
  endpoint: string,
  rpcBody: string,
  displayHash: string,
  rpcHash: string,
  timeoutMs: number,
  rpcHeaders: Record<string, string>,
  outerSignal: AbortSignal,
  receiptProbeOnNull: boolean,
): Promise<TxInfo> {
  if (isEndpointCircuitOpen(endpoint)) {
    throw new RpcEndpointCircuitOpenError(endpoint);
  }

  let lastError: Error = new Error('RPC failed');

  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_ENDPOINT; attempt++) {
    try {
      const info = await tryEndpointOnce(
        endpoint,
        rpcBody,
        displayHash,
        rpcHash,
        timeoutMs,
        rpcHeaders,
        outerSignal,
        receiptProbeOnNull,
      );
      clearEndpointCircuit(endpoint);
      return info;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw e;
      }
      const err = e instanceof Error ? e : new Error(String(e));
      lastError = err;

      if (e instanceof TxNotFoundError || e instanceof TxIndexingLagError) {
        throw e;
      }

      if (attempt >= MAX_ATTEMPTS_PER_ENDPOINT - 1) {
        break;
      }

      if (!(e instanceof RetryableRpcError)) {
        throw e;
      }

      const delay = backoffDelayMs(attempt, e.retryAfterMs);
      try {
        await sleep(delay, outerSignal);
      } catch (sleepErr) {
        if (sleepErr instanceof DOMException && sleepErr.name === 'AbortError') {
          throw sleepErr;
        }
        throw sleepErr;
      }
    }
  }

  tripEndpointCircuit(endpoint);
  throw lastError;
}

function aggregateAllRejected(errors: unknown[], chainName: string): Error {
  const list = errors.map(e => (e instanceof Error ? e : new Error(String(e))));
  if (list.length === 0) {
    return new Error(`All ${chainName} RPC endpoints failed. Please try again later.`);
  }
  if (list.every(e => e instanceof RpcEndpointCircuitOpenError)) {
    return new Error(
      `All ${chainName} RPC endpoints are temporarily unavailable after repeated failures. Wait about ${Math.ceil(endpointCircuitOpenMs / 1000)}s and retry.`,
    );
  }
  if (list.every(e => e instanceof TxIndexingLagError)) {
    return new TxIndexingLagError();
  }
  if (list.every(e => e instanceof TxNotFoundError)) {
    return new TxNotFoundError();
  }
  return list[0] ?? new Error(`All ${chainName} RPC endpoints failed. Please try again later.`);
}

function coalesceJsonRpcId(id: unknown): number | null {
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  if (typeof id === 'string' && /^\d+$/.test(id)) return Number.parseInt(id, 10);
  return null;
}

/**
 * One JSON-RPC batch of `eth_getTransactionByHash`. Skips receipt probes on `null` results (callers fall back to
 * {@link fetchTxCalldata} if needed). Returns map keyed by **lowercase** tx hash hex.
 */
async function tryEndpointBatchGetTxInfos(
  endpoint: string,
  pairs: readonly { displayHash: string; rpcHash: string }[],
  timeoutMs: number,
  rpcHeaders: Record<string, string>,
  outerSignal: AbortSignal,
): Promise<Map<string, TxInfo>> {
  const out = new Map<string, TxInfo>();
  if (pairs.length === 0) return out;
  if (isEndpointCircuitOpen(endpoint)) return out;

  const batch = pairs.map((p, i) => ({
    jsonrpc: '2.0' as const,
    id: i + 1,
    method: 'eth_getTransactionByHash' as const,
    params: [p.rpcHash] as const,
  }));

  let resp: Response;
  try {
    resp = await fetchWithTimeout(endpoint, JSON.stringify(batch), timeoutMs, rpcHeaders, outerSignal);
  } catch {
    return out;
  }

  if (!resp.ok || !hasJsonContentType(resp)) return out;

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    return out;
  }

  const arr = z.array(jsonRpcBatchItemSchema).safeParse(parsed);
  if (!arr.success) return out;

  for (const item of arr.data) {
    const idNum = coalesceJsonRpcId(item.id);
    if (idNum == null || idNum < 1 || idNum > pairs.length) continue;
    const { displayHash, rpcHash } = pairs[idNum - 1]!;

    if (item.error != null && item.error !== undefined) continue;
    if (!('result' in item)) continue;
    if (item.result === null) continue;

    try {
      const tx = parseEthTransactionResult(item.result);
      out.set(rpcHash, txInfoFromResult(tx, displayHash));
    } catch {
      continue;
    }
  }

  return out;
}

/**
 * Best-effort cache warming for multiple tx hashes (e.g. multicall follow-ups). Uses one JSON-RPC **batch** request on
 * the first non-tripped RPC when there are ≥2 hashes, then `fetchTxCalldata` for any misses (failures are ignored).
 */
export async function prefetchTxCalldata(
  hashes: readonly string[],
  chainId: number = DEFAULT_CHAIN_ID,
  options?: FetchTxCalldataOptions,
): Promise<void> {
  if (hashes.length === 0) return;
  const chain = getChain(chainId);
  const resolvedChainId = chain.id;

  const pending: { displayHash: string; rpcHash: string }[] = [];
  const seen = new Set<string>();
  for (const raw of hashes) {
    const displayHash = raw.trim();
    if (!TX_HASH_REGEX.test(displayHash)) continue;
    const rpcHash = displayHash.toLowerCase();
    if (seen.has(rpcHash)) continue;
    seen.add(rpcHash);
    const ck = cacheKey(resolvedChainId, rpcHash);
    if (!options?.skipCache && txInfoCache.get(ck)) continue;
    pending.push({ displayHash, rpcHash });
  }
  if (pending.length === 0) return;

  const externalSignal = options?.signal;
  if (externalSignal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }

  const timeoutMs = chain.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const rpcHeaders = buildRpcHeaders();
  const signal = externalSignal ?? new AbortController().signal;

  if (pending.length >= 2) {
    for (const endpoint of chain.rpcs) {
      if (isEndpointCircuitOpen(endpoint)) continue;
      for (let i = 0; i < pending.length; i += MAX_BATCH_TX_LOOKUP) {
        const chunk = pending.slice(i, i + MAX_BATCH_TX_LOOKUP);
        const batchMap = await tryEndpointBatchGetTxInfos(endpoint, chunk, timeoutMs, rpcHeaders, signal);
        for (const [rpcHash, info] of batchMap) {
          txInfoCache.set(cacheKey(resolvedChainId, rpcHash), info);
        }
      }
      break;
    }
  }

  const stillPending = pending.filter(
    p => options?.skipCache || !txInfoCache.get(cacheKey(resolvedChainId, p.rpcHash)),
  );
  await Promise.allSettled(
    stillPending.map(({ displayHash }) => fetchTxCalldata(displayHash, resolvedChainId, options)),
  );
}

export async function fetchTxCalldata(
  txHash: string,
  chainId: number = DEFAULT_CHAIN_ID,
  options?: FetchTxCalldataOptions,
): Promise<TxInfo> {
  const displayHash = txHash.trim();
  const rpcHash = displayHash.toLowerCase();

  if (!TX_HASH_REGEX.test(displayHash)) {
    throw new Error('Invalid transaction hash format. Expected 0x followed by 64 hex characters.');
  }

  const chain = getChain(chainId);
  const resolvedChainId = chain.id;
  const cacheK = cacheKey(resolvedChainId, rpcHash);
  if (!options?.skipCache) {
    const hit = txInfoCache.get(cacheK);
    if (hit) return hit;
  }

  const timeoutMs = chain.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const rpcHeaders = buildRpcHeaders();
  const receiptProbeOnNull =
    options?.receiptProbeOnNull ?? chain.receiptProbeOnNullTx ?? true;
  const staggerMs = chain.rpcStaggerMs ?? DEFAULT_RPC_STAGGER_MS;

  const rpcBody = JSON.stringify({
    jsonrpc: '2.0',
    method: 'eth_getTransactionByHash',
    params: [rpcHash],
    id: 1,
  });

  const externalSignal = options?.signal;
  if (externalSignal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }

  const controller = new AbortController();
  const { signal } = controller;

  if (externalSignal) {
    const onExternalAbort = () => {
      controller.abort();
    };
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const attempts = chain.rpcs.map((endpoint, index) =>
    (async () => {
      if (isEndpointCircuitOpen(endpoint)) {
        throw new RpcEndpointCircuitOpenError(endpoint);
      }
      const staggerDelay = Math.min(index * staggerMs, MAX_RPC_STAGGER_OFFSET_MS);
      await sleep(staggerDelay, signal);
      const info = await tryEndpointWithRetries(
        endpoint,
        rpcBody,
        displayHash,
        rpcHash,
        timeoutMs,
        rpcHeaders,
        signal,
        receiptProbeOnNull,
      );
      controller.abort();
      return info;
    })(),
  );

  try {
    const info = await Promise.any(attempts);
    if (!options?.skipCache) {
      txInfoCache.set(cacheK, info);
    }
    return info;
  } catch (e) {
    controller.abort();
    if (e instanceof AggregateError && Array.isArray(e.errors) && e.errors.length > 0) {
      throw aggregateAllRejected(e.errors, chain.name);
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}
