import { beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  MAX_FIXED_ARRAY_SIZE,
  MAX_SIGNATURE_PARAMETERS_PER_LEVEL,
  MAX_TEXT_SIGNATURE_LENGTH,
  SIGNATURE_FUNCTION_NAME_REGEX,
  SIGNATURE_IDENTIFIER_REGEX,
  canonicalizeTextSignature,
  clearSignatureValidatorCaches,
  formatValidationError,
  formatValidationErrors,
  normalizeSignatureParamType,
  normalizeSignatureWhitespace,
  parseTextSignature,
  splitTextSignatureParts,
  stripTrailingSolidityParameterName,
  validateTextSignature,
  validateTextSignatureCollectErrors,
} from './signatureValidator.ts';

describe('signatureValidator', () => {
  beforeEach(() => {
    clearSignatureValidatorCaches();
  });
  it('accepts Solidity type aliases uint, int, byte', () => {
    expect(validateTextSignature('foo(uint)').valid).toBe(true);
    expect(validateTextSignature('foo(int)').valid).toBe(true);
    expect(validateTextSignature('foo(byte)').valid).toBe(true);
  });

  it('accepts aliases inside arrays and tuples', () => {
    expect(validateTextSignature('bar(uint[],(int,byte))').valid).toBe(true);
    expect(validateTextSignature('baz(uint[2])').valid).toBe(true);
  });

  it('accepts multi-dimensional fixed arrays (e.g. uint256[5][5])', () => {
    expect(validateTextSignature(`x(uint256[5][5])`).valid).toBe(true);
    expect(validateTextSignature(`y(uint[2][3])`).valid).toBe(true);
  });

  it('rejects fixed array size 0 and oversized dimensions', () => {
    const zero = validateTextSignature('f(uint256[0])');
    expect(zero.valid).toBe(false);
    if (!zero.valid) {
      expect(zero.error.type).toBe('invalid_array_size');
      if (zero.error.type === 'invalid_array_size') expect(zero.error.size).toBe(0);
    }

    const huge = validateTextSignature(`g(uint256[${MAX_FIXED_ARRAY_SIZE + 1}])`);
    expect(huge.valid).toBe(false);
    if (!huge.valid) expect(huge.error.type).toBe('invalid_array_size');

    const okMax = validateTextSignature(`h(uint256[${MAX_FIXED_ARRAY_SIZE}])`);
    expect(okMax.valid).toBe(true);
  });

  it('returns unknown_type with top-level parameter index', () => {
    const r = validateTextSignature('transfer(address,uint257)');
    expect(r.valid).toBe(false);
    if (!r.valid && r.error.type === 'unknown_type') {
      expect(r.error.typeName).toBe('uint257');
      expect(r.error.position).toBe(1);
      expect(formatValidationError(r.error)).toContain('uint257');
      expect(formatValidationError(r.error)).toContain('1');
    }
  });

  it('accepts user-defined type identifiers as parameters', () => {
    expect(validateTextSignature('deposit(address,MyStruct)').valid).toBe(true);
    expect(parseTextSignature('mint( uint256 , MyType )')).toEqual({
      name: 'mint',
      paramTypes: ['uint256', 'MyType'],
    });
  });

  it('accepts Unicode user-defined type identifiers (aligned with function names)', () => {
    expect(SIGNATURE_IDENTIFIER_REGEX.test('Δ')).toBe(true);
    expect(validateTextSignature('f(Δ)').valid).toBe(true);
    expect(parseTextSignature('f(Δ)')).toEqual({ name: 'f', paramTypes: ['Δ'] });
  });

  it('accepts named tuple components and top-level param names; canonical form drops names', () => {
    const sig = 'transfer((uint256 amount,address to))';
    expect(validateTextSignature(sig).valid).toBe(true);
    expect(parseTextSignature(sig)).toEqual({
      name: 'transfer',
      paramTypes: ['(uint256,address)'],
    });
    expect(canonicalizeTextSignature(sig)).toBe('transfer((uint256,address))');
    expect(stripTrailingSolidityParameterName('uint256[] balances')).toBe('uint256[]');
  });

  it('validateTextSignatureCollectErrors accumulates multiple issues', () => {
    const errs = validateTextSignatureCollectErrors('x(uint257,uint258)');
    expect(errs.length).toBe(2);
    expect(errs.every(e => e.type === 'unknown_type')).toBe(true);
    expect(formatValidationErrors(errs).split('\n').length).toBe(2);
  });

  it('normalizes whitespace around delimiters and before (', () => {
    expect(normalizeSignatureWhitespace('transfer ( address , uint256 )')).toBe('transfer(address,uint256)');
    expect(validateTextSignature('transfer ( address , uint256 )').valid).toBe(true);
  });

  it('accepts fixedMxN and ufixedMxN', () => {
    expect(validateTextSignature('f(ufixed128x18,fixed64x32)').valid).toBe(true);
    expect(validateTextSignature('g(fixed256x0)').valid).toBe(true);
    expect(validateTextSignature('h(fixed128x129)').valid).toBe(false);
    expect(validateTextSignature('i(fixed7x1)').valid).toBe(false);
  });

  it('accepts external function pointer types', () => {
    expect(validateTextSignature('exec(function(uint256,address)external)').valid).toBe(true);
    expect(validateTextSignature('run(function() internal)').valid).toBe(true);
    expect(normalizeSignatureParamType('function( uint , bool ) external')).toBe(
      'function(uint256,bool) external',
    );
  });

  it('memoizes parseTextSignature for the same normalized input', () => {
    const a = parseTextSignature('x(uint256)');
    const b = parseTextSignature('x( uint256 )');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('reports excessive tuple depth', () => {
    const deep = `a(${`(`.repeat(6)}uint256${`)`.repeat(6)})`;
    const r = validateTextSignature(deep);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error.type).toBe('excessive_tuple_depth');
  });

  it('normalizes aliases in parseTextSignature', () => {
    expect(parseTextSignature('x(uint,int,byte)')).toEqual({
      name: 'x',
      paramTypes: ['uint256', 'int256', 'bytes1'],
    });
    expect(parseTextSignature('y(uint[])')).toEqual({
      name: 'y',
      paramTypes: ['uint256[]'],
    });
    expect(parseTextSignature('z((uint,byte))')).toEqual({
      name: 'z',
      paramTypes: ['(uint256,bytes1)'],
    });
  });

  it('canonicalizeTextSignature matches uint256 selector for uint alias', () => {
    const withAlias = canonicalizeTextSignature('m(uint)');
    expect(withAlias).toBe('m(uint256)');
    const h1 = keccak256(toUtf8Bytes(withAlias!)).slice(0, 10);
    const h2 = keccak256(toUtf8Bytes('m(uint256)')).slice(0, 10);
    expect(h1).toBe(h2);
  });

  it('normalizeSignatureParamType handles fixed and dynamic arrays', () => {
    expect(normalizeSignatureParamType('uint[2][3]')).toBe('uint256[2][3]');
    expect(normalizeSignatureParamType('byte[][1]')).toBe('bytes1[][1]');
  });

  it('rejects signatures longer than MAX_TEXT_SIGNATURE_LENGTH before regex', () => {
    const long = 'x'.repeat(MAX_TEXT_SIGNATURE_LENGTH + 1);
    expect(long.length).toBeGreaterThan(MAX_TEXT_SIGNATURE_LENGTH);
    const r = validateTextSignature(long);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error.type).toBe('invalid_syntax');
      expect(formatValidationError(r.error)).toContain(String(MAX_TEXT_SIGNATURE_LENGTH));
    }
    expect(parseTextSignature(long)).toBeNull();
    expect(canonicalizeTextSignature(long)).toBeNull();
  });

  it('rejects more than MAX_SIGNATURE_PARAMETERS_PER_LEVEL params at one level', () => {
    const n = MAX_SIGNATURE_PARAMETERS_PER_LEVEL + 1;
    const sig = `many(${Array.from({ length: n }, () => 'uint256').join(',')})`;
    const r = validateTextSignature(sig);
    expect(r.valid).toBe(false);
    if (!r.valid && r.error.type === 'too_many_parameters') {
      expect(r.error.count).toBe(n);
      expect(r.error.max).toBe(MAX_SIGNATURE_PARAMETERS_PER_LEVEL);
    }
    expect(parseTextSignature(sig)).toBeNull();
  });

  it('rejects tuples with too many fields at one level', () => {
    const inner = Array.from({ length: MAX_SIGNATURE_PARAMETERS_PER_LEVEL + 1 }, () => 'uint256').join(',');
    const r = validateTextSignature(`t((${inner}))`);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error.type).toBe('too_many_parameters');
  });

  describe('review edge cases', () => {
    it('accepts func(uint): uint alias is valid, not rejected', () => {
      expect(validateTextSignature('func(uint)').valid).toBe(true);
      expect(canonicalizeTextSignature('func(uint)')).toBe('func(uint256)');
    });

    it('rejects func(uint256[0]): zero-length fixed array', () => {
      const r = validateTextSignature('func(uint256[0])');
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.error.type).toBe('invalid_array_size');
    });

    it('accepts nested tuples func((uint256,(address,bytes32)))', () => {
      const sig = 'func((uint256,(address,bytes32)))';
      expect(validateTextSignature(sig).valid).toBe(true);
      expect(parseTextSignature(sig)).toEqual({
        name: 'func',
        paramTypes: ['(uint256,(address,bytes32))'],
      });
    });

    it('accepts func() empty parameter list', () => {
      expect(validateTextSignature('func()').valid).toBe(true);
      expect(parseTextSignature('func()')).toEqual({ name: 'func', paramTypes: [] });
      expect(splitTextSignatureParts('func()')).toEqual({ name: 'func', paramsStr: '' });
    });

    it('rejects very long input (over 10KiB and over MAX_TEXT_SIGNATURE_LENGTH)', () => {
      const long = 'x'.repeat(10 * 1024 + 1);
      expect(long.length).toBeGreaterThan(10 * 1024);
      expect(long.length).toBeGreaterThan(MAX_TEXT_SIGNATURE_LENGTH);
      expect(validateTextSignature(long).valid).toBe(false);
    });
  });

  it('allows Unicode function names (Solidity 0.8+) and normalizes space before (', () => {
    expect(SIGNATURE_FUNCTION_NAME_REGEX.test('Перевод')).toBe(true);
    const spaced = 'Перевод (uint256)';
    expect(normalizeSignatureWhitespace(spaced)).toBe('Перевод(uint256)');
    expect(validateTextSignature('Перевод(uint256)').valid).toBe(true);
  });
});
