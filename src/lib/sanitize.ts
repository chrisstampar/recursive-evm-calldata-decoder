const HEX_REGEX = /^(0x)?[0-9a-fA-F]*$/;

/** Maximum calldata size accepted by `validateHexInput` (bytes, excluding `0x`). */
export const MAX_INPUT_BYTES = 1_048_576; // 1 MB

export function validateHexInput(input: string): { valid: true; normalized: string } | { valid: false; error: string } {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Input is empty' };
  }

  if (!HEX_REGEX.test(trimmed)) {
    return { valid: false, error: 'Input contains non-hexadecimal characters' };
  }

  const normalized = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  const byteLength = (normalized.length - 2) / 2;

  if (normalized.length % 2 !== 0) {
    return { valid: false, error: 'Hex string has an odd number of characters' };
  }

  if (byteLength > MAX_INPUT_BYTES) {
    return { valid: false, error: `Input exceeds maximum size of ${MAX_INPUT_BYTES} bytes` };
  }

  if (byteLength < 4) {
    return { valid: false, error: 'Calldata must be at least 4 bytes (function selector)' };
  }

  return { valid: true, normalized: normalized.toLowerCase() };
}

const SELECTOR_REGEX = /^0x[0-9a-f]{8}$/;

/** `0x` plus exactly four bytes of hex (function selector). Whitespace trimmed; hex is case-insensitive. */
export function isValidFunctionSelector(selector: string): boolean {
  return SELECTOR_REGEX.test(selector.trim().toLowerCase());
}

/** First 4 bytes of calldata as `0x` + 8 hex digits, or null if missing/invalid. */
export function extractSelector(calldata: string): string | null {
  if (calldata.length < 10) return null;
  const selector = calldata.slice(0, 10).toLowerCase();
  if (!SELECTOR_REGEX.test(selector)) return null;
  return selector;
}

export function sanitizeDecodedString(value: string, maxLength = 1000): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + '...' : cleaned;
}

/** BiDi / direction overrides sometimes used to spoof UI when concatenated with trusted text. */
const UI_LABEL_BIDI_REGEX = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Sanitize static registry strings (e.g. chain names) before UI or warning text.
 * Strips C0 controls, Unicode direction overrides, collapses whitespace, caps length.
 */
export function sanitizeTrustedUiLabel(value: string, maxLength = 96): string {
  // eslint-disable-next-line no-control-regex
  let s = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  s = s.replace(UI_LABEL_BIDI_REGEX, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > maxLength ? `${s.slice(0, maxLength)}...` : s;
}

/** Top-level Solidity / ethers JSON ABI fragment kinds we accept in user paste. */
const ABI_ITEM_TYPES = new Set([
  'function',
  'event',
  'constructor',
  'error',
  'fallback',
  'receive',
]);

const MAX_ABI_TUPLE_DEPTH = 24;

function isAbiParameter(value: unknown, depth: number): boolean {
  if (depth > MAX_ABI_TUPLE_DEPTH) return false;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (typeof p.type !== 'string' || p.type.trim() === '') return false;
  if (p.components !== undefined) {
    if (!Array.isArray(p.components)) return false;
    if (!p.components.every(c => isAbiParameter(c, depth + 1))) return false;
  }
  return true;
}

function isAbiParameterList(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every(p => isAbiParameter(p, 0));
}

function isAbiTopLevelItem(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.type !== 'string' || !ABI_ITEM_TYPES.has(item.type)) return false;
  if (item.inputs !== undefined && !isAbiParameterList(item.inputs)) return false;
  if (item.outputs !== undefined && !isAbiParameterList(item.outputs)) return false;
  return true;
}

export function isValidAbiJson(input: string): boolean {
  try {
    const parsed: unknown = JSON.parse(input);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;
    return parsed.every(isAbiTopLevelItem);
  } catch {
    return false;
  }
}
