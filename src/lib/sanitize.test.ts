import { describe, expect, it } from 'vitest';
import {
  extractSelector,
  isValidAbiJson,
  isValidFunctionSelector,
  MAX_INPUT_BYTES,
  sanitizeTrustedUiLabel,
  validateHexInput,
} from './sanitize.ts';

describe('validateHexInput', () => {
  it('rejects odd-length hex (0x123)', () => {
    const r = validateHexInput('0x123');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/odd/i);
  });

  it('rejects non-hex characters (0xGGGG…)', () => {
    const r = validateHexInput('0xGGGGGGGG00000000');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/non-hexadecimal/i);
  });

  it('accepts exactly selector-sized calldata (4 bytes: 0xa9059cbb)', () => {
    const r = validateHexInput('0xa9059cbb');
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.normalized).toBe('0xa9059cbb');
  });

  it('rejects truncated calldata (only 2 bytes: 0xa905)', () => {
    const r = validateHexInput('0xa905');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/at least 4 bytes/i);
  });

  it(`accepts input at exactly ${MAX_INPUT_BYTES} bytes`, () => {
    const hexBody = 'aa'.repeat(MAX_INPUT_BYTES);
    const r = validateHexInput(`0x${hexBody}`);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.normalized.length).toBe(2 + MAX_INPUT_BYTES * 2);
    }
  });

  it(`rejects input at ${MAX_INPUT_BYTES + 1} bytes`, () => {
    const hexBody = 'aa'.repeat(MAX_INPUT_BYTES + 1);
    const r = validateHexInput(`0x${hexBody}`);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/exceeds maximum size/i);
  });
});

describe('extractSelector', () => {
  it('returns null for calldata shorter than selector (0xa905)', () => {
    expect(extractSelector('0xa905')).toBeNull();
  });

  it('returns null for invalid hex in selector slice', () => {
    expect(extractSelector('0xGGGGGGGG00000000')).toBeNull();
  });

  it('returns normalized selector for valid prefix', () => {
    expect(extractSelector('0xA9059CBB00000000')).toBe('0xa9059cbb');
  });
});

describe('isValidFunctionSelector', () => {
  it('accepts 0x + 8 hex digits (any case)', () => {
    expect(isValidFunctionSelector('0xa9059cbb')).toBe(true);
    expect(isValidFunctionSelector(' 0xA9059CBB ')).toBe(true);
  });

  it('rejects wrong length, missing 0x, and non-hex', () => {
    expect(isValidFunctionSelector('0xa9059cb')).toBe(false);
    expect(isValidFunctionSelector('a9059cbb')).toBe(false);
    expect(isValidFunctionSelector('0xGGGGGGGG')).toBe(false);
  });
});

describe('isValidAbiJson', () => {
  it('rejects empty array', () => {
    expect(isValidAbiJson('[]')).toBe(false);
  });

  it('rejects non-object array entries', () => {
    expect(isValidAbiJson('[1,2,3]')).toBe(false);
  });

  it('rejects object without ABI type', () => {
    expect(isValidAbiJson('[{"name":"foo"}]')).toBe(false);
  });

  it('rejects function with non-array inputs', () => {
    expect(isValidAbiJson('[{"type":"function","name":"f","inputs":{}}]')).toBe(false);
  });

  it('accepts minimal valid function ABI', () => {
    const abi = JSON.stringify([
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ]);
    expect(isValidAbiJson(abi)).toBe(true);
  });
});

describe('sanitizeTrustedUiLabel', () => {
  it('strips C0 controls and Unicode direction overrides', () => {
    const bidi = 'A\u202EBTesla';
    expect(sanitizeTrustedUiLabel(bidi)).toBe('ABTesla');
    expect(sanitizeTrustedUiLabel('x\x00y')).toBe('xy');
  });

  it('collapses whitespace and caps length', () => {
    expect(sanitizeTrustedUiLabel('  a   b  ', 10)).toBe('a b');
    expect(sanitizeTrustedUiLabel('0123456789ab', 10)).toBe('0123456789...');
  });
});
