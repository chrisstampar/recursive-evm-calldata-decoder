import type { SafeTxHashes } from './safeHash.ts';
import type { TypedDataHashes } from './typedData.ts';

/** What is being signed, for the hashes card shown above a typed-data or Safe decode. */
export type SigningContext =
  | {
      kind: 'typed-data';
      primaryType: string;
      /** Only the domain fields that are signed. */
      domain: Record<string, unknown>;
      hashes: TypedDataHashes;
      /** Set for a `SafeTx`, whose digest is its safeTxHash. */
      safeNonce?: string;
    }
  | {
      kind: 'safe';
      safeAddress: string;
      chainId: number;
      versionLabel: string;
      nonce: string;
      hashes: SafeTxHashes;
    };

export interface HashRow {
  label: string;
  value: string;
  hint: string;
}

export function signingHashRows(ctx: SigningContext): HashRow[] {
  const isSafe = ctx.kind === 'safe' || ctx.safeNonce !== undefined;
  const domain = ctx.kind === 'safe' ? ctx.hashes.domainHash : ctx.hashes.domainSeparator;
  const message = ctx.hashes.messageHash;
  const digest = ctx.kind === 'safe' ? ctx.hashes.safeTxHash : ctx.hashes.digest;
  return [
    { label: 'Domain hash', value: domain, hint: 'Hardware wallets show this when signing typed data.' },
    { label: 'Message hash', value: message, hint: 'Shown next to the domain hash on a hardware wallet.' },
    isSafe
      ? { label: 'safeTxHash', value: digest, hint: 'The Safe app and Safe API list the transaction under this hash.' }
      : { label: 'Signed hash', value: digest, hint: 'The value the signature is over: keccak256(0x1901 ‖ domain hash ‖ message hash).' },
  ];
}

/** Lower-case `0x` + 64 hex from what people paste (spaces, missing 0x, upper case), or null. */
export function normalizeHash(input: string): string | null {
  const t = input.replace(/\s+/g, '').toLowerCase();
  const hex = t.startsWith('0x') ? t.slice(2) : t;
  return /^[0-9a-f]{64}$/.test(hex) ? `0x${hex}` : null;
}
