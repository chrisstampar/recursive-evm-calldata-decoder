/**
 * Classify bytes appended after a call's ABI arguments.
 *
 * Contracts ignore them, but frontends and aggregators routinely append attribution tags there. A real-transaction
 * run (Nov 2026, ~570 distinct selectors on mainnet + Base) found tails on ~1 in 4 decoded calls, almost all of them
 * tags: ERC-8021 builder codes, Across integrator IDs, 4-byte Seaport / 1inch / Uniswap markers, 32-byte request IDs.
 * Naming those keeps the warning for what matters: long, unexplained tails that the contract may actually read.
 */
export type TrailingDataKind = 'erc8021' | 'across-integrator' | 'erc2771-sender' | 'short-tag' | 'unknown';

export interface TrailingDataInfo {
  kind: TrailingDataKind;
  byteLength: number;
  /** One-line description for the tree and the warning. */
  label: string;
}

/** ERC-8021 transaction attribution: 16-byte marker that ends the suffix. */
const ERC8021_MARKER = '80218021802180218021802180218021';
/** Across V3 integrator tag prefix (`0x1dc0de` + integrator id). */
const ACROSS_TAG_PREFIX = '1dc0de';
/** Tails up to one ABI word are, in practice, IDs and tags rather than hidden instructions. */
const SHORT_TAG_MAX_BYTES = 32;

function hexBody(hex: string): string {
  return (hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex).toLowerCase();
}

/** ERC-8021 schema 0: `codes (ASCII, comma-separated) ‖ codesLength (1 byte) ‖ schemaId (1 byte) ‖ marker`. */
function parseErc8021Codes(body: string): string | undefined {
  const head = body.slice(0, -ERC8021_MARKER.length);
  if (head.length < 4) return undefined;
  const schemaId = parseInt(head.slice(-2), 16);
  const codesLen = parseInt(head.slice(-4, -2), 16);
  if (schemaId !== 0 || codesLen === 0 || head.length < 4 + codesLen * 2) return undefined;
  const codesHex = head.slice(-4 - codesLen * 2, -4);
  let out = '';
  for (let i = 0; i < codesHex.length; i += 2) {
    const c = parseInt(codesHex.slice(i, i + 2), 16);
    if (c < 0x20 || c > 0x7e) return undefined;
    out += String.fromCharCode(c);
  }
  return out;
}

export function classifyTrailingData(hex: string): TrailingDataInfo {
  const body = hexBody(hex);
  const byteLength = Math.floor(body.length / 2);

  if (body.endsWith(ERC8021_MARKER)) {
    const codes = parseErc8021Codes(body);
    return {
      kind: 'erc8021',
      byteLength,
      label: codes ? `ERC-8021 builder attribution (code: ${codes})` : 'ERC-8021 builder attribution',
    };
  }
  if (body.startsWith(ACROSS_TAG_PREFIX) && byteLength <= 16) {
    return { kind: 'across-integrator', byteLength, label: 'Across integrator ID tag' };
  }
  if (byteLength === 20) {
    return {
      kind: 'erc2771-sender',
      byteLength,
      label: '20 bytes: the ERC-2771 pattern (a trusted forwarder appending the original sender)',
    };
  }
  if (byteLength <= SHORT_TAG_MAX_BYTES) {
    return {
      kind: 'short-tag',
      byteLength,
      label: `Short tag (${byteLength} bytes): typically an app, referral or request ID appended by a frontend or aggregator`,
    };
  }
  return { kind: 'unknown', byteLength, label: `${byteLength} unexplained bytes` };
}
