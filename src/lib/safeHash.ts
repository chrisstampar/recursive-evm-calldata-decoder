/**
 * Safe (Gnosis Safe) transaction hashes, worked out locally so signers can check them against what their wallet or
 * hardware device shows. A hardware wallet signing a Safe transaction shows the EIP-712 domain hash and message hash;
 * the Safe app shows the safeTxHash. If any of them differ, the transaction being signed is not the one shown.
 */
import { AbiCoder, TypedDataEncoder, getAddress, id } from 'ethers';
import { CHAINS } from './chains.ts';

/** Safe versions differ in the domain (chain id from 1.3.0) and in one SafeTx field name (`dataGas` before 1.0.0). */
export type SafeVersionRange = '1.3+' | '1.0-1.2' | '0.x';

export const SAFE_VERSION_RANGES: { id: SafeVersionRange; label: string }[] = [
  { id: '1.3+', label: '1.3.0 or later' },
  { id: '1.0-1.2', label: '1.0.0 to 1.2.0' },
  { id: '0.x', label: 'Before 1.0.0' },
];

export interface SafeTxFields {
  to: string;
  /** Wei, as a decimal or 0x hex string. */
  value: string;
  data: string;
  /** 0 = CALL, 1 = DELEGATECALL. */
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: string;
}

export interface SafeTxHashes {
  domainHash: string;
  messageHash: string;
  safeTxHash: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const EMPTY_SAFE_TX: SafeTxFields = {
  to: '',
  value: '0',
  data: '0x',
  operation: 0,
  safeTxGas: '0',
  baseGas: '0',
  gasPrice: '0',
  gasToken: ZERO_ADDRESS,
  refundReceiver: ZERO_ADDRESS,
  nonce: '',
};

/** `VERSION()` string from a Safe ("1.4.1") → its hashing scheme; unknown strings get the current scheme. */
export function safeVersionRange(version: string): SafeVersionRange {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return '1.3+';
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major === 0) return '0.x';
  if (major === 1 && minor < 3) return '1.0-1.2';
  return '1.3+';
}

function safeTxTypes(range: SafeVersionRange) {
  const gasField = range === '0.x' ? 'dataGas' : 'baseGas';
  return {
    SafeTx: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: gasField, type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
  };
}

/** Field values checked and normalised, or a readable error naming the field. */
export function normalizeSafeTx(tx: SafeTxFields): SafeTxFields {
  const addr = (name: string, v: string) => {
    try {
      return getAddress(v.trim());
    } catch {
      throw new Error(`${name} is not a valid address.`);
    }
  };
  const uint = (name: string, v: string) => {
    const t = v.trim();
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) throw new Error(`${name} must be a whole number.`);
    return BigInt(t).toString();
  };
  const data = tx.data.trim() === '' ? '0x' : tx.data.trim().toLowerCase();
  if (!/^0x([0-9a-f]{2})*$/.test(data)) throw new Error('Data must be 0x-prefixed hex with whole bytes.');
  if (tx.operation !== 0 && tx.operation !== 1) throw new Error('Operation must be 0 (call) or 1 (delegatecall).');
  return {
    to: addr('To', tx.to),
    value: uint('Value', tx.value),
    data,
    operation: tx.operation,
    safeTxGas: uint('safeTxGas', tx.safeTxGas),
    baseGas: uint('baseGas', tx.baseGas),
    gasPrice: uint('gasPrice', tx.gasPrice),
    gasToken: addr('Gas token', tx.gasToken),
    refundReceiver: addr('Refund receiver', tx.refundReceiver),
    nonce: uint('Nonce', tx.nonce),
  };
}

export function computeSafeTxHashes(
  chainId: number,
  safeAddress: string,
  range: SafeVersionRange,
  fields: SafeTxFields,
): SafeTxHashes {
  const tx = normalizeSafeTx(fields);
  const verifyingContract = getAddress(safeAddress);
  const domain = range === '1.3+' ? { chainId, verifyingContract } : { verifyingContract };
  const types = safeTxTypes(range);
  const message: Record<string, unknown> = { ...tx };
  if (range === '0.x') {
    message.dataGas = tx.baseGas;
    delete message.baseGas;
  }
  return {
    domainHash: TypedDataEncoder.hashDomain(domain),
    messageHash: TypedDataEncoder.hashStruct('SafeTx', types, message),
    safeTxHash: TypedDataEncoder.hash(domain, types, message),
  };
}

const EXEC_TRANSACTION_SELECTOR = id(
  'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
).slice(0, 10);

/**
 * The Safe transaction as `execTransaction` calldata with no signatures, so the decoder shows it the way it shows an
 * executed one (nested call decoded, DELEGATECALL warnings).
 */
export function safeTxAsExecCalldata(fields: SafeTxFields): string {
  const tx = normalizeSafeTx(fields);
  const args = AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'bytes', 'uint8', 'uint256', 'uint256', 'uint256', 'address', 'address', 'bytes'],
    [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, '0x'],
  );
  return `${EXEC_TRANSACTION_SELECTOR}${args.slice(2)}`;
}

const SAFE_RPC_TIMEOUT_MS = 6000;

async function ethCall(chainId: number, to: string, data: string, signal?: AbortSignal): Promise<string> {
  const rpcs = CHAINS[chainId]?.rpcs ?? [];
  let lastError: unknown = new Error('No RPC for this chain.');
  for (const url of rpcs) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), SAFE_RPC_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: ac.signal,
      });
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (typeof body.result === 'string') return body.result;
      lastError = new Error(body.error?.message ?? 'Empty RPC response');
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError;
}

/** Current `nonce()` and `VERSION()` of a Safe, read from a public RPC. */
export async function fetchSafeState(
  chainId: number,
  safeAddress: string,
  signal?: AbortSignal,
): Promise<{ nonce: string; version: string }> {
  const safe = getAddress(safeAddress);
  const coder = AbiCoder.defaultAbiCoder();
  const [nonceHex, versionHex] = await Promise.all([
    ethCall(chainId, safe, id('nonce()').slice(0, 10), signal),
    ethCall(chainId, safe, id('VERSION()').slice(0, 10), signal),
  ]);
  if (nonceHex === '0x' || versionHex === '0x') throw new Error('This address does not answer like a Safe on this chain.');
  return {
    nonce: (coder.decode(['uint256'], nonceHex)[0] as bigint).toString(),
    version: coder.decode(['string'], versionHex)[0] as string,
  };
}
