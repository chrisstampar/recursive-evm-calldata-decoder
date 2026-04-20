import { describe, expect, it, vi } from 'vitest';
import { AbiCoder, concat, getBytes, hexlify, Interface, ParamType, toBeHex, zeroPadValue } from 'ethers';

import {
  decodeCalldata,
  decodeWithUserAbi,
  isDynamicBytesSolidityType,
  parseFixedAbiArraySuffix,
  splitTupleTypes,
  toRawHex,
} from './decoder.ts';
import * as abiRegistry from './abiRegistry.ts';
import * as signatureLookup from './signatureLookup.ts';
import {
  DEFAULT_MAX_MULTISEND_OPERATIONS,
  DEFAULT_MAX_PATTERN_ARRAY_EXPAND,
} from './knownPatterns.ts';
import { analyzeWarnings } from './warningAnalyzer.ts';
import { DEFAULT_DECODE_OPTIONS, type DecodedCall, type DecodedValue, type TxWarning } from '../types/index.ts';
import {
  ACROSS_SPOKE_DEPOSIT_MAINNET,
  CURVE_EXCHANGE_MAINNET_INPUT,
  USDT0_LZ_SEND_MAINNET,
} from '../fixtures/decoderCalldataHex.ts';
import { USDT0_OFT_MAINNET } from '../fixtures/mainnetAddresses.ts';

const opts = { ...DEFAULT_DECODE_OPTIONS, chainId: 1 as const, offlineMode: true };

describe('decodeCalldata — input validation', () => {
  it('returns error for calldata with invalid hex characters', async () => {
    const res = await decodeCalldata('0xGG', opts);
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.error).toMatch(/Invalid hexadecimal/i);
  });

  it('returns error for hex with illegal characters (normalizeHex path)', async () => {
    const res = await decodeCalldata('0x12_34', opts);
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.error).toMatch(/Invalid hexadecimal/i);
  });

  it('returns error for empty calldata and bare 0x (no selector)', async () => {
    for (const calldata of ['', '0x', '0x12', '0xabcd']) {
      const res = await decodeCalldata(calldata, opts);
      expect(res.status).toBe('error');
      if (res.status !== 'error') return;
      expect(res.error).toMatch(/Invalid function selector|selector/i);
    }
  });

  it('decodeWithUserAbi returns error for invalid hex', () => {
    const res = decodeWithUserAbi('0xGG', JSON.stringify(['function transfer(address,uint256)']));
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.error).toMatch(/Invalid hexadecimal/i);
  });
});

describe('decodeCalldata — opaque bytes edge cases', () => {
  it('does not nest-decode dynamic bytes of exactly 4 bytes (selector-only noise)', async () => {
    const iface = new Interface(['function probe(bytes)']);
    const data = iface.encodeFunctionData('probe', ['0xdeadbeef']);
    const res = await decodeCalldata(data, {
      ...opts,
      userAbi: JSON.stringify(['function probe(bytes)']),
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const v = res.call.params[0]?.value;
    expect(v?.kind).toBe('bytes');
    if (v?.kind !== 'bytes') return;
    expect(v.decoded).toBeUndefined();
  });
});

describe('decodeCalldata — bytes param as Uint8Array (AbiCoder edge)', () => {
  it('normalizes dynamic bytes when decode yields Uint8Array instead of hex string', async () => {
    const defaultCoder = AbiCoder.defaultAbiCoder();
    const origDecode = defaultCoder.decode.bind(defaultCoder);
    const spy = vi.spyOn(AbiCoder.prototype, 'decode').mockImplementation((types, data) => {
      const t = types as readonly string[];
      if (t.length === 1 && t[0] === 'bytes') {
        return [new Uint8Array([0xde, 0xad, 0xbe, 0xef])] as ReturnType<AbiCoder['decode']>;
      }
      return origDecode(t, data as `0x${string}`);
    });
    try {
      const iface = new Interface(['function mem(bytes)']);
      const data = iface.encodeFunctionData('mem', ['0x00']);
      const res = await decodeCalldata(data, {
        ...opts,
        userAbi: JSON.stringify(['function mem(bytes)']),
      });
      expect(res.status).toBe('success');
      if (res.status !== 'success') return;
      const v = res.call.params[0]?.value;
      expect(v?.kind).toBe('bytes');
      if (v?.kind !== 'bytes') return;
      expect(v.hex.toLowerCase()).toBe('0xdeadbeef');
    } finally {
      spy.mockRestore();
    }
  });
});

/** One Gnosis `multiSend` packed operation: op(1) | to(20) | value(32) | dataLen(32) | data */
function packGnosisMultiSendOperation(
  operation: number,
  to: string,
  valueWei: bigint,
  innerCalldataHex: string,
): string {
  const addr = (to.startsWith('0x') ? to : `0x${to}`).slice(2).toLowerCase().padStart(40, '0');
  const body = innerCalldataHex.startsWith('0x') ? innerCalldataHex.slice(2) : innerCalldataHex;
  if (body.length % 2 !== 0) throw new Error('odd hex');
  const dataLen = body.length / 2;
  const opHex = operation.toString(16).padStart(2, '0');
  const valueHex = valueWei.toString(16).padStart(64, '0');
  const lenHex = BigInt(dataLen).toString(16).padStart(64, '0');
  return opHex + addr + valueHex + lenHex + body;
}

function nestMulticallBytes(depth: number, innerHex: string): string {
  let cur = innerHex.startsWith('0x') ? innerHex : `0x${innerHex}`;
  const iface = new Interface(['function multicall(bytes[])']);
  for (let i = 0; i < depth; i++) {
    cur = iface.encodeFunctionData('multicall', [[cur]]);
  }
  return cur;
}

function countMulticallDecodeChain(call: DecodedCall): number {
  let n = 0;
  let cur: DecodedCall | undefined = call;
  while (cur?.signature.name === 'multicall' && cur.params[0]?.value.kind === 'array') {
    const els: DecodedValue[] = cur.params[0].value.elements;
    if (els.length === 0) break;
    const first: DecodedValue = els[0];
    if (first.kind !== 'bytes' || !first.decoded) break;
    n += 1;
    cur = first.decoded;
  }
  return n;
}

describe('decodeCalldata — nested calldata patterns', () => {
  it('expands CoW Protocol settle interaction callData (fixed interactions[3] + tuple rows)', async () => {
    const erc20 = new Interface(['function transfer(address,uint256)']);
    const nested = erc20.encodeFunctionData('transfer', [
      '0x0000000000000000000000000000000000000001',
      1n,
    ]);
    const iface = new Interface([
      'function settle(address[],uint256[],tuple(uint256,uint256,address,uint256,uint256,uint32,bytes32,uint256,uint256,uint256,bytes)[],tuple(address,uint256,bytes)[][3])',
    ]);
    const data = iface.encodeFunctionData('settle', [
      [],
      [],
      [],
      [[], [['0x0000000000000000000000000000000000000002', 0n, nested]], []],
    ]);

    const res = await decodeCalldata(data, opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;

    const p3 = res.call.params[3].value;
    expect(p3.kind).toBe('array');
    if (p3.kind !== 'array') return;

    const intra = p3.elements[1];
    expect(intra.kind).toBe('array');
    if (intra.kind !== 'array' || intra.elements.length === 0) return;

    const row = intra.elements[0];
    expect(row.kind).toBe('tuple');
    if (row.kind !== 'tuple') return;

    const callDataField = row.fields[2];
    expect(callDataField.type).toBe('bytes');
    expect(callDataField.value.kind).toBe('bytes');
    if (callDataField.value.kind !== 'bytes') return;

    expect(callDataField.value.decoded?.signature.name).toBe('transfer');
  });

  it('expands ERC2771Forwarder execute nested bytes fields', async () => {
    const inner = new Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [
      '0x0000000000000000000000000000000000000003',
      2n,
    ]);
    const iface = new Interface([
      'function execute(tuple(address,address,uint256,uint256,uint48,bytes,bytes) request)',
    ]);
    const req = [
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
      0n,
      0n,
      0,
      inner,
      '0x',
    ];
    const data = iface.encodeFunctionData('execute', [req]);

    const res = await decodeCalldata(data, opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;

    const p0 = res.call.params[0].value;
    expect(p0.kind).toBe('tuple');
    if (p0.kind !== 'tuple') return;

    const execData = p0.fields[5];
    expect(execData.value.kind).toBe('bytes');
    if (execData.value.kind !== 'bytes') return;

    expect(execData.value.decoded?.signature.name).toBe('approve');
  });

  it('Multicall-style (address,bytes)[]: each row bytes expands (bundled aggregate selector)', async () => {
    const transferIface = new Interface(['function transfer(address,uint256)']);
    const inner = transferIface.encodeFunctionData('transfer', [
      '0x4444444444444444444444444444444444444444',
      99n,
    ]);
    const row = (a: string) => [a, inner];
    const iface = new Interface(['function aggregate((address,bytes)[])']);
    const data = iface.encodeFunctionData('aggregate', [
      [
        row('0x1111111111111111111111111111111111111111'),
        row('0x2222222222222222222222222222222222222222'),
        row('0x3333333333333333333333333333333333333333'),
      ],
    ]);
    const res = await decodeCalldata(data, opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    expect(res.call.signature.selector.toLowerCase()).toBe('0x252dba42');
    const p0 = res.call.params[0].value;
    expect(p0.kind).toBe('array');
    if (p0.kind !== 'array') return;
    expect(p0.elements).toHaveLength(3);
    const countDecodedTransfers = (v: DecodedValue): number => {
      let n = 0;
      if (v.kind === 'bytes' && v.decoded?.signature.name === 'transfer') n += 1;
      if (v.kind === 'array') for (const el of v.elements) n += countDecodedTransfers(el);
      if (v.kind === 'tuple') for (const f of v.fields) n += countDecodedTransfers(f.value);
      return n;
    };
    expect(countDecodedTransfers(p0)).toBe(3);
  });

  it('caps pattern-driven bytes[] expansion and fills decodeWarningSink', async () => {
    // Empty segments avoid hundreds of nested `decodeCalldata` frames (stack) while still
    // exercising the bytes[] length cap for known `array-direct` patterns.
    const empty = '0x';
    const len = DEFAULT_MAX_PATTERN_ARRAY_EXPAND + 1;
    const payload = Array.from({ length: len }, () => empty);
    const iface = new Interface(['function multicall(bytes[])']);
    const data = iface.encodeFunctionData('multicall', [payload]);

    const decodeWarningSink: TxWarning[] = [];
    const res = await decodeCalldata(data, { ...opts, decodeWarningSink });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;

    const arr = res.call.params[0].value;
    expect(arr.kind).toBe('array');
    if (arr.kind === 'array') {
      expect(arr.elements.length).toBe(DEFAULT_MAX_PATTERN_ARRAY_EXPAND);
    }
    expect(decodeWarningSink.some(w => w.title === 'Large nested calldata array')).toBe(true);
  });

  it('performance: multicall(bytes[]) at default array cap stays within budget', async () => {
    const n = DEFAULT_MAX_PATTERN_ARRAY_EXPAND;
    const payload = Array.from({ length: n }, () => '0x');
    const iface = new Interface(['function multicall(bytes[])']);
    const data = iface.encodeFunctionData('multicall', [payload]);
    const t0 = performance.now();
    const res = await decodeCalldata(data, opts);
    const elapsedMs = performance.now() - t0;
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const arr = res.call.params[0].value;
    expect(arr.kind).toBe('array');
    if (arr.kind === 'array') expect(arr.elements).toHaveLength(n);
    // Known pattern cap is 200 (`DEFAULT_MAX_PATTERN_ARRAY_EXPAND`), not 1000; empty inner
    // calldata keeps CPU bounded while still walking the full array. Loose ceiling for CI variance.
    expect(elapsedMs).toBeLessThan(3000);
  });

  it('handles multicall with an empty bytes[] (no nested work)', async () => {
    const iface = new Interface(['function multicall(bytes[])']);
    const data = iface.encodeFunctionData('multicall', [[]]);
    const res = await decodeCalldata(data, opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const arr = res.call.params[0].value;
    expect(arr.kind).toBe('array');
    if (arr.kind === 'array') expect(arr.elements).toHaveLength(0);
  });

  it('stops expanding self-nested multicall when pattern nest limit is reached', async () => {
    const depth = (opts.multicallNestLimit ?? 5) + 2;
    const data = nestMulticallBytes(depth, '0x');
    const res = await decodeCalldata(data, opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const chain = countMulticallDecodeChain(res.call);
    expect(chain).toBeLessThanOrEqual(opts.multicallNestLimit ?? 5);
    const walkToDeepestBytes = (v: DecodedValue): DecodedValue => {
      if (v.kind === 'bytes') return v;
      if (v.kind === 'array' && v.elements[0]) return walkToDeepestBytes(v.elements[0]);
      if (v.kind === 'tuple' && v.fields[0]) return walkToDeepestBytes(v.fields[0].value);
      return v;
    };
    const p0 = res.call.params[0].value;
    expect(p0.kind).toBe('array');
    if (p0.kind !== 'array' || p0.elements.length === 0) return;
    const leaf = walkToDeepestBytes(p0.elements[0]);
    expect(leaf.kind).toBe('bytes');
    if (leaf.kind === 'bytes') {
      expect(leaf.hex.startsWith('0x')).toBe(true);
    }
  });

  it('multiSend: zero packed operations yields empty array', async () => {
    const iface = new Interface(['function multiSend(bytes transactions)']);
    const data = iface.encodeFunctionData('multiSend', ['0x']);
    const res = await decodeCalldata(data, opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const packed = res.call.params[0].value;
    expect(packed.kind).toBe('array');
    if (packed.kind === 'array') expect(packed.elements).toHaveLength(0);
  });

  it.each([
    { operation: 0, expectedLabel: 'CALL' as const },
    { operation: 1, expectedLabel: 'DELEGATECALL' as const },
    { operation: 2, expectedLabel: 'CREATE' as const },
  ])(
    'multiSend: single packed op (empty inner) — $expectedLabel',
    async ({ operation, expectedLabel }) => {
      const segment = packGnosisMultiSendOperation(
        operation,
        '0x0000000000000000000000000000000000000001',
        0n,
        '0x',
      );
      const iface = new Interface(['function multiSend(bytes transactions)']);
      const data = iface.encodeFunctionData('multiSend', [`0x${segment}`]);
      const res = await decodeCalldata(data, opts);
      expect(res.status).toBe('success');
      if (res.status !== 'success') return;
      const packed = res.call.params[0].value;
      expect(packed.kind).toBe('array');
      if (packed.kind !== 'array') return;
      expect(packed.elements).toHaveLength(1);
      const row = packed.elements[0];
      expect(row.kind).toBe('tuple');
      if (row.kind !== 'tuple') return;
      expect(row.fields[0].value.kind).toBe('primitive');
      if (row.fields[0].value.kind !== 'primitive') return;
      expect(row.fields[0].value.display).toBe(expectedLabel);
      expect(row.fields[1].value.kind).toBe('address');
    },
  );

  it('multiSend: CREATE (0x02) with non-empty inner bytes preserves payload length', async () => {
    const initLike = '0x6080604052348015600f57600080fd'; // synthetic “constructor code” hex
    const seg = packGnosisMultiSendOperation(
      2,
      '0x00000000000000000000000000000000000000aa',
      0n,
      initLike,
    );
    const iface = new Interface(['function multiSend(bytes transactions)']);
    const data = iface.encodeFunctionData('multiSend', [`0x${seg}`]);
    const res = await decodeCalldata(data, opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const packed = res.call.params[0].value;
    expect(packed.kind).toBe('array');
    if (packed.kind !== 'array' || packed.elements.length === 0) return;
    const row = packed.elements[0];
    expect(row.kind).toBe('tuple');
    if (row.kind !== 'tuple') return;
    expect(row.fields[0].value.kind).toBe('primitive');
    if (row.fields[0].value.kind !== 'primitive') return;
    expect(row.fields[0].value.display).toBe('CREATE');
    const dataField = row.fields[3];
    expect(dataField.type).toBe('bytes');
    expect(dataField.value.kind).toBe('bytes');
    if (dataField.value.kind !== 'bytes') return;
    expect(dataField.value.hex.toLowerCase()).toBe(initLike.toLowerCase());
  });

  it('multiSend: caps packed operations and reports decodeWarningSink', async () => {
    const cap = DEFAULT_MAX_MULTISEND_OPERATIONS;
    const segments = Array.from({ length: cap + 1 }, () =>
      packGnosisMultiSendOperation(0, '0x0000000000000000000000000000000000000002', 0n, '0x'),
    ).join('');
    const iface = new Interface(['function multiSend(bytes transactions)']);
    const data = iface.encodeFunctionData('multiSend', [`0x${segments}`]);
    const decodeWarningSink: TxWarning[] = [];
    const res = await decodeCalldata(data, { ...opts, decodeWarningSink });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const packed = res.call.params[0].value;
    if (packed.kind !== 'array') return;
    expect(packed.elements.length).toBe(cap);
    expect(decodeWarningSink.some(w => w.title === 'multiSend payload truncated')).toBe(true);
  });

  it('user ABI incompatible with calldata layout fails decode without throwing (fail-soft)', async () => {
    const inner = new Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [
      '0x00000000000000000000000000000000000000aa',
      1n,
    ]);
    const iface = new Interface(['function execTransaction(address,uint256,bytes,uint8)']);
    const data = iface.encodeFunctionData('execTransaction', [
      '0x00000000000000000000000000000000000000bb',
      0n,
      inner,
      0,
    ]);
    const wrongAbi = JSON.stringify([
      'function execTransaction(address to,uint256 value,address data,uint8 operation)',
    ]);
    const res = await decodeCalldata(data, { ...opts, userAbi: wrongAbi });
    expect(res.status).toBe('error');
  });
});

describe('decodeCalldata — Across SpokePool deposit', () => {
  it('uses bundled names, embedded bytes32 addresses, and USDC amount formatting', async () => {
    const res = await decodeCalldata(ACROSS_SPOKE_DEPOSIT_MAINNET, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
      resolveEns: false,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;

    expect(res.call.signature.selector).toBe('0xad5425c6');
    expect(res.call.signature.name).toBe('deposit');
    expect(res.call.params[0]?.name).toBe('depositor');
    expect(res.call.params[2]?.name).toBe('inputToken');

    const depositor = res.call.params[0]?.value;
    expect(depositor?.kind).toBe('primitive');
    if (depositor?.kind !== 'primitive') return;
    expect(depositor.embeddedEvmAddress?.checksummed.toLowerCase()).toBe(
      '0x1808db50d1f8c8b2cd0b0f00938f2ccf94b2b563',
    );
    expect(depositor.interpretation ?? '').not.toMatch(/bytes32-wrapped/i);

    const inputAmount = res.call.params.find(p => p.name === 'inputAmount')?.value;
    expect(inputAmount?.kind).toBe('primitive');
    if (inputAmount?.kind !== 'primitive') return;
    expect(inputAmount.interpretation).toMatch(/USDC/i);
    expect(inputAmount.interpretation).toMatch(/≈\s*\$/i);

    const dest = res.call.params.find(p => p.name === 'destinationChainId')?.value;
    expect(dest?.kind).toBe('primitive');
    if (dest?.kind === 'primitive') {
      expect(dest.interpretation).toMatch(/HyperEVM/i);
      expect(dest.interpretation).toMatch(/chain ID 999/i);
    }

    const warns = analyzeWarnings(res.call, undefined, { chainId: 1 });
    expect(warns.some(w => w.title === 'Across Protocol bridge')).toBe(true);
    const across = warns.find(w => w.title === 'Across Protocol bridge');
    expect(across?.context).toMatch(/Across SpokePool V2/i);
    expect(across?.context).toMatch(/0xad5425c6/i);
    expect(across?.message).toMatch(/USDC/i);
    expect(across?.message).toMatch(/HyperEVM/i);
    expect(across?.message).toMatch(/999/);
    expect(across?.message).toMatch(/not verified on-chain/i);
    expect(across?.message).toMatch(/Decoded.*destinationChainId/i);
  });
});

describe('decodeCalldata — ERC-4626 withdraw (underlying via asset())', () => {
  it('formats assets using asset() on callTarget (mocked) + static USDC on Arbitrum', async () => {
    const spy = vi
      .spyOn(abiRegistry, 'fetchErc4626UnderlyingAsset')
      .mockResolvedValue('0xAf88D065e77C8cC2239327C5EDb3A432268e5831');
    try {
      const hex =
        '0xb460af94000000000000000000000000000000000000000000000000000000001b5bc8c00000000000000000000000008a7f162daac546997cc36b6b7c528a21800507b90000000000000000000000008a7f162daac546997cc36b6b7c528a21800507b9';
      const res = await decodeCalldata(hex, {
        ...DEFAULT_DECODE_OPTIONS,
        chainId: 42161,
        offlineMode: true,
        callTarget: '0x1111111111111111111111111111111111111111',
      });
      expect(res.status).toBe('success');
      if (res.status !== 'success') return;
      expect(res.call.signature.selector).toBe('0xb460af94');
      const assets = res.call.params[0];
      expect(assets?.name).toBe('assets');
      expect(assets?.value.kind).toBe('primitive');
      if (assets?.value.kind !== 'primitive') return;
      expect(assets.value.interpretation).toMatch(/USDC/i);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('decodeCalldata — LayerZero OFT send (USDT0)', () => {
  it('formats amountLD / minAmountLD using the OFT at transaction to (callTarget)', async () => {
    const res = await decodeCalldata(USDT0_LZ_SEND_MAINNET, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
      callTarget: USDT0_OFT_MAINNET,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;

    expect(res.call.signature.selector).toBe('0xc7c7f5b3');
    expect(res.call.signature.name).toBe('send');

    const sendParam = res.call.params[0];
    expect(sendParam?.value.kind).toBe('tuple');
    if (sendParam?.value.kind !== 'tuple') return;
    const amt = sendParam.value.fields[2];
    const minAmt = sendParam.value.fields[3];
    expect(amt?.value.kind).toBe('primitive');
    expect(minAmt?.value.kind).toBe('primitive');
    if (amt?.value.kind !== 'primitive' || minAmt?.value.kind !== 'primitive') return;

    expect(amt.value.interpretation).toMatch(/USDT0/i);
    expect(amt.value.interpretation).toMatch(/4[,.]?983/i);
    expect(minAmt.value.interpretation).toMatch(/USDT0/i);
  });
});

describe('decodeCalldata — Curve router exchange (stable)', () => {
  it('maps _amount / _min_dy to first and last resolvable tokens in _route (USDC → USDT)', async () => {
    const res = await decodeCalldata(CURVE_EXCHANGE_MAINNET_INPUT, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;

    expect(res.call.signature.name).toBe('exchange');
    expect(res.call.signature.selector).toBe('0x5c9c18e2');

    const amount = res.call.params.find(p => p.name === '_amount');
    const minDy = res.call.params.find(p => p.name === '_min_dy');
    expect(amount?.value.kind).toBe('primitive');
    expect(minDy?.value.kind).toBe('primitive');
    if (amount?.value.kind !== 'primitive' || minDy?.value.kind !== 'primitive') return;

    expect(amount.value.interpretation).toMatch(/USDC/i);
    expect(amount.value.interpretation).toMatch(/assumes \$1 peg/i);
    expect(minDy.value.interpretation).toMatch(/USDT/i);
    expect(minDy.value.interpretation).toMatch(/assumes \$1 peg/i);

    const swapParams = res.call.params.find(p => p.name === '_swap_params');
    expect(swapParams?.value.kind).toBe('array');
    if (swapParams?.value.kind !== 'array') return;
    const hop0 = swapParams.value.elements[0];
    expect(hop0.kind).toBe('array');
    if (hop0.kind !== 'array') return;
    const st = hop0.elements[2];
    expect(st.kind).toBe('primitive');
    if (st.kind !== 'primitive') return;
    expect(st.interpretation).toMatch(/exchange_underlying/);
    const pt = hop0.elements[3];
    expect(pt.kind).toBe('primitive');
    if (pt.kind !== 'primitive') return;
    expect(pt.interpretation).toMatch(/stable-ng/);
    const nc = hop0.elements[4];
    expect(nc.kind).toBe('primitive');
    if (nc.kind !== 'primitive') return;
    expect(nc.interpretation).toMatch(/n_coins: 3/);

    const hop1 = swapParams.value.elements[1];
    if (hop1.kind === 'array' && hop1.elements[0]?.kind === 'primitive') {
      expect(hop1.elements[0].interpretation).toMatch(/unused row/);
    }

    expect({
      signature: res.call.signature.name,
      selector: res.call.signature.selector,
      confidence: res.call.confidence,
      params: res.call.params.map(p => ({ name: p.name, type: p.type })),
    }).toMatchSnapshot();
  });
});

describe('decodeCalldata — Enso routeMulti', () => {
  it('uses bundled routeMulti((uint8,bytes)[],bytes) with exact confidence', async () => {
    const iface = new Interface(['function routeMulti((uint8,bytes)[],bytes)']);
    const calldata = iface.encodeFunctionData('routeMulti', [
      [
        [0, '0x' + 'ab'.repeat(8)],
        [1, '0xface'],
      ],
      '0xcafe',
    ]);
    const res = await decodeCalldata(calldata, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
      callTarget: '0xf75584ef6673ad213a685a1b58cc0330b8ea22cf',
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    expect(res.call.confidence).toBe('exact');
    expect(res.call.signature.name).toBe('routeMulti');
    expect(res.call.signature.textSignature).toContain('uint8');
    const warns = analyzeWarnings(res.call, undefined, {
      chainId: 1,
      txTo: '0xf75584ef6673ad213a685a1b58cc0330b8ea22cf',
    });
    expect(warns.some(w => w.title === 'Enso routeMulti')).toBe(true);
  });

  it('expands routeData executeShortcut and nested commands[] calldata', async () => {
    const inner = new Interface([
      'function executeShortcut(bytes32,bytes32,bytes32[],bytes[])',
      'function transfer(address,uint256)',
    ]);
    const transferTo = '0x2222222222222222222222222222222222222222';
    const transferAmt = 1_234_567_890_123_456_789n;
    const cmd = inner.encodeFunctionData('transfer', [transferTo, transferAmt]);
    const routeData = inner.encodeFunctionData('executeShortcut', [
      '0x' + '11'.repeat(32),
      '0x' + '22'.repeat(32),
      [],
      [cmd],
    ]);
    const iface = new Interface(['function routeMulti((uint8,bytes)[],bytes)']);
    const calldata = iface.encodeFunctionData('routeMulti', [[[0, '0x' + '00'.repeat(32)]], routeData]);
    const res = await decodeCalldata(calldata, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
      callTarget: '0xf75584ef6673ad213a685a1b58cc0330b8ea22cf',
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const routeParam = res.call.params.find(p => p.name === 'routeData');
    expect(routeParam?.value.kind).toBe('bytes');
    if (routeParam?.value.kind !== 'bytes') return;
    expect(routeParam.value.decoded?.signature.name).toBe('executeShortcut');
    const commands = routeParam.value.decoded?.params.find(p => p.name === 'commands');
    expect(commands?.value.kind).toBe('array');
    if (commands?.value.kind !== 'array') return;
    expect(commands.value.elements[0]?.kind).toBe('bytes');
    const el0 = commands.value.elements[0];
    if (el0?.kind !== 'bytes') return;
    expect(el0.decoded?.signature.name).toBe('transfer');
    const toP = el0.decoded?.params.find(p => p.name === 'to');
    const amountP = el0.decoded?.params.find(p => p.name === 'amount');
    expect(toP?.value.kind).toBe('address');
    expect(amountP?.value.kind).toBe('primitive');
    if (amountP?.value.kind === 'primitive') {
      expect(amountP.value.raw).toBe(transferAmt.toString());
    }
    const warns = analyzeWarnings(res.call, undefined, {
      chainId: 1,
      txTo: '0xf75584ef6673ad213a685a1b58cc0330b8ea22cf',
    });
    expect(warns.some(w => w.title === 'Enso executeShortcut')).toBe(true);
  });

  it('executeShortcut leaves[] are opaque bytes32 with UI copy (not nested calldata)', async () => {
    const iface = new Interface(['function executeShortcut(bytes32,bytes32,bytes32[],bytes[])']);
    const calldata = iface.encodeFunctionData('executeShortcut', [
      '0x' + '11'.repeat(32),
      '0x' + '22'.repeat(32),
      ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32)],
      [],
    ]);
    const res = await decodeCalldata(calldata, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    expect(res.call.signature.name).toBe('executeShortcut');
    const leaves = res.call.params.find(p => p.name === 'leaves');
    expect(leaves?.value.kind).toBe('array');
    if (leaves?.value.kind !== 'array') return;
    expect(leaves.value.elements.length).toBe(2);
    for (const el of leaves.value.elements) {
      expect(el.kind).toBe('primitive');
      if (el.kind !== 'primitive') continue;
      expect(el.interpretation).toMatch(/Opaque 32-byte word/);
      expect(el.interpretation).toMatch(/Enso route leaf id/);
      expect(el.interpretation).toMatch(/commands\[\]/);
    }
  });

  it('unwraps Enso length-prefixed executeShortcut commands[] entries to nested calldata', async () => {
    const innerIface = new Interface([
      'function executeShortcut(bytes32,bytes32,bytes32[],bytes[])',
      'function transfer(address,uint256)',
    ]);
    const transferData = innerIface.encodeFunctionData('transfer', [
      '0x2222222222222222222222222222222222222222',
      420n,
    ]);
    const innerBytes = getBytes(transferData);
    const wrappedCmd = hexlify(
      concat([getBytes(zeroPadValue(toBeHex(innerBytes.length), 32)), innerBytes]),
    );
    const routeData = innerIface.encodeFunctionData('executeShortcut', [
      '0x' + 'aa'.repeat(32),
      '0x' + 'bb'.repeat(32),
      [],
      [wrappedCmd],
    ]);
    const outerIface = new Interface(['function routeMulti((uint8,bytes)[],bytes)']);
    const calldata = outerIface.encodeFunctionData('routeMulti', [[[0, '0x' + '00'.repeat(32)]], routeData]);
    const res = await decodeCalldata(calldata, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const routeParam = res.call.params.find(p => p.name === 'routeData');
    if (routeParam?.value.kind !== 'bytes' || !routeParam.value.decoded) return;
    const commands = routeParam.value.decoded.params.find(p => p.name === 'commands');
    expect(commands?.value.kind).toBe('array');
    if (commands?.value.kind !== 'array') return;
    const cmd0 = commands.value.elements[0];
    expect(cmd0?.kind).toBe('bytes');
    if (cmd0?.kind !== 'bytes') return;
    expect(cmd0.decoded?.signature.name).toBe('transfer');
  });
});

describe('decodeCalldata — token context safety (Uniswap V3 / 1inch)', () => {
  it('exactInputSingle keeps deadline as timestamp when only tokenIn is registry-resolved', async () => {
    const iface = new Interface([
      'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
    ]);
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const unknownToken = '0x0000000000000000000000000000000000000001';
    const calldata = iface.encodeFunctionData('exactInputSingle', [
      [
        usdc,
        unknownToken,
        3000,
        usdc,
        1700000000n,
        1_000_000n,
        0n,
        0n,
      ],
    ]);
    const res = await decodeCalldata(calldata, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const paramsT = res.call.params[0];
    expect(paramsT?.value.kind).toBe('tuple');
    if (paramsT?.value.kind !== 'tuple') return;
    const f4 = paramsT.value.fields[4];
    expect(f4.value.kind).toBe('primitive');
    if (f4.value.kind !== 'primitive') return;
    expect(f4.value.interpretation).toMatch(/Timestamp:/);
    expect(f4.value.interpretation ?? '').not.toMatch(/USDC/);
    const f5 = paramsT.value.fields[5];
    expect(f5.value.kind).toBe('primitive');
    if (f5.value.kind === 'primitive') {
      expect(f5.value.interpretation).toMatch(/USDC/);
    }
    expect(paramsT.fieldHint).toMatch(/Uniswap V3 single-pool/i);
    expect(paramsT.value.fields[2].fieldHint).toMatch(/fee tier/i);
    expect(paramsT.value.fields[4].fieldHint).toMatch(/Deadline/i);
    expect(paramsT.value.fields[5].fieldHint).toMatch(/amountIn/i);
    expect(paramsT.value.fields[6].fieldHint).toMatch(/amountOutMinimum/i);
    expect(paramsT.value.fields[7].fieldHint).toMatch(/sqrtPriceLimitX96/i);
  });

  it('exactOutputSingle params tuple gets field hints (amountOut / amountInMaximum)', async () => {
    const iface = new Interface([
      'function exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
    ]);
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const calldata = iface.encodeFunctionData('exactOutputSingle', [
      [
        usdc,
        weth,
        3000,
        usdc,
        1700000000n,
        1_000_000n,
        2_000_000n,
        0n,
      ],
    ]);
    const res = await decodeCalldata(calldata, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const paramsT = res.call.params[0];
    expect(paramsT?.value.kind).toBe('tuple');
    if (paramsT?.value.kind !== 'tuple') return;
    expect(paramsT.fieldHint).toMatch(/exactOutput/i);
    expect(paramsT.value.fields[5].fieldHint).toMatch(/amountOut/i);
    expect(paramsT.value.fields[6].fieldHint).toMatch(/amountInMaximum/i);
  });

  it('1inch V6 swap does not token-format desc uint slots 6–7 (only 4–5)', async () => {
    const iface = new Interface([
      'function swap(address,(address,address,address,address,uint256,uint256,uint256,uint256,address,bytes),(uint256,uint256,uint256,bytes)[])',
    ]);
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const huge = 1n << 200n;
    const desc = [
      usdc,
      weth,
      usdc,
      usdc,
      1_000_000n,
      0n,
      huge,
      42n,
      '0x0000000000000000000000000000000000000000',
      '0x',
    ] as const;
    const calldata = iface.encodeFunctionData('swap', [
      '0x0000000000000000000000000000000000000002',
      desc,
      [],
    ]);
    const res = await decodeCalldata(calldata, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const d = res.call.params.find(p => p.name === 'desc');
    expect(d?.value.kind).toBe('tuple');
    if (d?.value.kind !== 'tuple') return;
    for (const idx of [6, 7]) {
      const f = d.value.fields[idx];
      expect(f?.value.kind).toBe('primitive');
      if (f?.value.kind !== 'primitive') continue;
      expect(f.value.interpretation ?? '').not.toMatch(/USDC/);
      expect(f.value.interpretation ?? '').not.toMatch(/≈\s*\$/);
    }
    expect(d.fieldHint).toMatch(/1inch swap descriptor/i);
    expect(d.value.fields[4].fieldHint).toMatch(/srcToken|Amount of srcToken/i);
    expect(d.value.fields[6].fieldHint).toMatch(/flags|Router flags/i);
  });
});

describe('decodeCalldata — AbortSignal', () => {
  it('rejects with AbortError when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const transfer =
      '0xa9059cbb00000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000f4240';
    await expect(decodeCalldata(transfer, { ...opts, signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects with AbortError when aborted while awaiting initEthers (deterministic mid-decode)', async () => {
    const ac = new AbortController();
    let releaseInit!: () => void;
    const initGate = new Promise<void>(resolve => {
      releaseInit = resolve;
    });
    const spy = vi.spyOn(signatureLookup, 'initEthers').mockImplementation(() => initGate);

    const transfer =
      '0xa9059cbb00000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000f4240';
    const p = decodeCalldata(transfer, { ...opts, signal: ac.signal });

    await Promise.resolve();
    ac.abort();
    releaseInit!();

    try {
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('decodeCalldata — Pendle swapTokensToTokens (0xa373cf1a)', () => {
  it('expands nested calldata in (uint8,address,bytes,bool) swap steps', async () => {
    const iface = new Interface([
      'function swapTokensToTokens(address,(address,address,uint256,(uint8,address,bytes,bool))[],uint256[])',
    ]);
    const inner = new Interface(['function transfer(address,uint256)']);
    const transferData = inner.encodeFunctionData('transfer', [
      '0x2222222222222222222222222222222222222222',
      420n,
    ]);
    const calldata = iface.encodeFunctionData('swapTokensToTokens', [
      '0x3333333333333333333333333333333333333333',
      [
        [
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          100n,
          [0, '0xcccccccccccccccccccccccccccccccccccccccc', transferData, true],
        ],
      ],
      [42n],
    ]);
    const res = await decodeCalldata(calldata, {
      ...DEFAULT_DECODE_OPTIONS,
      chainId: 1,
      offlineMode: true,
    });
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    expect(res.call.signature.name).toBe('swapTokensToTokens');
    const swapData = res.call.params.find(p => p.name === 'swapData');
    expect(swapData?.value.kind).toBe('array');
    if (swapData?.value.kind !== 'array') return;
    const row0 = swapData.value.elements[0];
    expect(row0?.kind).toBe('tuple');
    if (row0?.kind !== 'tuple') return;
    const stepTuple = row0.fields[3];
    expect(stepTuple.value.kind).toBe('tuple');
    if (stepTuple.value.kind !== 'tuple') return;
    const bytesField = stepTuple.value.fields[2];
    expect(bytesField.value.kind).toBe('bytes');
    if (bytesField.value.kind !== 'bytes') return;
    expect(bytesField.value.decoded?.signature.name).toBe('transfer');
  });
});

describe('swapCompact (0x83bd37f9)', () => {
  it('decodes non-standard packed tail when signature DBs list zero-arg swapCompact()', async () => {
    const hex =
      '0x83bd37f900013432b6a60d23ca0dfca7761b7ab56459d9c964d0000104acaf8d2865c0714f79da09645c13fd2888977f0914d03a432bb5e185fa0914fa8f1f902e9500000147ae00017882570840a97a490a37bd8db9e1ae39165bfbd6000154e4fc3bcf24610a190d68130432562df2cb6d9a00018a7f162daac546997cc36b6b7c528a21800507b93acfc7f503010203006701010001020100ff0000000000000000000000000000000000000054e4fc3bcf24610a190d68130432562df2cb6d9a3432b6a60d23ca0dfca7761b7ab56459d9c964d0000000000000000000000000000000000000000000000000';
    const res = await decodeCalldata(hex, opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    expect(res.call.signature.name).toBe('swapCompact');
    expect(res.call.params).toHaveLength(1);
    expect(res.call.params[0].name).toBe('compactPayload');
    expect(res.call.params[0].value.kind).toBe('bytes');
    expect(res.call.params[0].fieldHint).toMatch(/non-standard/);
  });

  it('finds nested standard calldata after a short packed prologue (heuristic offset scan)', async () => {
    const approveBody =
      '095ea7b3' +
      '0000000000000000000000001111111111111111111111111111111111111111' +
      '000000000000000000000000000000000000000000000000000000000000000001';
    const tail = `deadbeef${approveBody}`;
    const hex = `0x83bd37f9${tail}`;
    const res = await decodeCalldata(hex, opts);
    expect(res.status).toBe('success');
    if (res.status !== 'success') return;
    const compact = res.call.params[0]?.value;
    expect(compact?.kind).toBe('bytes');
    if (compact?.kind !== 'bytes') return;
    expect(compact.decoded?.signature.name).toBe('approve');
    expect(compact.decoded?.params).toHaveLength(2);
  });
});

describe('decoder helpers', () => {
  describe('toRawHex', () => {
    it('adds 0x to bare hex strings', () => {
      expect(toRawHex('deadbeef')).toBe('0xdeadbeef');
    });

    it('preserves 0x and normalizes 0X prefix', () => {
      expect(toRawHex('0xabc')).toBe('0xabc');
      expect(toRawHex('0XAbC')).toBe('0xAbC');
    });

    it('hexlifies Uint8Array', () => {
      expect(toRawHex(new Uint8Array([1, 2, 3]))).toBe('0x010203');
    });

    it('throws RangeError on invalid hex characters', () => {
      expect(() => toRawHex('0xGG')).toThrow(RangeError);
    });
  });

  describe('parseFixedAbiArraySuffix', () => {
    it('parses trailing fixed dimension without regex backtracking risk', () => {
      expect(parseFixedAbiArraySuffix('uint256[3]')).toEqual({ baseType: 'uint256', length: 3 });
      expect(parseFixedAbiArraySuffix('(address,uint256,bytes)[][2]')).toEqual({
        baseType: '(address,uint256,bytes)[]',
        length: 2,
      });
    });

    it('returns null for oversized type strings', () => {
      const long = `${'a'.repeat(4096)}[1]`;
      expect(long.length).toBeGreaterThan(4096);
      expect(parseFixedAbiArraySuffix(long)).toBeNull();
    });
  });

  describe('splitTupleTypes', () => {
    it('splits deeply nested array tuple forms (inner of ((t)[][],u) after one unwrap)', () => {
      const inner = '(address,uint256)[][],bytes32';
      expect(splitTupleTypes(inner)).toEqual(['(address,uint256)[][]', 'bytes32']);
      const param = ParamType.from(`(${inner})`);
      expect(splitTupleTypes(inner).length).toBe(param.components?.length ?? 0);
    });

    it('splits tuple containing array of tuples', () => {
      const inner = 'string,(address,bytes)[]';
      expect(splitTupleTypes(inner)).toEqual(['string', '(address,bytes)[]']);
      const param = ParamType.from(`(${inner})`);
      expect(splitTupleTypes(inner).length).toBe(param.components?.length ?? 0);
    });

    it('splits fixed array and plain types', () => {
      expect(splitTupleTypes('uint256[2],bytes')).toEqual(['uint256[2]', 'bytes']);
    });

    it('returns empty for blank inner', () => {
      expect(splitTupleTypes('')).toEqual([]);
      expect(splitTupleTypes('  ')).toEqual([]);
    });

    it('unwraps redundant outer tuple parentheses', () => {
      expect(splitTupleTypes('(uint256,bytes)')).toEqual(['uint256', 'bytes']);
      expect(splitTupleTypes('((uint256,bytes))')).toEqual(['uint256', 'bytes']);
    });

    it('preserves empty components between commas (arity)', () => {
      expect(splitTupleTypes('uint256,,bytes')).toEqual(['uint256', '', 'bytes']);
    });

    it('returns empty for empty tuple body after unwrap', () => {
      expect(splitTupleTypes('()')).toEqual([]);
    });
  });

  describe('isDynamicBytesSolidityType', () => {
    it('detects bytes and rejects bytes32', () => {
      expect(isDynamicBytesSolidityType('bytes')).toBe(true);
      expect(isDynamicBytesSolidityType(' bytes ')).toBe(true);
      expect(isDynamicBytesSolidityType('bytes32')).toBe(false);
      expect(isDynamicBytesSolidityType('uint256')).toBe(false);
    });

    it('detects bytes inside tuple(...) and anonymous (...)', () => {
      expect(isDynamicBytesSolidityType('tuple(uint256,bytes)')).toBe(true);
      expect(isDynamicBytesSolidityType('(uint256,bytes)')).toBe(true);
      expect(isDynamicBytesSolidityType('tuple(address,address)')).toBe(false);
      expect(isDynamicBytesSolidityType('(bytes)')).toBe(true);
    });

    it('handles nested tuples', () => {
      expect(isDynamicBytesSolidityType('tuple(uint256,tuple(bytes))')).toBe(true);
      expect(isDynamicBytesSolidityType('(uint256,(bytes,address))')).toBe(true);
    });

    it('detects bytes inside array-of-tuples types (Pendle-style swap steps)', () => {
      expect(isDynamicBytesSolidityType('(uint8,address,bytes,bool)[]')).toBe(true);
      expect(isDynamicBytesSolidityType('(address,bool)[]')).toBe(false);
    });
  });
});
