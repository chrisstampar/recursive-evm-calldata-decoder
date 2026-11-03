/**
 * Serialized transactions (`0x02f8…` from `cast mktx`, a wallet's raw export or a hardware-wallet signing request):
 * read every field, recover the sender when it is signed, and flag what makes signing one risky (EIP-7702 account
 * delegation, no replay protection). The calldata is then decoded like any other.
 */
import { Transaction, getAddress, verifyAuthorization } from 'ethers';
import type { TxWarning } from '../types/index.ts';
import { CHAINS, getKnownEvmChainName } from './chains.ts';

/** Bytes a pasted transaction may have (a full block's worth of calldata is far below this). */
const MAX_RAW_TX_HEX_CHARS = 2 + 2 * 512 * 1024;

const TYPE_NAMES: Record<number, string> = {
  0: 'Legacy',
  1: 'EIP-2930 (access list)',
  2: 'EIP-1559',
  3: 'EIP-4844 (blob)',
  4: 'EIP-7702 (set code)',
};

export interface SignedTxAuthorization {
  /** Contract the account delegates to; the zero address clears a delegation. */
  address: string;
  /** 0 = valid on every chain. */
  chainId: string;
  nonce: string;
  /** Account that signed this authorization (the account whose code changes). */
  signer?: string;
}

export interface ParsedSignedTx {
  type: number;
  typeName: string;
  /** `null` for a legacy transaction without EIP-155 replay protection. */
  chainId: number | null;
  nonce: number;
  /** `null` for a contract deployment. */
  to: string | null;
  /** Wei, decimal string. */
  value: string;
  data: string;
  gasLimit: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  /** Recovered sender; `null` when the transaction is unsigned. */
  from: string | null;
  hash: string | null;
  authorizations: SignedTxAuthorization[];
  blobCount: number;
  accessListEntries: number;
}

/** Hex that parses as a serialized transaction, without throwing (for "this looks like…" hints). */
export function looksLikeSerializedTx(input: string): boolean {
  try {
    parseSerializedTransaction(input);
    return true;
  } catch {
    return false;
  }
}

export function parseSerializedTransaction(input: string): ParsedSignedTx {
  const hex = input.trim().replace(/\s+/g, '');
  if (!/^0x[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Expected a 0x-prefixed hex string with whole bytes.');
  }
  if (hex.length > MAX_RAW_TX_HEX_CHARS) throw new Error('Transaction is too large (over 512 KB).');

  let tx: Transaction;
  try {
    tx = Transaction.from(hex.toLowerCase());
  } catch (e) {
    throw new Error(
      `Not a serialized transaction (${e instanceof Error ? e.message.split(' (')[0] : 'unreadable'}). Paste calldata in the Calldata tab instead.`,
      { cause: e },
    );
  }

  const signed = tx.signature != null;
  const authorizations: SignedTxAuthorization[] = (tx.authorizationList ?? []).map(auth => {
    let signer: string | undefined;
    try {
      signer = verifyAuthorization({ address: auth.address, nonce: auth.nonce, chainId: auth.chainId }, auth.signature);
    } catch {
      signer = undefined;
    }
    return {
      address: getAddress(auth.address),
      chainId: auth.chainId.toString(),
      nonce: auth.nonce.toString(),
      ...(signer ? { signer } : {}),
    };
  });

  const chainId = tx.chainId === 0n && tx.type === 0 ? null : Number(tx.chainId);
  return {
    type: tx.type ?? 0,
    typeName: TYPE_NAMES[tx.type ?? 0] ?? `Type ${tx.type}`,
    chainId,
    nonce: tx.nonce,
    to: tx.to ? getAddress(tx.to) : null,
    value: tx.value.toString(),
    data: tx.data,
    gasLimit: tx.gasLimit.toString(),
    ...(tx.gasPrice != null && (tx.type === 0 || tx.type === 1) ? { gasPrice: tx.gasPrice.toString() } : {}),
    ...(tx.maxFeePerGas != null ? { maxFeePerGas: tx.maxFeePerGas.toString() } : {}),
    ...(tx.maxPriorityFeePerGas != null ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString() } : {}),
    from: signed ? tx.from : null,
    hash: signed ? tx.hash : null,
    authorizations,
    blobCount: tx.blobVersionedHashes?.length ?? 0,
    accessListEntries: tx.accessList?.length ?? 0,
  };
}

/** Chain to decode on: the transaction's own when the app knows it, else `fallback`. */
export function decodeChainFor(tx: ParsedSignedTx, fallback: number): number {
  return tx.chainId != null && CHAINS[tx.chainId] ? tx.chainId : fallback;
}

export function serializedTxWarnings(tx: ParsedSignedTx, decodeChainId: number): TxWarning[] {
  const out: TxWarning[] = [];
  const context = `Transaction field. Type ${tx.type} (${tx.typeName}).`;

  for (const auth of tx.authorizations) {
    const who = auth.signer ?? 'the signing account';
    const anyChain = auth.chainId === '0';
    if (/^0x0{40}$/i.test(auth.address)) {
      out.push({
        severity: 'info',
        title: 'Removes an account delegation',
        context,
        message: `This clears any EIP-7702 delegation on ${who}, so it becomes a plain account again${anyChain ? ' on every chain' : ''}.`,
      });
      continue;
    }
    out.push({
      severity: 'danger',
      title: 'Hands control of an account to a contract',
      context: `${context} Why: EIP-7702 authorization to ${auth.address}${anyChain ? ' with chain id 0' : ''}.`,
      message: `${who} would run the code at ${auth.address} from now on. That code can move every token and NFT in the account, so sign only if you know this contract and meant to upgrade your account.${anyChain ? ' Chain id 0 makes the authorization valid on every chain.' : ''}`,
    });
  }

  if (tx.chainId == null) {
    out.push({
      severity: 'warning',
      title: 'No replay protection',
      context: `${context} Why: legacy transaction without an EIP-155 chain id.`,
      message: 'Anyone can submit this signed transaction on any EVM chain where the sender has the same nonce.',
    });
  } else if (tx.chainId !== decodeChainId) {
    const name = getKnownEvmChainName(tx.chainId);
    out.push({
      severity: 'warning',
      title: 'Chain not supported here',
      context: `${context} Why: chain id ${tx.chainId}${name ? ` (${name})` : ''}.`,
      message: `Labels, token units, and links below are from ${CHAINS[decodeChainId]?.name ?? 'the selected chain'}, not the chain this transaction is for.`,
    });
  }

  if (tx.from == null) {
    out.push({
      severity: 'info',
      title: 'Unsigned transaction',
      context,
      message: 'There is no signature, so the sender is unknown. Whoever signs it becomes the sender.',
    });
  }

  if (tx.to == null) {
    out.push({
      severity: 'warning',
      title: 'Contract deployment',
      context: `${context} Why: no recipient.`,
      message: 'This deploys a new contract. Its data is the contract code, not a function call, so it is not decoded.',
    });
  }

  return out;
}
