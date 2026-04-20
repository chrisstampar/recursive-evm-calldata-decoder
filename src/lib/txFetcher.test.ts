import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearTxCalldataCache,
  clearTxFetcherEndpointCircuits,
  fetchTxCalldata,
  prefetchTxCalldata,
  resetTxFetcherCircuitConfigForTests,
  setTxFetcherCircuitOpenMsForTests,
  TxIndexingLagError,
  TxNotFoundError,
} from './txFetcher.ts';

const TX =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

const validTx = {
  input: '0xa9059cbb',
  to: '0x0000000000000000000000000000000000000001',
  from: '0x0000000000000000000000000000000000000002',
  value: '0x0',
  blockNumber: '0x123',
};

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseRpcBody(init?: RequestInit): { method?: string } {
  try {
    return JSON.parse(String(init?.body ?? '{}')) as { method?: string };
  } catch {
    return {};
  }
}

afterEach(() => {
  clearTxCalldataCache();
  clearTxFetcherEndpointCircuits();
  resetTxFetcherCircuitConfigForTests();
  vi.unstubAllGlobals();
});

describe('fetchTxCalldata', () => {
  it('tries another RPC when one returns null tx and null receipt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const { method } = parseRpcBody(init);
        if (method === 'eth_getTransactionReceipt') {
          return jsonResponse({ jsonrpc: '2.0', id: 2, result: null });
        }
        if (u.includes('llamarpc') && method === 'eth_getTransactionByHash') {
          return jsonResponse({ jsonrpc: '2.0', id: 1, result: null });
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: validTx });
      }) as typeof fetch,
    );

    const info = await fetchTxCalldata(TX, 1);
    expect(info.calldata).toBe('0xa9059cbb');
  });

  it('tries another RPC when the first returns no transaction body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const { method } = parseRpcBody(init);
        if (u.includes('llamarpc')) {
          if (method === 'eth_getTransactionByHash') {
            return jsonResponse({ jsonrpc: '2.0', id: 1, result: null });
          }
          if (method === 'eth_getTransactionReceipt') {
            return jsonResponse({ jsonrpc: '2.0', id: 2, result: null });
          }
        }
        if (method === 'eth_getTransactionReceipt') {
          return jsonResponse({ jsonrpc: '2.0', id: 2, result: null });
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: validTx });
      }) as typeof fetch,
    );

    const info = await fetchTxCalldata(TX, 1);
    expect(info.calldata).toBe('0xa9059cbb');
  });

  it('throws TxNotFoundError when all RPCs return null tx and null receipt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const { method } = parseRpcBody(init);
        if (method === 'eth_getTransactionReceipt') {
          return jsonResponse({ jsonrpc: '2.0', id: 2, result: null });
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: null });
      }) as typeof fetch,
    );

    await expect(fetchTxCalldata(TX, 1)).rejects.toThrow(TxNotFoundError);
  });

  it('throws TxIndexingLagError when tx is null but receipt exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const { method } = parseRpcBody(init);
        if (method === 'eth_getTransactionReceipt') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 2,
            result: {
              transactionHash: TX,
              blockHash: '0x' + 'b'.repeat(64),
              blockNumber: '0x1',
            },
          });
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: null });
      }) as typeof fetch,
    );

    await expect(fetchTxCalldata(TX, 999)).rejects.toThrow(TxIndexingLagError);
  });

  it('returns tx info when calldata is empty (native transfer)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const { method } = parseRpcBody(init);
        if (method === 'eth_getTransactionReceipt') {
          return jsonResponse({ jsonrpc: '2.0', id: 2, result: null });
        }
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { ...validTx, input: '0x' },
        });
      }) as typeof fetch,
    );

    const info = await fetchTxCalldata(TX, 1);
    expect(info.calldata).toBe('0x');
    expect(info.hash).toBe(TX);
  });

  it('tries another RPC when one returns non-JSON Content-Type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('llamarpc')) {
          return new Response('<!doctype html><title>error</title>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: validTx });
      }) as typeof fetch,
    );

    const info = await fetchTxCalldata(TX, 1);
    expect(info.calldata).toBe('0xa9059cbb');
  });

  it('tries another RPC when result is not a transaction object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const { method } = parseRpcBody(init);
        if (u.includes('llamarpc') && method === 'eth_getTransactionByHash') {
          return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x1234' });
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: validTx });
      }) as typeof fetch,
    );

    const info = await fetchTxCalldata(TX, 1);
    expect(info.calldata).toBe('0xa9059cbb');
  });

  it('throws when every RPC returns non-JSON Content-Type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      ) as typeof fetch,
    );

    await expect(fetchTxCalldata(TX, 1)).rejects.toThrow(/must be application\/json/i);
  });

  it('retries on HTTP 429 before succeeding (single-RPC chain)', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return new Response('', { status: 429, headers: { 'retry-after': '0' } });
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: validTx });
      }) as typeof fetch,
    );

    const info = await fetchTxCalldata(TX, 999);
    expect(info.calldata).toBe('0xa9059cbb');
    expect(n).toBe(2);
  });

  it('retries when body is not JSON but Content-Type is application/json', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        return new Response('not json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    );

    await expect(fetchTxCalldata(TX, 999)).rejects.toThrow(/invalid json response from rpc/i);
    expect(n).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('caches successful fetches per chain and hash', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: validTx }),
    );
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    await fetchTxCalldata(TX, 999);
    await fetchTxCalldata(TX, 999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skipCache forces a new fetch', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: validTx }),
    );
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    await fetchTxCalldata(TX, 999);
    await fetchTxCalldata(TX, 999, { skipCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves hash casing in TxInfo while RPC params are lowercase', async () => {
    const mixed =
      '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as const;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { params?: string[] };
      expect(body.params?.[0]).toBe(mixed.toLowerCase());
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: validTx });
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const info = await fetchTxCalldata(mixed, 999);
    expect(info.hash).toBe(mixed);
  });

  it('skips receipt RPC when receiptProbeOnNull is false', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = parseRpcBody(init);
      expect(body.method).toBe('eth_getTransactionByHash');
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: null });
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    await expect(
      fetchTxCalldata(TX, 999, { receiptProbeOnNull: false }),
    ).rejects.toThrow(TxNotFoundError);
    expect(fetchMock.mock.calls.every(([, init]) => {
      const m = parseRpcBody(init as RequestInit).method;
      return m === 'eth_getTransactionByHash';
    })).toBe(true);
  });

  it('throws AbortError when options.signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      fetchTxCalldata(TX, 1, { signal: ac.signal, skipCache: true }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('trips per-endpoint circuit after retries and avoids further HTTP until the window passes', async () => {
    setTxFetcherCircuitOpenMsForTests(80);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response('', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    await expect(fetchTxCalldata(TX, 999, { skipCache: true })).rejects.toThrow();
    const callsAfterFailures = fetchMock.mock.calls.length;
    expect(callsAfterFailures).toBeGreaterThanOrEqual(3);

    await expect(fetchTxCalldata(TX, 999, { skipCache: true })).rejects.toThrow(/temporarily unavailable/i);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFailures);

    await new Promise<void>(resolve => {
      setTimeout(resolve, 120);
    });
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { method } = parseRpcBody(init);
      if (method === 'eth_getTransactionReceipt') {
        return jsonResponse({ jsonrpc: '2.0', id: 2, result: null });
      }
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: validTx });
    });

    const info = await fetchTxCalldata(TX, 999, { skipCache: true });
    expect(info.calldata).toBe('0xa9059cbb');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFailures);
  }, 25_000);

  it('prefetchTxCalldata uses JSON-RPC batch for multiple hashes then serves from cache', async () => {
    const TX2 = ('0x' + 'b'.repeat(64)) as `0x${string}`;
    let batchSeen = false;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const raw = String(init?.body ?? '');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: null });
      }
      if (Array.isArray(parsed)) {
        batchSeen = true;
        return jsonResponse([
          { jsonrpc: '2.0', id: 1, result: validTx },
          { jsonrpc: '2.0', id: 2, result: { ...validTx, input: '0xdeadbeef' } },
        ]);
      }
      const { method } = parseRpcBody(init);
      if (method === 'eth_getTransactionReceipt') {
        return jsonResponse({ jsonrpc: '2.0', id: 2, result: null });
      }
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: validTx });
    });
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    await prefetchTxCalldata([TX, TX2], 999);
    expect(batchSeen).toBe(true);

    const fetchCountAfterBatch = fetchMock.mock.calls.length;
    const a = await fetchTxCalldata(TX, 999);
    const b = await fetchTxCalldata(TX2, 999);
    expect(a.calldata).toBe('0xa9059cbb');
    expect(b.calldata).toBe('0xdeadbeef');
    expect(fetchMock.mock.calls.length).toBe(fetchCountAfterBatch);
  });
});
