/**
 * Property / fuzz tests: random and adversarial calldata must never crash the decoder, hang it, or produce output
 * the warning pass can't handle. Offline (bundled signatures only) so runs are deterministic and fast.
 *
 * CI uses a modest run count; for a deep local run: `FUZZ_RUNS=20000 npx vitest run src/lib/decoder.fuzz.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AbiCoder, Interface, getBytes, hexlify, solidityPacked } from 'ethers';

import { decodeCalldata } from './decoder.ts';
import { analyzeWarnings } from './warningAnalyzer.ts';
import { getBundledSignaturesForTests } from './abiRegistry.ts';
import { DEFAULT_DECODE_OPTIONS, type DecodedCalldataOutcome, type TxWarning } from '../types/index.ts';

const RUNS = Number(process.env.FUZZ_RUNS ?? 150);
const opts = { ...DEFAULT_DECODE_OPTIONS, chainId: 1, offlineMode: true, resolveEns: false, fetchTokenDecimalsOnChain: false };
/** Per-decode wall-clock ceiling. Real calldata decodes in < 100 ms offline; this only catches blow-ups. */
const MAX_DECODE_MS = 2_000;

const coder = AbiCoder.defaultAbiCoder();
const BUNDLED_SELECTORS = [...new Set(getBundledSignaturesForTests().map(s => s.selector))];

const hex = (minBytes: number, maxBytes: number) =>
  fc.uint8Array({ minLength: minBytes, maxLength: maxBytes }).map(b => hexlify(b).slice(2));

/** 32-byte words biased toward the values that break ABI decoders: 0, small, huge, offsets, max. */
const nastyWord = fc.oneof(
  fc.constant('00'.repeat(32)),
  fc.constant('ff'.repeat(32)),
  fc.integer({ min: 0, max: 4096 }).map(n => n.toString(16).padStart(64, '0')),
  fc.bigInt({ min: 0n, max: (1n << 256n) - 1n }).map(n => n.toString(16).padStart(64, '0')),
  fc.constantFrom('00'.repeat(31) + '20', '00'.repeat(31) + '40', '00'.repeat(28) + 'ffffffff', '80' + '00'.repeat(31)),
);
const nastyBody = fc.array(nastyWord, { minLength: 0, maxLength: 24 }).map(ws => ws.join(''));

async function decodeChecked(calldata: string): Promise<DecodedCalldataOutcome> {
  const sink: TxWarning[] = [];
  const t0 = performance.now();
  const res = await decodeCalldata(calldata, { ...opts, decodeWarningSink: sink });
  const ms = performance.now() - t0;
  expect(ms, `decode took ${ms.toFixed(0)} ms for ${calldata.slice(0, 74)}…`).toBeLessThan(MAX_DECODE_MS);
  expect(['success', 'partial', 'error']).toContain(res.status);
  if (res.status === 'success' || res.status === 'partial') {
    // The warning pass and JSON export must handle whatever the decoder produced.
    expect(() => analyzeWarnings(res.call, '0', { chainId: 1 })).not.toThrow();
    expect(() => JSON.stringify(res, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toThrow();
  }
  return res;
}

describe('decoder fuzz', () => {
  it('never throws or hangs on random bytes', async () => {
    await fc.assert(
      fc.asyncProperty(hex(0, 600), async body => {
        await decodeChecked(`0x${body}`);
      }),
      { numRuns: RUNS },
    );
  });

  it('never throws or hangs on bundled selectors with adversarial argument words', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...BUNDLED_SELECTORS), nastyBody, async (selector, body) => {
        await decodeChecked(`${selector}${body}`);
      }),
      { numRuns: RUNS * 4 },
    );
  });

  it('handles nested multicall / Safe / router payloads built from random inner bytes', async () => {
    const mc = new Interface([
      'function multicall(bytes[] data)',
      'function aggregate3((address target,bool allowFailure,bytes callData)[] calls)',
      'function multiSend(bytes transactions)',
      'function execute(bytes commands,bytes[] inputs,uint256 deadline)',
      'function executeShortcut(bytes32,bytes32,bytes32[],bytes[])',
    ]);
    const inner = fc.oneof(
      hex(0, 200).map(h => `0x${h}`),
      fc.tuple(fc.constantFrom(...BUNDLED_SELECTORS), nastyBody).map(([s, b]) => `${s}${b}`),
    );
    const payload = fc.oneof(
      fc.array(inner, { maxLength: 6 }).map(xs => mc.encodeFunctionData('multicall', [xs])),
      fc.array(inner, { maxLength: 6 }).map(xs =>
        mc.encodeFunctionData('aggregate3', [xs.map(x => ['0x' + '11'.repeat(20), false, x])]),
      ),
      fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), inner, fc.boolean()), { maxLength: 5 }).map(rows => {
        // Optionally lie about dataLength to exercise truncation handling.
        const packed = rows
          .map(([op, data, lie]) => {
            const len = getBytes(data).length + (lie ? 1000 : 0);
            return solidityPacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [op, '0x' + '22'.repeat(20), 0, len, data]).slice(2);
          })
          .join('');
        return mc.encodeFunctionData('multiSend', [`0x${packed}`]);
      }),
      fc.tuple(hex(0, 8), fc.array(inner, { maxLength: 6 })).map(([cmds, ins]) =>
        mc.encodeFunctionData('execute', [`0x${cmds}`, ins, 0]),
      ),
      fc.tuple(fc.array(hex(32, 32).map(h => `0x${h}`), { maxLength: 6 }), fc.array(inner, { maxLength: 6 })).map(([c, s]) =>
        mc.encodeFunctionData('executeShortcut', ['0x' + '00'.repeat(32), '0x' + '00'.repeat(32), c, s]),
      ),
    );
    await fc.assert(
      fc.asyncProperty(payload, async calldata => {
        await decodeChecked(calldata);
      }),
      { numRuns: RUNS * 2 },
    );
  });

  it('stays bounded on deeply self-nested multicalls (recursion bomb)', async () => {
    const mc = new Interface(['function multicall(bytes[] data)']);
    let calldata = mc.encodeFunctionData('multicall', [[]]);
    for (let i = 0; i < 60; i++) calldata = mc.encodeFunctionData('multicall', [[calldata]]);
    const res = await decodeChecked(calldata);
    expect(res.status).toBe('success');
  });

  it('stays bounded when every array element points at the same bytes (shared-offset bomb)', async () => {
    // multicall(bytes[]) whose N offsets all reference ONE inner payload, nested: tiny input, N^depth naive work.
    const N = 200;
    const sel = '0xac9650d8';
    const sharedMulticall = (innerCalldata: string): string => {
      const inner = getBytes(innerCalldata);
      const padded = Math.ceil(inner.length / 32) * 32;
      const head = [
        (0x20).toString(16).padStart(64, '0'), // offset of the bytes[] param
        N.toString(16).padStart(64, '0'), // array length
        ...Array.from({ length: N }, () => (N * 32).toString(16).padStart(64, '0')), // every element -> same data
      ].join('');
      const data = inner.length.toString(16).padStart(64, '0') + hexlify(inner).slice(2).padEnd(padded * 2, '0');
      return sel + head + data;
    };
    let calldata = new Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', ['0x' + '11'.repeat(20), 1n]);
    for (let i = 0; i < 6; i++) calldata = sharedMulticall(calldata);
    expect((calldata.length - 2) / 2).toBeLessThan(60_000);
    const sink: TxWarning[] = [];
    const t0 = performance.now();
    await decodeCalldata(calldata, { ...opts, decodeWarningSink: sink });
    expect(performance.now() - t0).toBeLessThan(MAX_DECODE_MS);
    expect(sink.map(w => w.title)).toContain('Calldata reuses the same data many times');
  });

  it('round-trips canonical encodings of bundled signatures: same signature, no false trailing/non-canonical flags', async () => {
    // Simple, fully static signatures only, with random but valid values.
    const simple = getBundledSignaturesForTests().filter(
      s => s.params.length > 0 && s.params.every(p => /^(address|bool|uint(8|16|24|32|48|64|96|128|160|256)|bytes32)$/.test(p.type)),
    );
    const valueFor = (type: string) => {
      if (type === 'address') return fc.uint8Array({ minLength: 20, maxLength: 20 }).map(b => hexlify(b));
      if (type === 'bool') return fc.boolean();
      if (type === 'bytes32') return fc.uint8Array({ minLength: 32, maxLength: 32 }).map(b => hexlify(b));
      const bits = Number(type.slice(4));
      return fc.bigInt({ min: 0n, max: (1n << BigInt(bits)) - 1n });
    };
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...simple).chain(sig => fc.tuple(fc.constant(sig), fc.tuple(...sig.params.map(p => valueFor(p.type))))),
        async ([sig, values]) => {
          const calldata = sig.selector + coder.encode(sig.params.map(p => p.type), values).slice(2);
          const res = await decodeChecked(calldata);
          expect(res.status).toBe('success');
          if (res.status !== 'success') return;
          expect(res.call.selector).toBe(sig.selector);
          expect(res.call.unparsedTrailingHex).toBeUndefined();
          expect(res.call.nonCanonicalEncoding).toBeUndefined();
        },
      ),
      { numRuns: RUNS * 2 },
    );
  });
});
