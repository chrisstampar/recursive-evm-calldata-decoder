import type { TxWarning } from '../types/index.ts';
import type { TxFetchContext } from './txFetcher.ts';
import type { ParsedTypedData } from './typedData.ts';
import type { SigningContext } from './signing.ts';

/** Everything the input hands the app to decode, whichever tab it came from. */
export interface DecodeRequest {
  calldata: string;
  abi?: string;
  msgValueWei?: string;
  /** Contract the calldata is sent to (transaction `to`, a Safe, a typed-data verifying contract). */
  txTo?: string | null;
  /** Set when calldata came from a transaction (fetched or pasted): enables the native-transfer summary. */
  txFetchContext?: TxFetchContext | null;
  /**
   * Chain the input names (a signed transaction's chain id, a typed-data domain). The app switches to it before
   * decoding, and a later chain switch clears the result rather than decoding it against another chain.
   */
  chainId?: number;
  /** Warnings from reading the input itself (EIP-7702 authorizations, typed-data domain). */
  extraWarnings?: TxWarning[];
  /** Typed data being signed: its call gets token units from the domain and signature-specific warnings. */
  typedData?: ParsedTypedData;
  /** Hashes card shown above the summary. */
  signing?: SigningContext;
  /** Transaction sender, for look-alike checks. */
  from?: string | null;
  /** "transaction" (default) or "signature": changes the summary heading. */
  kind?: 'transaction' | 'signature';
}
