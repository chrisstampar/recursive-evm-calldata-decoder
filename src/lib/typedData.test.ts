import { describe, it, expect } from 'vitest';
import { decodeCalldata } from './decoder.ts';
import { DEFAULT_DECODE_OPTIONS, type DecodedCall, type DecodeOptions } from '../types/index.ts';
import { annotateTypedDataCall, parseTypedData, typedDataToDecodeInput, typedDataWarnings } from './typedData.ts';
import { computeSafeTxHashes } from './safeHash.ts';
import { summarizeTransaction } from './txSummary.ts';

const OFFLINE: DecodeOptions = { ...DEFAULT_DECODE_OPTIONS, chainId: 1, offlineMode: true, resolveEns: false };
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const SPENDER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/** The example from the EIP-712 specification, with its published hashes. */
const MAIL = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};

async function decodeTyped(json: unknown): Promise<{ root: DecodedCall; td: ReturnType<typeof parseTypedData> }> {
  const td = parseTypedData(JSON.stringify(json));
  const input = typedDataToDecodeInput(td);
  const out = await decodeCalldata(input.calldata, { ...OFFLINE, userAbi: input.abi, callTarget: input.callTarget });
  if (out.status === 'error') throw new Error(out.error);
  await annotateTypedDataCall(out.call, td, OFFLINE);
  return { root: out.call, td };
}

function usdcPermit(value: string) {
  return {
    types: {
      EIP712Domain: MAIL.types.EIP712Domain,
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    domain: { name: 'USD Coin', version: '2', chainId: '1', verifyingContract: USDC },
    message: { owner: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826', spender: SPENDER, value, nonce: '0', deadline: '1893456000' },
  };
}

describe('parseTypedData', () => {
  it('reproduces the EIP-712 specification hashes', () => {
    const td = parseTypedData(JSON.stringify(MAIL));
    expect(td.hashes).toEqual({
      domainSeparator: '0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f',
      messageHash: '0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e',
      digest: '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2',
    });
    expect(td.chainId).toBe(1);
  });

  it('finds the typed data inside an eth_signTypedData_v4 request', () => {
    const request = { method: 'eth_signTypedData_v4', params: ['0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826', JSON.stringify(MAIL)] };
    expect(parseTypedData(JSON.stringify(request)).hashes.digest).toBe(
      '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2',
    );
  });

  it('refuses JSON numbers that lost precision', () => {
    const text = JSON.stringify(usdcPermit('0')).replace('"value":"0"', '"value":100000000000000000000');
    expect(() => parseTypedData(text)).toThrow(/message.value is a plain number above 2\^53/);
  });

  it('explains what is wrong with bad input', () => {
    expect(() => parseTypedData('not json')).toThrow(/Not valid JSON/);
    expect(() => parseTypedData('{"a":1}')).toThrow(/No EIP-712 typed data/);
    expect(() => parseTypedData(JSON.stringify({ ...MAIL, primaryType: 'Letter' }))).toThrow(/not defined/);
    const badAddress = { ...MAIL, message: { ...MAIL.message, to: { name: 'Bob', wallet: '0x12' } } };
    expect(() => parseTypedData(JSON.stringify(badAddress))).toThrow(/do not fit their declared types/);
  });
});

describe('typed data decoding', () => {
  it('shows an EIP-2612 permit amount in the signing token and warns about unlimited access', async () => {
    const { root, td } = await decodeTyped(usdcPermit('100000000'));
    expect(root.signature.name).toBe('Permit');
    expect(root.signature.source).toBe('typed-data');
    const value = root.params.find(p => p.name === 'value')!.value;
    expect(value.kind === 'primitive' && value.interpretation).toMatch(/^100 USDC/);
    expect(typedDataWarnings(td, root, 1)[0]).toMatchObject({ severity: 'warning', title: 'Signature gives token access' });

    const unlimited = await decodeTyped(usdcPermit('115792089237316195423570985008687907853269984665640564039457584007913129639935'));
    expect(typedDataWarnings(unlimited.td, unlimited.root, 1)[0].title).toBe('Signature gives unlimited token access');

    const steps = summarizeTransaction(root, 1).steps;
    expect(steps[0].parts.map(p => ('text' in p ? p.text : p.kind === 'address' ? p.label ?? p.address : '')).join('')).toMatch(
      /^Let .* spend 100 USDC/,
    );
  });

  it('decodes a Safe transaction signature as the execTransaction it authorises, with the same hash', async () => {
    const safe = '0xf9c3f17ea1647a6e51352860388dd04b08263e78';
    const tx = {
      to: USDC,
      value: '0',
      data: '0xa9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000005f5e100',
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: '12',
    };
    const json = {
      types: {
        EIP712Domain: [
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        SafeTx: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'operation', type: 'uint8' },
          { name: 'safeTxGas', type: 'uint256' },
          { name: 'baseGas', type: 'uint256' },
          { name: 'gasPrice', type: 'uint256' },
          { name: 'gasToken', type: 'address' },
          { name: 'refundReceiver', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      primaryType: 'SafeTx',
      domain: { chainId: 1, verifyingContract: safe },
      message: tx,
    };
    const td = parseTypedData(JSON.stringify(json));
    expect(td.hashes.digest).toBe(computeSafeTxHashes(1, safe, '1.3+', tx).safeTxHash);
    const input = typedDataToDecodeInput(td);
    expect(input.safeTx?.nonce).toBe('12');
    const out = await decodeCalldata(input.calldata, { ...OFFLINE, callTarget: input.callTarget });
    expect(out.status !== 'error' && out.call.signature.name).toBe('execTransaction');
  });

  it('flags a Seaport listing whose payments all go elsewhere', async () => {
    const item = [
      { name: 'itemType', type: 'uint8' },
      { name: 'token', type: 'address' },
      { name: 'identifierOrCriteria', type: 'uint256' },
      { name: 'startAmount', type: 'uint256' },
      { name: 'endAmount', type: 'uint256' },
    ];
    const json = {
      types: {
        OrderComponents: [
          { name: 'offerer', type: 'address' },
          { name: 'offer', type: 'OfferItem[]' },
          { name: 'consideration', type: 'ConsiderationItem[]' },
        ],
        OfferItem: item,
        ConsiderationItem: [...item, { name: 'recipient', type: 'address' }],
      },
      primaryType: 'OrderComponents',
      domain: { name: 'Seaport', version: '1.6', chainId: 1, verifyingContract: '0x0000000000000068F116a894984e2DB1123eB395' },
      message: {
        offerer: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826',
        offer: [{ itemType: 1, token: USDC, identifierOrCriteria: '0', startAmount: '5000000', endAmount: '5000000' }],
        consideration: [{ itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: SPENDER }],
      },
    };
    const { root, td } = await decodeTyped(json);
    const offer = root.params[1].value;
    const amount = offer.kind === 'array' && offer.elements[0].kind === 'tuple' ? offer.elements[0].fields[3].value : undefined;
    expect(amount?.kind === 'primitive' && amount.interpretation).toMatch(/^5 USDC/);
    expect(typedDataWarnings(td, root, 1).map(w => w.title)).toContain('Listing pays you nothing');
  });
});
