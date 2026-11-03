/**
 * Your own addresses, saved in this browser only. Decoded addresses that start and end like a saved one but are not
 * it get a warning: address poisoning sends dust from a look-alike so you copy it from your history next time.
 */
import { getAddress } from 'ethers';
import type { DecodedCall, DecodedValue, TxWarning } from '../types/index.ts';
import { listDecodedCalls } from './callTree.ts';

export interface AddressBookEntry {
  address: string;
  label: string;
}

const STORAGE_KEY = 'rec_dec.addressBook';
const MAX_ENTRIES = 200;
const MAX_LABEL_CHARS = 60;
/** Hex characters that must match at each end. Wallets show 4–6; vanity look-alikes match about that many. */
const LOOKALIKE_PREFIX = 3;
const LOOKALIKE_SUFFIX = 3;

export function readAddressBook(): AddressBookEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const out: AddressBookEntry[] = [];
    for (const row of parsed) {
      if (typeof row?.address !== 'string' || typeof row?.label !== 'string') continue;
      try {
        out.push({ address: getAddress(row.address), label: row.label.slice(0, MAX_LABEL_CHARS) });
      } catch {
        /* skip a bad row */
      }
    }
    return out.slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveAddressBook(entries: AddressBookEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage unavailable: the book lasts for this page only */
  }
}

/** New entry checked and normalised; throws a readable error. Re-adding an address renames it. */
export function upsertEntry(entries: AddressBookEntry[], address: string, label: string): AddressBookEntry[] {
  let checksummed: string;
  try {
    checksummed = getAddress(address.trim());
  } catch {
    throw new Error('Not a valid address. Use 0x followed by 40 hex characters.');
  }
  const name = label.trim().slice(0, MAX_LABEL_CHARS);
  if (!name) throw new Error('Give the address a name.');
  const rest = entries.filter(e => e.address !== checksummed);
  if (rest.length >= MAX_ENTRIES) throw new Error(`The address book holds up to ${MAX_ENTRIES} addresses.`);
  return [...rest, { address: checksummed, label: name }];
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** The saved entry `address` imitates, if any (same first and last hex characters, different address). */
export function lookalikeOf(address: string, book: AddressBookEntry[]): AddressBookEntry | undefined {
  const a = address.toLowerCase().slice(2);
  return book.find(e => {
    const b = e.address.toLowerCase().slice(2);
    return a !== b && commonPrefix(a, b) >= LOOKALIKE_PREFIX && commonSuffix(a, b) >= LOOKALIKE_SUFFIX;
  });
}

export function savedEntry(address: string, book: AddressBookEntry[]): AddressBookEntry | undefined {
  const lower = address.toLowerCase();
  return book.find(e => e.address.toLowerCase() === lower);
}

/** Addresses a call shows directly (arguments, struct fields, list items, path tokens), not those of nested calls. */
function addressesIn(v: DecodedValue, out: string[]): void {
  switch (v.kind) {
    case 'address':
      out.push(v.checksummed);
      break;
    case 'primitive':
      if (v.embeddedEvmAddress) out.push(v.embeddedEvmAddress.checksummed);
      break;
    case 'bytes':
      v.v3Path?.tokens.forEach(t => out.push(t.address));
      v.wordAlignedAddresses?.forEach(h => out.push(h.checksummed));
      break;
    case 'array':
      v.elements.forEach(e => addressesIn(e, out));
      break;
    case 'tuple':
      v.fields.forEach(f => addressesIn(f.value, out));
      break;
  }
}

function short(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/**
 * One warning per look-alike address in the decoded call tree (and the transaction's own `to` / `from`), pointing at
 * the first call that shows it.
 */
export function lookalikeWarnings(
  root: DecodedCall | null,
  book: AddressBookEntry[],
  extra: { address: string | null | undefined; role: string }[] = [],
): TxWarning[] {
  if (book.length === 0) return [];
  const seen = new Set<string>();
  const out: TxWarning[] = [];
  const check = (address: string, context: string, callIndex?: number) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const target = lookalikeOf(address, book);
    if (!target) return;
    out.push({
      severity: 'danger',
      title: `Look-alike of your address "${target.label}"`,
      context: `${context} Why: ${short(address)} starts and ends like your saved ${short(target.address)}.`,
      message: `${address} is not ${target.address}. Scammers make addresses that look like yours so you copy the wrong one from your history. Check every character.`,
      ...(callIndex !== undefined ? { callIndex } : {}),
    });
  };

  for (const { address, role } of extra) if (address) check(address, `Transaction ${role}.`);
  if (root) {
    listDecodedCalls(root).forEach((call, i) => {
      const found: string[] = [];
      call.params.forEach(p => addressesIn(p.value, found));
      found.forEach(a => check(a, `Call ${call.signature.name}.`, i));
    });
  }
  return out;
}
