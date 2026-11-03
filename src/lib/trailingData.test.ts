import { describe, expect, it } from 'vitest';

import { classifyTrailingData } from './trailingData.ts';

/** Tails taken from real mainnet / Base transactions (Nov 2026 corpus run). */
describe('classifyTrailingData', () => {
  it('names ERC-8021 builder codes and extracts the code', () => {
    const r = classifyTrailingData('0x62635f73637869696d61390b0080218021802180218021802180218021');
    expect(r.kind).toBe('erc8021');
    expect(r.label).toMatch(/bc_scxiima9/);
  });

  it('recognises the Across integrator tag', () => {
    expect(classifyTrailingData('0x1dc0de00bc73c0de').kind).toBe('across-integrator');
    expect(classifyTrailingData('0x1dc0de00410000000c').kind).toBe('across-integrator');
  });

  it('treats 4- to 32-byte tails (Seaport / 1inch / Uniswap markers, request IDs) as short tags', () => {
    expect(classifyTrailingData('0x3d958fe2').kind).toBe('short-tag');
    expect(classifyTrailingData('0x756e6978000001a19b1345248000929c6c81e4730100').kind).toBe('short-tag');
    expect(classifyTrailingData('0x' + '17'.repeat(32)).kind).toBe('short-tag');
  });

  it('calls out the ERC-2771 20-byte sender suffix', () => {
    expect(classifyTrailingData('0x' + '11'.repeat(20)).kind).toBe('erc2771-sender');
  });

  it('leaves long unexplained tails as unknown', () => {
    const r = classifyTrailingData('0x' + 'ab'.repeat(558));
    expect(r.kind).toBe('unknown');
    expect(r.byteLength).toBe(558);
  });
});
