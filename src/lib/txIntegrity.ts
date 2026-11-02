import { Signature, Transaction, getAddress, type TransactionLike } from 'ethers';

/**
 * Integrity check for `eth_getTransactionByHash` results from public RPCs.
 *
 * Tx-hash mode exists so people can verify what a transaction does, and the fetcher takes whichever public RPC
 * answers first. A compromised or malicious endpoint could return different calldata for a real hash. A signed
 * transaction's hash commits to every field (including calldata), so rebuilding it from the response and comparing
 * against the requested hash proves the response is the real transaction; the signature also proves `from`.
 *
 * Only standard Ethereum envelopes can be rebuilt (legacy, 2930, 1559, 4844, 7702). L2 system / deposit types
 * (e.g. OP `0x7e`, Arbitrum `0x6a`+) and responses missing signature fields are reported as `unverifiable`.
 */
export type TxIntegrity = 'verified' | 'unverifiable';

export class TxIntegrityError extends Error {
  override readonly name = 'TxIntegrityError';
  constructor(message: string) {
    super(message);
  }
}

type RpcTx = Record<string, unknown>;

function hexField(raw: RpcTx, key: string): string | undefined {
  const v = raw[key];
  return typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v) ? v : undefined;
}

function bigField(raw: RpcTx, key: string): bigint | undefined {
  const v = hexField(raw, key);
  return v === undefined ? undefined : BigInt(v === '0x' ? '0x0' : v);
}

function toTransactionLike(raw: RpcTx): TransactionLike | null {
  const type = Number(bigField(raw, 'type') ?? 0n);
  if (![0, 1, 2, 3, 4].includes(type)) return null;

  const r = hexField(raw, 'r');
  const s = hexField(raw, 's');
  const yParity = bigField(raw, 'yParity');
  const v = bigField(raw, 'v');
  const nonce = bigField(raw, 'nonce');
  const gas = bigField(raw, 'gas');
  const value = bigField(raw, 'value');
  const input = hexField(raw, 'input');
  if (!r || !s || nonce === undefined || gas === undefined || value === undefined || input === undefined) return null;
  if (yParity === undefined && v === undefined) return null;

  let chainId = bigField(raw, 'chainId');
  if (chainId === undefined && type === 0 && v !== undefined && v >= 35n) {
    chainId = (v - 35n) / 2n; // EIP-155 legacy: v = chainId * 2 + 35 | 36
  }

  const sigV = type === 0 ? Number(v ?? (yParity ?? 0n) + 27n) : Number(yParity ?? (v !== undefined ? v % 2n : 0n));
  const tx: TransactionLike = {
    type,
    nonce: Number(nonce),
    gasLimit: gas,
    to: typeof raw.to === 'string' ? raw.to : null,
    value,
    data: input,
    signature: Signature.from({ r, s, v: sigV }),
  };
  if (chainId !== undefined) tx.chainId = chainId;

  if (type === 0 || type === 1) {
    tx.gasPrice = bigField(raw, 'gasPrice');
  } else {
    tx.maxFeePerGas = bigField(raw, 'maxFeePerGas');
    tx.maxPriorityFeePerGas = bigField(raw, 'maxPriorityFeePerGas');
  }
  if (type >= 1 && Array.isArray(raw.accessList)) {
    tx.accessList = raw.accessList as TransactionLike['accessList'];
  }
  if (type === 3) {
    tx.maxFeePerBlobGas = bigField(raw, 'maxFeePerBlobGas');
    tx.blobVersionedHashes = Array.isArray(raw.blobVersionedHashes) ? (raw.blobVersionedHashes as string[]) : [];
  }
  if (type === 4) {
    if (!Array.isArray(raw.authorizationList)) return null;
    tx.authorizationList = (raw.authorizationList as RpcTx[]).map(a => ({
      address: String(a.address),
      nonce: bigField(a, 'nonce') ?? 0n,
      chainId: bigField(a, 'chainId') ?? 0n,
      signature: Signature.from({
        r: String(a.r),
        s: String(a.s),
        v: Number(bigField(a, 'yParity') ?? bigField(a, 'v') ?? 0n) % 2 === 0 ? 27 : 28,
      }),
    }));
  }
  return tx;
}

/**
 * Throws {@link TxIntegrityError} when the response provably is not the requested transaction (hash or sender
 * mismatch). Returns `unverifiable` when the envelope can't be rebuilt.
 */
export function verifyRpcTransaction(raw: unknown, expectedHashLower: string): TxIntegrity {
  if (raw === null || typeof raw !== 'object') return 'unverifiable';
  let rebuilt: Transaction;
  try {
    const like = toTransactionLike(raw as RpcTx);
    if (!like) return 'unverifiable';
    rebuilt = Transaction.from(like);
  } catch {
    return 'unverifiable';
  }

  let hash: string | null;
  try {
    hash = rebuilt.hash;
  } catch {
    return 'unverifiable';
  }
  if (!hash) return 'unverifiable';

  if (hash.toLowerCase() !== expectedHashLower) {
    throw new TxIntegrityError(
      'RPC returned a transaction whose contents do not hash to the requested hash; ignoring this endpoint.',
    );
  }

  const claimedFrom = (raw as RpcTx).from;
  if (typeof claimedFrom === 'string' && rebuilt.from && getAddress(claimedFrom) !== rebuilt.from) {
    throw new TxIntegrityError('RPC returned a `from` address that does not match the transaction signature.');
  }
  return 'verified';
}
