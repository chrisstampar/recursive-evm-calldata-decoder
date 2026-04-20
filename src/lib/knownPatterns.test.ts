import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_MULTISEND_OPERATIONS,
  DEFAULT_MULTICALL_PATTERN_NEST_LIMIT,
  getKnownPattern,
  isKnownMulticallSelector,
} from './knownPatterns.ts';

describe('knownPatterns', () => {
  it('exposes a default multicall nest limit', () => {
    expect(DEFAULT_MULTICALL_PATTERN_NEST_LIMIT).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_MULTICALL_PATTERN_NEST_LIMIT).toBeLessThanOrEqual(10);
  });

  it('recognizes bundled multicall selectors', () => {
    expect(isKnownMulticallSelector('0xac9650d8')).toBe(true);
    expect(getKnownPattern('0xac9650d8')?.name).toContain('multicall');
  });

  it('marks multiSend as requiring special handling', () => {
    expect(getKnownPattern('0x8d80ff0a')?.requiresSpecialHandling).toBe(true);
  });

  it('sets a conservative default maxOperations on multiSend', () => {
    const ms = getKnownPattern('0x8d80ff0a')?.calldataIndices.find(c => c.kind === 'gnosis-multisend');
    expect(ms?.kind).toBe('gnosis-multisend');
    if (ms?.kind === 'gnosis-multisend') {
      expect(ms.maxOperations).toBe(DEFAULT_MAX_MULTISEND_OPERATIONS);
    }
  });

  it('tags high-risk execution patterns', () => {
    expect(getKnownPattern('0x8d80ff0a')?.riskLevel).toBe('high');
    expect(getKnownPattern('0x6a761202')?.riskLevel).toBe('high');
    expect(getKnownPattern('0x468721a7')?.riskLevel).toBe('high');
    expect(getKnownPattern('0x8d80ff0a')?.description).toContain('DELEGATECALL');
  });

  it('normalizes pattern selectors to lowercase', () => {
    expect(getKnownPattern('0xAC9650D8')?.selector).toBe('0xac9650d8');
  });

  it('registers Safe module exec, 1inch swap, forwarder execute, CoW settle', () => {
    expect(getKnownPattern('0x468721a7')?.name).toBe('execTransactionFromModule');
    expect(getKnownPattern('0x12aa3caf')?.calldataIndices).toHaveLength(2);
    expect(getKnownPattern('0xdf905caf')?.calldataIndices).toHaveLength(2);
    expect(getKnownPattern('0x13d79a0b')?.name).toBe('settle');
    expect(getKnownPattern('0xccf96b4a')?.name).toBe('executeBatch');
  });

  it('registers Pendle swapTokensToTokens nested bytes in tuple-array', () => {
    const p = getKnownPattern('0xa373cf1a');
    expect(p?.name).toBe('swapTokensToTokens');
    expect(p?.calldataIndices).toEqual([
      {
        kind: 'tuple-field',
        paramIndex: 1,
        fieldIndex: 3,
        expectedParentType: 'tuple[]',
        expectedFieldType: 'bytes',
      },
    ]);
  });

  it('registers Enso routeMulti + executeShortcut nested-calldata hints', () => {
    expect(getKnownPattern('0xf52e33f5')?.calldataIndices).toEqual([
      { kind: 'direct', paramIndex: 1 },
    ]);
    expect(getKnownPattern('0x95352c9f')?.calldataIndices).toEqual([
      { kind: 'array-direct', paramIndex: 3 },
    ]);
  });
});
