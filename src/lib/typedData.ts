/**
 * EIP-712 typed data: the structured messages wallets ask you to sign (`eth_signTypedData_v4`). A signature is not a
 * transaction, but a Permit, Permit2 approval, Seaport listing, or Safe transaction signature moves assets just the
 * same once someone submits it — and costs the signer no gas, which is why drainers ask for them.
 *
 * The message is ABI-encoded as a call named after its primary type and run through the normal decoder, so it gets
 * the same tree, token units, labels, and warnings as calldata. A `SafeTx` becomes the `execTransaction` it authorises.
 */
import { Interface, TypedDataEncoder, concat, getAddress, id, keccak256, type TypedDataField } from 'ethers';
import type { DecodedCall, DecodedParam, DecodedValue, DecodeOptions, TxWarning } from '../types/index.ts';
import { CHAINS, getKnownEvmChainName } from './chains.ts';
import { getContractName } from './abiRegistry.ts';
import { annotateTokenAmount } from './decoder.ts';
import { safeTxAsExecCalldata, type SafeTxFields } from './safeHash.ts';

const MAX_TYPED_DATA_CHARS = 256_000;
const MAX_TYPES = 64;
/** Domain fields in the order EIP-712 defines them (used when `types.EIP712Domain` is missing). */
const DOMAIN_FIELD_ORDER: TypedDataField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
  { name: 'salt', type: 'bytes32' },
];

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export interface TypedDataHashes {
  /** `hashStruct(EIP712Domain)`: hardware wallets show it as the domain hash. */
  domainSeparator: string;
  /** `hashStruct(message)`: hardware wallets show it as the message hash. */
  messageHash: string;
  /** `keccak256(0x1901 ‖ domainSeparator ‖ messageHash)`: the value actually signed. */
  digest: string;
}

export interface ParsedTypedData {
  primaryType: string;
  /** Types reachable from the primary type, without `EIP712Domain`. */
  types: Record<string, TypedDataField[]>;
  domainTypes: TypedDataField[];
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
  hashes: TypedDataHashes;
  chainId?: number;
  verifyingContract?: string;
  /** Problems with the input itself (domain fields left out of the signature). */
  notes: TxWarning[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Find the typed-data object in what people paste: the object itself, an `eth_signTypedData_v4` params array
 * (`[address, json]`), a whole JSON-RPC request, or any of these as a JSON string.
 */
function unwrapTypedData(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null;
  if (typeof value === 'string') {
    try {
      return unwrapTypedData(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = unwrapTypedData(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (isRecord(value.types) && (isRecord(value.message) || isRecord(value.value))) return value;
  if ('params' in value) return unwrapTypedData(value.params, depth + 1);
  return null;
}

/** Plain JSON numbers above 2^53 are rounded by `JSON.parse`, so the hash would not match what the wallet signs. */
function findUnsafeNumbers(v: unknown, path: string, out: string[]): void {
  if (out.length >= 5) return;
  if (typeof v === 'number' && !Number.isSafeInteger(v)) out.push(path);
  else if (Array.isArray(v)) v.forEach((x, i) => findUnsafeNumbers(x, `${path}[${i}]`, out));
  else if (isRecord(v)) for (const [k, x] of Object.entries(v)) findUnsafeNumbers(x, path ? `${path}.${k}` : k, out);
}

function baseTypeName(type: string): string {
  return type.replace(/(\[\d*\])+$/, '');
}

/** Types the primary type uses, directly or through other structs. Extra types would make ethers reject the set. */
function reachableTypes(
  all: Record<string, TypedDataField[]>,
  primaryType: string,
): Record<string, TypedDataField[]> {
  const out: Record<string, TypedDataField[]> = {};
  const visit = (name: string) => {
    if (out[name] || !all[name]) return;
    out[name] = all[name];
    for (const f of all[name]) visit(baseTypeName(f.type));
  };
  visit(primaryType);
  return out;
}

function checkFields(name: string, fields: unknown): TypedDataField[] {
  if (!Array.isArray(fields)) throw new Error(`types.${name} must be a list of { name, type } fields.`);
  return fields.map((f, i) => {
    if (!isRecord(f) || typeof f.name !== 'string' || typeof f.type !== 'string') {
      throw new Error(`types.${name}[${i}] must have a string name and type.`);
    }
    return { name: f.name, type: f.type };
  });
}

/** Parse and hash pasted typed data. Throws an `Error` with a message fit to show the user. */
export function parseTypedData(input: string): ParsedTypedData {
  if (input.length > MAX_TYPED_DATA_CHARS) throw new Error('Typed data is too large.');
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    throw new Error('Not valid JSON. Paste the typed data your wallet shows, or the eth_signTypedData_v4 request.');
  }
  const raw = unwrapTypedData(json);
  if (!raw) throw new Error('No EIP-712 typed data found. Expected an object with types, domain, primaryType, and message.');

  if (!isRecord(raw.types)) throw new Error('types must be an object.');
  const typeNames = Object.keys(raw.types);
  if (typeNames.length > MAX_TYPES) throw new Error(`Too many types (over ${MAX_TYPES}).`);
  const allTypes: Record<string, TypedDataField[]> = {};
  for (const name of typeNames) allTypes[name] = checkFields(name, raw.types[name]);

  const domain = isRecord(raw.domain) ? raw.domain : {};
  const message = (isRecord(raw.message) ? raw.message : raw.value) as Record<string, unknown>;
  const primaryType = typeof raw.primaryType === 'string' ? raw.primaryType : undefined;
  if (!primaryType) throw new Error('primaryType is missing.');
  if (primaryType === 'EIP712Domain') throw new Error('primaryType EIP712Domain signs only the domain; nothing to decode.');
  if (!allTypes[primaryType]) throw new Error(`primaryType ${primaryType} is not defined in types.`);

  const unsafe: string[] = [];
  findUnsafeNumbers({ domain, message }, '', unsafe);
  if (unsafe.length > 0) {
    throw new Error(
      `${unsafe.join(', ')} ${unsafe.length === 1 ? 'is a plain number' : 'are plain numbers'} above 2^53, which lose digits when read. Paste the typed data exactly as the wallet received it, with large numbers as quoted strings.`,
    );
  }

  const notes: TxWarning[] = [];
  let domainTypes = allTypes.EIP712Domain;
  if (!domainTypes) {
    domainTypes = DOMAIN_FIELD_ORDER.filter(f => domain[f.name] !== undefined);
  } else {
    const declared = new Set(domainTypes.map(f => f.name));
    const ignored = Object.keys(domain).filter(k => !declared.has(k));
    if (ignored.length > 0) {
      notes.push({
        severity: 'info',
        title: 'Domain fields not signed',
        context: `Typed data domain. Why: ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} not in types.EIP712Domain.`,
        message: 'Wallets leave these fields out of the signature, so they prove nothing.',
      });
    }
    const missing = domainTypes.filter(f => domain[f.name] === undefined).map(f => f.name);
    if (missing.length > 0) throw new Error(`domain is missing ${missing.join(', ')}, which types.EIP712Domain declares.`);
  }
  const signedDomain = Object.fromEntries(domainTypes.map(f => [f.name, domain[f.name]]));

  const types = reachableTypes(allTypes, primaryType);
  delete types.EIP712Domain;

  let hashes: TypedDataHashes;
  try {
    const domainSeparator =
      domainTypes.length === 0
        ? keccak256(id('EIP712Domain()'))
        : TypedDataEncoder.hashStruct('EIP712Domain', { EIP712Domain: domainTypes }, signedDomain);
    const messageHash = TypedDataEncoder.hashStruct(primaryType, types, message);
    hashes = { domainSeparator, messageHash, digest: keccak256(concat(['0x1901', domainSeparator, messageHash])) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const bad = /value="([^"]{1,80})"/.exec(msg)?.[1];
    const reason = `${msg.split(' (')[0]}${bad ? ` (${bad})` : ''}`;
    throw new Error(`The values do not fit their declared types: ${reason}.`, { cause: e });
  }

  let chainId: number | undefined;
  if (signedDomain.chainId !== undefined) {
    const n = Number(BigInt(String(signedDomain.chainId)));
    if (Number.isSafeInteger(n)) chainId = n;
  }
  let verifyingContract: string | undefined;
  if (typeof signedDomain.verifyingContract === 'string') {
    try {
      verifyingContract = getAddress(signedDomain.verifyingContract);
    } catch {
      /* hashing already validated it; unreachable */
    }
  }

  return { primaryType, types, domainTypes, domain: signedDomain, message, hashes, chainId, verifyingContract, notes };
}

type AbiParam = { name: string; type: string; components?: AbiParam[] };

function toAbiParam(field: TypedDataField, types: Record<string, TypedDataField[]>): AbiParam {
  const base = baseTypeName(field.type);
  const struct = types[base];
  if (!struct) return { name: field.name, type: field.type };
  return {
    name: field.name,
    type: `tuple${field.type.slice(base.length)}`,
    components: struct.map(f => toAbiParam(f, types)),
  };
}

/** Message values in the shape `AbiCoder` takes: structs as arrays in field order, bools as booleans. */
function toAbiValue(type: string, value: unknown, types: Record<string, TypedDataField[]>): unknown {
  const arr = /^(.*)\[(\d*)\]$/.exec(type);
  if (arr) {
    if (!Array.isArray(value)) throw new Error(`Expected a list for ${type}.`);
    return value.map(v => toAbiValue(arr[1], v, types));
  }
  const struct = types[type];
  if (struct) {
    if (!isRecord(value)) throw new Error(`Expected an object for ${type}.`);
    return struct.map(f => toAbiValue(f.type, value[f.name], types));
  }
  if (type === 'bool') return value === true || value === 'true';
  if (/^u?int\d*$/.test(type)) return BigInt(String(value));
  return value;
}

export interface TypedDataDecodeInput {
  calldata: string;
  /** ABI for the synthetic call; absent for a `SafeTx`, which decodes as a real `execTransaction`. */
  abi?: string;
  callTarget?: string;
  safeTx?: SafeTxFields;
}

const SAFE_TX_FIELDS = ['to', 'value', 'data', 'operation', 'safeTxGas', 'gasPrice', 'gasToken', 'refundReceiver', 'nonce'];

function asSafeTx(td: ParsedTypedData): SafeTxFields | null {
  if (td.primaryType !== 'SafeTx') return null;
  const m = td.message;
  if (!SAFE_TX_FIELDS.every(k => m[k] !== undefined) || (m.baseGas === undefined && m.dataGas === undefined)) return null;
  const s = (v: unknown) => String(v);
  return {
    to: s(m.to),
    value: s(m.value),
    data: s(m.data),
    operation: Number(m.operation),
    safeTxGas: s(m.safeTxGas),
    baseGas: s(m.baseGas ?? m.dataGas),
    gasPrice: s(m.gasPrice),
    gasToken: s(m.gasToken),
    refundReceiver: s(m.refundReceiver),
    nonce: s(m.nonce),
  };
}

/** Calldata (and ABI) that shows the typed message in the decode tree. */
export function typedDataToDecodeInput(td: ParsedTypedData): TypedDataDecodeInput {
  const safeTx = asSafeTx(td);
  if (safeTx) return { calldata: safeTxAsExecCalldata(safeTx), callTarget: td.verifyingContract, safeTx };

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(td.primaryType)) throw new Error(`primaryType ${td.primaryType} is not a valid name.`);
  const fields = td.types[td.primaryType];
  const fragment = { type: 'function', name: td.primaryType, stateMutability: 'nonpayable', inputs: fields.map(f => toAbiParam(f, td.types)), outputs: [] };
  const iface = new Interface([fragment]);
  const args = fields.map(f => toAbiValue(f.type, td.message[f.name], td.types));
  return { calldata: iface.encodeFunctionData(td.primaryType, args), abi: JSON.stringify([fragment]), callTarget: td.verifyingContract };
}

function param(call: DecodedCall, name: string): DecodedParam | undefined {
  return call.params.find(p => p.name === name);
}

function addr(v: DecodedValue | undefined): string | undefined {
  return v?.kind === 'address' ? v.checksummed : undefined;
}

/** `{ token, amount }` structs (Permit2 TokenPermissions, Seaport items): the amount in the token's units. */
async function annotateTokenPairs(v: DecodedValue | undefined, amountNames: string[], options: DecodeOptions): Promise<void> {
  if (!v) return;
  if (v.kind === 'array') {
    await Promise.all(v.elements.map(e => annotateTokenPairs(e, amountNames, options)));
    return;
  }
  if (v.kind !== 'tuple') return;
  const token = addr(v.fields.find(f => f.name === 'token')?.value);
  if (!token) return;
  const itemType = v.fields.find(f => f.name === 'itemType')?.value;
  // Seaport: only native (0) and ERC-20 (1) items have token amounts; NFTs count items.
  if (itemType?.kind === 'primitive' && itemType.raw !== '0' && itemType.raw !== '1') return;
  await Promise.all(
    v.fields.filter(f => amountNames.includes(f.name)).map(f => annotateTokenAmount(f.value, f.type, token, options)),
  );
}

/**
 * Token units the generic decoder cannot know: an EIP-2612 permit's amount is in the token that verifies the
 * signature (the domain's contract), and Permit2 / Seaport amounts sit next to their token in a struct.
 */
export async function annotateTypedDataCall(root: DecodedCall, td: ParsedTypedData, options: DecodeOptions): Promise<void> {
  root.signature = { ...root.signature, source: 'typed-data' };
  if (td.primaryType === 'Permit' && td.verifyingContract) {
    const value = param(root, 'value');
    if (value) await annotateTokenAmount(value.value, value.type, td.verifyingContract, options);
    const allowed = param(root, 'allowed');
    if (allowed?.value.kind === 'primitive' && allowed.value.raw === 'true') {
      allowed.value.interpretation = 'Unlimited: lets the spender take any amount of this token';
    }
  }
  await Promise.all([
    annotateTokenPairs(param(root, 'permitted')?.value, ['amount'], options),
    annotateTokenPairs(param(root, 'offer')?.value, ['startAmount', 'endAmount'], options),
    annotateTokenPairs(param(root, 'consideration')?.value, ['startAmount', 'endAmount'], options),
  ]);
}

const PERMIT_TYPES = new Set([
  'Permit',
  'PermitSingle',
  'PermitBatch',
  'PermitTransferFrom',
  'PermitBatchTransferFrom',
  'PermitWitnessTransferFrom',
  'PermitBatchWitnessTransferFrom',
]);

const MAX_UINT = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const ONE_YEAR_S = 365n * 24n * 3600n;

function rawBig(v: DecodedValue | undefined): bigint | undefined {
  if (v?.kind !== 'primitive') return undefined;
  try {
    return BigInt(v.raw);
  } catch {
    return undefined;
  }
}

/** Every primitive named one of `names`, anywhere in the call's arguments. */
function findAll(call: DecodedCall, names: string[]): DecodedValue[] {
  const out: DecodedValue[] = [];
  const visit = (name: string, v: DecodedValue) => {
    if (names.includes(name)) out.push(v);
    if (v.kind === 'tuple') v.fields.forEach(f => visit(f.name, f.value));
    else if (v.kind === 'array') v.elements.forEach(e => visit(name, e));
  };
  call.params.forEach(p => visit(p.name, p.value));
  return out;
}

/** What makes this signature risky, beyond what the calldata warnings already say. */
export function typedDataWarnings(td: ParsedTypedData, root: DecodedCall, decodeChainId: number): TxWarning[] {
  const out: TxWarning[] = [...td.notes];
  const context = `Typed data signature. Primary type ${td.primaryType}.`;

  if (td.chainId === undefined) {
    out.push({
      severity: 'warning',
      title: 'Valid on any chain',
      context: `${context} Why: the domain has no chainId.`,
      message: 'This signature names no chain, so it can be used on every chain where the verifying contract exists.',
    });
  } else if (td.chainId !== decodeChainId) {
    const name = getKnownEvmChainName(td.chainId);
    out.push({
      severity: 'warning',
      title: 'Chain not supported here',
      context: `${context} Why: domain chainId ${td.chainId}${name ? ` (${name})` : ''}.`,
      message: `Labels, token units, and links below are from ${CHAINS[decodeChainId]?.name ?? 'the selected chain'}, not the chain this signature is for.`,
    });
  }

  if (PERMIT_TYPES.has(td.primaryType)) {
    const spender = addr(param(root, 'spender')?.value);
    const spenderName = spender ? getContractName(spender, decodeChainId) : undefined;
    const amounts = findAll(root, ['value', 'amount']).map(rawBig);
    const allowed = param(root, 'allowed')?.value;
    const unlimited =
      amounts.some(a => a === MAX_UINT || a === MAX_UINT160) || (allowed?.kind === 'primitive' && allowed.raw === 'true');
    const now = BigInt(Math.floor(Date.now() / 1000));
    const deadlines = findAll(root, ['deadline', 'sigDeadline', 'expiration', 'expiry']).map(rawBig);
    const longLived = deadlines.some(d => d !== undefined && (d === 0n ? false : d > now + ONE_YEAR_S));
    const who = spender ? (spenderName ? `${spenderName} (${spender})` : spender) : 'the spender';
    out.push({
      severity: unlimited && !spenderName ? 'danger' : 'warning',
      title: unlimited ? 'Signature gives unlimited token access' : 'Signature gives token access',
      context: `${context}${spender ? ` Spender ${spender}.` : ''}`,
      message: `Signing sends no transaction, but whoever holds the signature can let ${who} move ${unlimited ? 'all of' : 'this amount of'} your tokens${longLived ? ' for more than a year' : ''}. Drainers ask for these because they cost no gas and show no balance change.${spenderName ? '' : ' The spender is not a contract this app knows.'}`,
    });
  }

  if (td.primaryType === 'OrderComponents' && td.verifyingContract) {
    const offerer = addr(param(root, 'offerer')?.value)?.toLowerCase();
    const consideration = param(root, 'consideration')?.value;
    const items = consideration?.kind === 'array' ? consideration.elements : [];
    const toOfferer = items.filter(
      i => i.kind === 'tuple' && addr(i.fields.find(f => f.name === 'recipient')?.value)?.toLowerCase() === offerer,
    );
    out.push(
      toOfferer.length === 0
        ? {
            severity: 'danger',
            title: 'Listing pays you nothing',
            context: `${context} Why: no consideration item goes to the offerer.`,
            message: 'This marketplace order gives away everything you offer and sends every payment to other addresses. It is a common drainer signature.',
          }
        : {
            severity: 'warning',
            title: 'Marketplace listing',
            context,
            message: 'Anyone can fill this order: they get every offer item and pay only the consideration listed. Check each amount and recipient.',
          },
    );
  }

  if (td.verifyingContract && !getContractName(td.verifyingContract, decodeChainId) && td.verifyingContract !== PERMIT2_ADDRESS && td.primaryType !== 'SafeTx') {
    out.push({
      severity: 'info',
      title: 'Unknown verifying contract',
      context: `${context} Why: ${td.verifyingContract} is not in this app's registry.`,
      message: 'The contract that checks this signature is not one this app recognises. That is normal for tokens and smaller apps.',
    });
  }

  return out;
}
