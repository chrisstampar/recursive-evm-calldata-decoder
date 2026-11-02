/**
 * Regression tests for the 2026-11-02 audit findings (H = high, M = medium, L = low).
 * Each block reproduces the original misbehaviour so it cannot quietly come back.
 */
import { describe, expect, it, vi } from 'vitest';
import { getBytes, Interface, JsonRpcProvider, solidityPacked, toQuantity, Transaction, Wallet } from 'ethers';

import { decodeCalldata, splitTupleTypes } from './decoder.ts';
import * as abiRegistry from './abiRegistry.ts';
import * as signatureLookup from './signatureLookup.ts';
import { analyzeWarnings } from './warningAnalyzer.ts';
import { TxIntegrityError, verifyRpcTransaction } from './txIntegrity.ts';
import { clearEnsLookupCaches, reverseResolveEns } from './ensLookup.ts';
import { DEFAULT_DECODE_OPTIONS, type DecodedValue, type SignatureParam, type TxWarning } from '../types/index.ts';

const opts = {
  ...DEFAULT_DECODE_OPTIONS,
  chainId: 1,
  offlineMode: true,
  resolveEns: false,
  fetchTokenDecimalsOnChain: false,
};

const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

const ERC20 = new Interface([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
]);

describe('H5 — pasted ABI with struct params', () => {
  const aggregate3Abi = JSON.stringify([
    {
      type: 'function',
      name: 'aggregate3',
      stateMutability: 'payable',
      inputs: [
        {
          name: 'calls',
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'allowFailure', type: 'bool' },
            { name: 'callData', type: 'bytes' },
          ],
        },
      ],
      outputs: [],
    },
  ]);
  const inner = ERC20.encodeFunctionData('transfer', [RECIPIENT, 5n]);
  const data = new Interface(JSON.parse(aggregate3Abi)).encodeFunctionData('aggregate3', [[[DAI, false, inner]]]);

  it('decodes with the user ABI, keeps struct field names and expands nested calldata', async () => {
    const res = await decodeCalldata(data, { ...opts, userAbi: aggregate3Abi });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    expect(res.call.signature.source).toBe('user-abi');
    const calls = res.call.params[0];
    expect(calls.type).toBe('(address,bool,bytes)[]');
    expect(calls.value.kind).toBe('array');
    const row = (calls.value as Extract<DecodedValue, { kind: 'array' }>).elements[0];
    expect(row.kind).toBe('tuple');
    if (row.kind !== 'tuple') return;
    expect(row.fields.map(f => f.name)).toEqual(['target', 'allowFailure', 'callData']);
    const cd = row.fields[2].value;
    expect(cd.kind === 'bytes' && cd.decoded?.signature.name).toBe('transfer');
  });

  it('falls back to bundled signatures when the pasted ABI does not fit the payload', async () => {
    const spy = vi.spyOn(signatureLookup, 'lookupSelectorFromUserAbi').mockReturnValue([
      {
        selector: '0xa9059cbb',
        name: 'transfer',
        textSignature: 'transfer(string)',
        params: [{ name: 'memo', type: 'string' }],
        source: 'user-abi',
      },
    ]);
    try {
      const warnings: TxWarning[] = [];
      const res = await decodeCalldata(ERC20.encodeFunctionData('transfer', [RECIPIENT, 5n]), {
        ...opts,
        userAbi: '[]',
        decodeWarningSink: warnings,
      });
      expect(res.status).toBe('success');
      if (res.status !== 'success') return;
      expect(res.call.signature.source).toBe('bundled');
      expect(warnings.some(w => w.title === 'Pasted ABI did not fit this calldata')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';

function primitive(v: DecodedValue): Extract<DecodedValue, { kind: 'primitive' }> {
  if (v.kind !== 'primitive') throw new Error(`expected primitive, got ${v.kind}`);
  return v;
}

describe('H1 — ERC-20 amounts use the called token, not an address argument', () => {
  it('transfer to the USDC contract with To = WBTC is shown in WBTC', async () => {
    const res = await decodeCalldata(ERC20.encodeFunctionData('transfer', [USDC, 100_000_000n]), {
      ...opts,
      callTarget: WBTC,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const amount = primitive(res.call.params[1].value);
    expect(amount.interpretation).toMatch(/^1 WBTC/);
    expect(amount.tokenAmount).toMatchObject({ symbol: 'WBTC', decimals: 8 });
  });

  it('without a known To, the amount gets no unit (never the recipient’s)', async () => {
    const res = await decodeCalldata(ERC20.encodeFunctionData('approve', [USDC, 100_000_000n]), opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const amount = primitive(res.call.params[1].value);
    expect(amount.interpretation ?? '').not.toMatch(/USDC/);
    expect(amount.tokenAmount).toBeUndefined();
    expect(res.call.params[1].fieldHint).toMatch(/token being called/);
  });

  it('a multicall row decodes its inner transfer against the row target', async () => {
    const mc3 = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls)']);
    const inner = ERC20.encodeFunctionData('transfer', [DAI, 1_000_000n]);
    const res = await decodeCalldata(mc3.encodeFunctionData('aggregate3', [[[USDC, false, inner]]]), {
      ...opts,
      callTarget: WBTC, // outer target must not leak into the nested frame
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const rows = res.call.params[0].value;
    if (rows.kind !== 'array' || rows.elements[0].kind !== 'tuple') throw new Error('shape');
    const cd = rows.elements[0].fields[2].value;
    if (cd.kind !== 'bytes' || !cd.decoded) throw new Error('nested decode missing');
    expect(primitive(cd.decoded.params[1].value).interpretation).toMatch(/^1 USDC/);
  });
});

describe('H2 — on-chain token metadata is marked unverified', () => {
  it('quotes the symbol, says it is unverified and drops the USD peg', async () => {
    const spy = vi.spyOn(abiRegistry, 'fetchOnChainTokenDecimals').mockResolvedValue({
      symbol: 'USDC',
      decimals: 6,
      unverified: true,
    });
    try {
      const fakeUsdc = '0x2222222222222222222222222222222222222222';
      const res = await decodeCalldata(ERC20.encodeFunctionData('transfer', [RECIPIENT, 5_000_000n]), {
        ...opts,
        offlineMode: false,
        fetchTokenDecimalsOnChain: true,
        callTarget: fakeUsdc,
      });
      expect(res.status).toBe('success');
      if (res.status !== 'success') return;
      const amount = primitive(res.call.params[1].value);
      expect(amount.interpretation).toMatch(/^5 "USDC" \(unverified token/);
      expect(amount.interpretation).not.toMatch(/\$/);
      expect(amount.tokenAmount?.unverified).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

const MAX256 = (1n << 256n) - 1n;
const MAX160 = (1n << 160n) - 1n;
const SAFE = new Interface([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
  'function multiSend(bytes transactions)',
]);
const ZERO = '0x0000000000000000000000000000000000000000';

async function warningsFor(data: string, txTo?: string): Promise<TxWarning[]> {
  const sink: TxWarning[] = [];
  const res = await decodeCalldata(data, { ...opts, callTarget: txTo, decodeWarningSink: sink });
  if (res.status !== 'success' && res.status !== 'partial') throw new Error(`decode failed: ${JSON.stringify(res)}`);
  return [...sink, ...analyzeWarnings(res.call, undefined, { txTo, chainId: 1 })];
}
const titles = (ws: TxWarning[]) => ws.map(w => w.title);

function packMultiSendRow(op: number, to: string, data: string): string {
  return solidityPacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [op, to, 0, getBytes(data).length, data]).slice(2);
}

describe('H4 — Safe DELEGATECALL is flagged', () => {
  const inner = ERC20.encodeFunctionData('transfer', [RECIPIENT, 1n]);

  it('execTransaction with operation = 1 to an unknown contract is danger', async () => {
    const data = SAFE.encodeFunctionData('execTransaction', [RECIPIENT, 0, inner, 1, 0, 0, 0, ZERO, ZERO, '0x']);
    const ws = await warningsFor(data);
    const w = ws.find(x => x.title === 'Safe DELEGATECALL');
    expect(w?.severity).toBe('danger');
    expect(w?.message).toMatch(/0x1111111111111111111111111111111111111111/);
  });

  it('execTransaction with operation = 0 is not flagged as a delegatecall', async () => {
    const data = SAFE.encodeFunctionData('execTransaction', [RECIPIENT, 0, inner, 0, 0, 0, 0, ZERO, ZERO, '0x']);
    expect(titles(await warningsFor(data)).some(t => /DELEGATECALL/.test(t))).toBe(false);
  });

  it('delegatecall to the canonical MultiSend library is a warning, not danger', async () => {
    const multiSendLib = '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D';
    const batch = SAFE.encodeFunctionData('multiSend', ['0x' + packMultiSendRow(0, DAI, inner)]);
    const data = SAFE.encodeFunctionData('execTransaction', [multiSendLib, 0, batch, 1, 0, 0, 0, ZERO, ZERO, '0x']);
    const w = (await warningsFor(data)).find(x => x.title === 'Safe DELEGATECALL to MultiSend');
    expect(w?.severity).toBe('warning');
  });

  it('a DELEGATECALL row inside multiSend is danger', async () => {
    const data = SAFE.encodeFunctionData('multiSend', ['0x' + packMultiSendRow(1, RECIPIENT, inner)]);
    const w = (await warningsFor(data)).find(x => x.title === 'Safe DELEGATECALL');
    expect(w?.severity).toBe('danger');
    expect(w?.context).toMatch(/row 0/);
  });
});

describe('M4 — malformed multiSend rows are reported', () => {
  it('warns when a row claims more data than the payload holds', async () => {
    const good = packMultiSendRow(0, DAI, '0x12345678');
    const bad = solidityPacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [1, RECIPIENT, 0, 999, '0xdeadbeef']).slice(2);
    const ws = await warningsFor(SAFE.encodeFunctionData('multiSend', ['0x' + good + bad]));
    const w = ws.find(x => x.title === 'multiSend payload did not parse cleanly');
    expect(w?.severity).toBe('danger');
  });
});

describe('M2 — approval and large-transfer warnings', () => {
  const PERMIT = new Interface([
    'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
    'function permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed,uint8 v,bytes32 r,bytes32 s)',
    'function approve(address token,address spender,uint160 amount,uint48 expiration)',
    'function permit(address owner,((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline) permitSingle,bytes signature)',
  ]);
  const r = '0x' + '11'.repeat(32);

  it('EIP-2612 permit with max value is an unlimited approval', async () => {
    const data = PERMIT.encodeFunctionData('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', [RECIPIENT, RECIPIENT, MAX256, 9_999_999_999n, 27, r, r]);
    expect(titles(await warningsFor(data, USDC))).toContain('Unlimited token approval');
  });

  it('DAI permit with allowed = true is an unlimited approval', async () => {
    const data = PERMIT.encodeFunctionData('permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)', [RECIPIENT, RECIPIENT, 0, 0, true, 27, r, r]);
    expect(titles(await warningsFor(data, DAI))).toContain('Unlimited token approval');
  });

  it('Permit2 approve with max uint160 is an unlimited approval', async () => {
    const data = PERMIT.encodeFunctionData('approve(address,address,uint160,uint48)', [USDC, RECIPIENT, MAX160, 0]);
    expect(titles(await warningsFor(data))).toContain('Unlimited token approval');
  });

  it('Permit2 permit (single) with max amount is an unlimited approval', async () => {
    const data = PERMIT.encodeFunctionData('permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)', [RECIPIENT, [[USDC, MAX160, 0, 0], RECIPIENT, 0], '0x']);
    expect(titles(await warningsFor(data))).toContain('Unlimited token approval');
  });

  it('a 1,000,000 USDC transfer raises the large-transfer warning', async () => {
    const data = ERC20.encodeFunctionData('transfer', [RECIPIENT, 1_000_000_000_000n]);
    expect(titles(await warningsFor(data, USDC))).toContain('Large token transfer');
  });

  it('a large amount of an unverified token is flagged as unverified, not valued', async () => {
    const spy = vi.spyOn(abiRegistry, 'fetchOnChainTokenDecimals').mockResolvedValue({ symbol: 'USDC', decimals: 6, unverified: true });
    try {
      const sink: TxWarning[] = [];
      const res = await decodeCalldata(ERC20.encodeFunctionData('transfer', [RECIPIENT, 1_000_000_000_000n]), {
        ...opts, offlineMode: false, fetchTokenDecimalsOnChain: true, callTarget: '0x2222222222222222222222222222222222222222', decodeWarningSink: sink,
      });
      if (res.status !== 'success') throw new Error('decode failed');
      const t = titles(analyzeWarnings(res.call, undefined, { chainId: 1 }));
      expect(t).toContain('Unverified token');
      expect(t).not.toContain('Large token transfer');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('M1 — trailing calldata and non-canonical encodings are surfaced', () => {
  it('reports bytes after the ABI arguments', async () => {
    const data = ERC20.encodeFunctionData('transfer', [RECIPIENT, 5n]) + 'deadbeef'.repeat(24);
    const res = await decodeCalldata(data, opts);
    if (res.status !== 'success') throw new Error('decode failed');
    expect(res.call.unparsedTrailingHex).toBe('0x' + 'deadbeef'.repeat(24));
    expect(titles(analyzeWarnings(res.call, undefined, { chainId: 1 }))).toContain('Unparsed trailing calldata');
  });

  it('exact encodings carry no trailing/non-canonical markers', async () => {
    const res = await decodeCalldata(ERC20.encodeFunctionData('transfer', [RECIPIENT, 5n]), opts);
    if (res.status !== 'success') throw new Error('decode failed');
    expect(res.call.unparsedTrailingHex).toBeUndefined();
    expect(res.call.nonCanonicalEncoding).toBeUndefined();
  });

  it('flags an out-of-range uint8 that ethers would show masked', async () => {
    const PERMIT = new Interface(['function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)']);
    const good = PERMIT.encodeFunctionData('permit', [RECIPIENT, RECIPIENT, 1n, 1n, 27, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32)]);
    // word 4 (`v`) = 300: 4-byte selector + 4 words of 32 bytes, then the `v` word
    const vOffset = 2 + 8 + 4 * 64;
    const bad = good.slice(0, vOffset) + (300).toString(16).padStart(64, '0') + good.slice(vOffset + 64);
    const res = await decodeCalldata(bad, opts);
    if (res.status !== 'success') throw new Error('decode failed');
    expect(res.call.nonCanonicalEncoding).toBe(true);
    expect(titles(analyzeWarnings(res.call, undefined, { chainId: 1 }))).toContain('Non-standard ABI encoding');
  });
});

describe('M3 — 10-digit token amounts are not mistaken for timestamps', () => {
  it('1,500 USDC in a named amount param reads as an amount', async () => {
    const AAVE = new Interface(['function deposit(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)']);
    const res = await decodeCalldata(AAVE.encodeFunctionData('deposit', [USDC, 1_500_000_000n, RECIPIENT, 0]), opts);
    if (res.status !== 'success') throw new Error('decode failed');
    const amount = primitive(res.call.params[1].value);
    expect(amount.interpretation).toMatch(/^1,500 USDC/);
    expect(amount.interpretation).not.toMatch(/Timestamp/);
  });
});

describe('M6 — one decode cannot fan out into hundreds of API requests', () => {
  it('a random 600-byte swapCompact payload stays within the remote lookup budget', async () => {
    signatureLookup.clearSelectorLookupCache();
    const urls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      urls.push(String(input));
      return new Response(JSON.stringify({ ok: true, result: { function: {} }, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      let seed = 7;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256;
      const tail = Array.from({ length: 600 }, () => rnd().toString(16).padStart(2, '0')).join('');
      await decodeCalldata('0x83bd37f9' + tail, { ...opts, offlineMode: false });
      // 25 selectors × at most 3 APIs each; before the fix this payload produced 135 requests.
      expect(urls.length).toBeLessThanOrEqual(25 * 3);
    } finally {
      fetchSpy.mockRestore();
      signatureLookup.clearSelectorLookupCache();
    }
  });
});

describe('M5 — tx-hash responses are checked against the requested hash', () => {
  const wallet = new Wallet('0x' + '42'.repeat(32));

  async function rpcShape(txReq: Parameters<Wallet['signTransaction']>[0]) {
    const signed = Transaction.from(await wallet.signTransaction(txReq));
    const hex = (n: bigint | number) => toQuantity(n);
    const out: Record<string, unknown> = {
      hash: signed.hash,
      type: hex(signed.type ?? 0),
      chainId: hex(signed.chainId),
      nonce: hex(signed.nonce),
      gas: hex(signed.gasLimit),
      to: signed.to,
      from: signed.from,
      value: hex(signed.value),
      input: signed.data,
      r: signed.signature!.r,
      s: signed.signature!.s,
      v: hex(signed.type === 0 ? signed.signature!.networkV ?? signed.signature!.v : signed.signature!.yParity),
      yParity: hex(signed.signature!.yParity),
      blockNumber: '0x1',
    };
    if (signed.type === 0) out.gasPrice = hex(signed.gasPrice ?? 0n);
    else {
      out.maxFeePerGas = hex(signed.maxFeePerGas ?? 0n);
      out.maxPriorityFeePerGas = hex(signed.maxPriorityFeePerGas ?? 0n);
      out.accessList = [];
    }
    return out;
  }

  const base = {
    to: USDC,
    nonce: 7,
    gasLimit: 60_000n,
    value: 0n,
    data: ERC20.encodeFunctionData('transfer', [RECIPIENT, 5n]),
    chainId: 1n,
  };

  it('verifies an authentic EIP-1559 transaction', async () => {
    const raw = await rpcShape({ ...base, type: 2, maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n });
    expect(verifyRpcTransaction(raw, String(raw.hash).toLowerCase())).toBe('verified');
  });

  it('verifies an authentic legacy EIP-155 transaction', async () => {
    const raw = await rpcShape({ ...base, type: 0, gasPrice: 20n * 10n ** 9n });
    expect(verifyRpcTransaction(raw, String(raw.hash).toLowerCase())).toBe('verified');
  });

  it('rejects a response whose calldata was swapped', async () => {
    const raw = await rpcShape({ ...base, type: 2, maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n });
    const tampered = { ...raw, input: ERC20.encodeFunctionData('transfer', [DAI, 5n]) };
    expect(() => verifyRpcTransaction(tampered, String(raw.hash).toLowerCase())).toThrow(TxIntegrityError);
  });

  it('rejects a response that lies about `from`', async () => {
    const raw = await rpcShape({ ...base, type: 2, maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n });
    expect(() => verifyRpcTransaction({ ...raw, from: RECIPIENT }, String(raw.hash).toLowerCase())).toThrow(TxIntegrityError);
  });

  it('reports partial responses and L2 system types as unverifiable, not as errors', () => {
    expect(verifyRpcTransaction({ input: '0x', to: null, from: RECIPIENT, value: '0x0', blockNumber: null }, '0x' + '00'.repeat(32))).toBe('unverifiable');
    expect(verifyRpcTransaction({ type: '0x7e', input: '0x' }, '0x' + '00'.repeat(32))).toBe('unverifiable');
  });
});

describe('L4 — ENS lookups', () => {
  it('a second caller is not failed by the first caller aborting', async () => {
    clearEnsLookupCaches();
    let release: (v: string | null) => void = () => {};
    const spy = vi
      .spyOn(JsonRpcProvider.prototype, 'lookupAddress')
      .mockImplementation(() => new Promise(r => { release = r; }));
    try {
      const addr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
      const first = new AbortController();
      const p1 = reverseResolveEns(addr, { signal: first.signal });
      const p2 = reverseResolveEns(addr, { signal: new AbortController().signal });
      first.abort();
      release(null);
      await expect(p1).rejects.toThrow(/aborted/);
      await expect(p2).resolves.toBe(null);
      // A successful "no reverse record" answer is final: no second RPC asked the same question.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      clearEnsLookupCaches();
    }
  });
});

describe('L10 — bundled struct field names line up with their tuple types', () => {
  it('every `components` list has one entry per tuple slot, recursively', () => {
    const check = (p: SignatureParam, where: string) => {
      if (!p.components) return;
      const tuple = p.type.endsWith('[]') ? p.type.slice(0, -2) : p.type;
      const slots = splitTupleTypes(tuple.slice(1, -1));
      expect(p.components.map(c => c.type), where).toEqual(slots);
      p.components.forEach(c => check(c, `${where}.${c.name}`));
    };
    for (const sig of abiRegistry.getBundledSignaturesForTests()) {
      sig.params.forEach(p => check(p, `${sig.textSignature}:${p.name}`));
    }
  });
});

describe('M3 — amount-named params never read as timestamps', () => {
  it('an ERC-20 amount with an unknown token is not labelled a date', async () => {
    const res = await decodeCalldata(ERC20.encodeFunctionData('transfer', [RECIPIENT, 1_500_000_000n]), opts);
    if (res.status !== 'success') throw new Error('decode failed');
    expect(primitive(res.call.params[1].value).interpretation ?? '').not.toMatch(/Timestamp/);
  });
});
