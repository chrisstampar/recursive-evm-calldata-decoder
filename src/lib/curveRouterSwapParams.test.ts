import { describe, expect, it } from 'vitest';

import { curveRouterNgLayoutsMatchDerivedTypes } from './curveRouterNgAbi.ts';
import type { DecodedValue } from '../types/index.ts';
import {
  annotateCurveRouterSwapParams,
  formatCurveRouterPoolType,
  formatCurveRouterSwapType,
  isCurveSwapParamsMatrixOuterValue,
  summarizeCurveSwapParamsCollapsed,
  summarizeCurveSwapParamsCollapsedResult,
} from './curveRouterSwapParams.ts';

function primitive(raw: string): DecodedValue {
  return { kind: 'primitive', display: raw, raw };
}

function row(a: string, b: string, c: string, d: string, e: string): DecodedValue {
  return {
    kind: 'array',
    elementType: 'uint256[5]',
    elements: [primitive(a), primitive(b), primitive(c), primitive(d), primitive(e)],
  };
}

describe('curveRouterSwapParams', () => {
  it('keeps bundled v1 layout literals aligned with derived ABI type strings', () => {
    expect(curveRouterNgLayoutsMatchDerivedTypes()).toBe(true);
  });

  describe('formatCurveRouterSwapType', () => {
    it('maps documented swap_type codes', () => {
      expect(formatCurveRouterSwapType(0n)).toMatch(/unused/);
      expect(formatCurveRouterSwapType(1n)).toMatch(/exchange/);
      expect(formatCurveRouterSwapType(2n)).toBe('exchange_underlying');
      expect(formatCurveRouterSwapType(9n)).toMatch(/ERC4626/);
      expect(formatCurveRouterSwapType(99n)).toBe('unknown swap_type');
    });

    it('uses custom label registry when provided', () => {
      expect(formatCurveRouterSwapType(99n, { 99: 'custom swap' })).toBe('custom swap');
    });
  });

  describe('formatCurveRouterPoolType', () => {
    it('maps documented pool_type codes', () => {
      expect(formatCurveRouterPoolType(1n)).toBe('stable');
      expect(formatCurveRouterPoolType(10n)).toBe('stable-ng');
      expect(formatCurveRouterPoolType(30n)).toBe('tricrypto-ng');
      expect(formatCurveRouterPoolType(999n)).toBe('unknown pool_type');
    });

    it('uses custom label registry when provided', () => {
      expect(formatCurveRouterPoolType(40n, { 40: 'llamma-ng' })).toBe('llamma-ng');
    });
  });

  describe('annotateCurveRouterSwapParams', () => {
    it('returns a new tree with labels and does not mutate the input', () => {
      const matrix: DecodedValue = {
        kind: 'array',
        elementType: 'uint256[5][5]',
        elements: [
          row('1', '2', '2', '10', '3'),
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
        ],
      };

      const r = annotateCurveRouterSwapParams(matrix);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).not.toBe(matrix);
      expect(r.issues).toEqual([]);

      if (matrix.kind !== 'array') return;
      const r0orig = matrix.elements[0];
      if (r0orig.kind !== 'array' || r0orig.elements[2].kind !== 'primitive') return;
      expect(r0orig.elements[2].interpretation).toBeUndefined();

      if (r.value.kind !== 'array') return;
      const r0 = r.value.elements[0];
      if (r0.kind !== 'array') return;
      const p2 = r0.elements[2];
      expect(p2.kind).toBe('primitive');
      if (p2.kind !== 'primitive') return;
      expect(p2.interpretation).toContain('exchange_underlying');
      const p3 = r0.elements[3];
      const p4 = r0.elements[4];
      expect(p3.kind).toBe('primitive');
      expect(p4.kind).toBe('primitive');
      if (p3.kind !== 'primitive' || p4.kind !== 'primitive') return;
      expect(p3.interpretation).toContain('stable-ng');
      expect(p4.interpretation).toContain('n_coins: 3');

      const r1 = r.value.elements[1];
      if (r1.kind !== 'array' || r1.elements[0].kind !== 'primitive') return;
      expect(r1.elements[0].interpretation).toMatch(/Hop 2: unused/);
    });

    it('returns invalid_root_shape without cloning on wrong top-level shape', () => {
      const bad: DecodedValue = { kind: 'array', elementType: 'uint256[]', elements: [] };
      const r = annotateCurveRouterSwapParams(bad);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('invalid_root_shape');
      expect(r.value).toBe(bad);
    });

    it('returns unsupported_router_version for unknown layout keys', () => {
      const matrix: DecodedValue = {
        kind: 'array',
        elementType: 'uint256[5][5]',
        elements: [row('0', '0', '0', '0', '0'), row('0', '0', '0', '0', '0'), row('0', '0', '0', '0', '0'), row('0', '0', '0', '0', '0'), row('0', '0', '0', '0', '0')],
      };
      const r = annotateCurveRouterSwapParams(matrix, { routerVersion: 'v999' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('unsupported_router_version');
      expect(r.value).toBe(matrix);
    });

    it('accumulates hop issues for malformed rows while still annotating valid hops', () => {
      const matrix: DecodedValue = {
        kind: 'array',
        elementType: 'uint256[5][5]',
        elements: [
          row('1', '2', '2', '10', '3'),
          { kind: 'array', elementType: 'uint256[3]', elements: [primitive('1'), primitive('2'), primitive('3')] },
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
        ],
      };
      const r = annotateCurveRouterSwapParams(matrix);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.issues).toEqual([{ hopIndex: 1, reason: 'invalid_hop_row_shape' }]);
      if (r.value.kind !== 'array') return;
      const r0 = r.value.elements[0];
      if (r0.kind !== 'array' || r0.elements[2].kind !== 'primitive') return;
      expect(r0.elements[2].interpretation).toContain('exchange_underlying');
    });
  });

  describe('summarizeCurveSwapParamsCollapsed', () => {
    it('summarizes first active hop and counts multiple', () => {
      const matrix: DecodedValue = {
        kind: 'array',
        elementType: 'uint256[5][5]',
        elements: [
          row('1', '2', '2', '10', '3'),
          row('0', '0', '1', '1', '2'),
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
        ],
      };
      const s = summarizeCurveSwapParamsCollapsed(matrix);
      expect(s).toBeTruthy();
      expect(s).toMatch(/2 active hops/);
      expect(s).toMatch(/exchange_underlying/);
    });
  });

  describe('isCurveSwapParamsMatrixOuterValue', () => {
    it('is a boolean guard (never null) and ignores inner row validity', () => {
      const validOuter: DecodedValue = {
        kind: 'array',
        elementType: 'uint256[5][5]',
        elements: [
          row('1', '2', '2', '10', '3'),
          { kind: 'array', elementType: 'uint256[2]', elements: [primitive('1'), primitive('2')] },
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
        ],
      };
      const r = isCurveSwapParamsMatrixOuterValue(validOuter);
      expect(typeof r).toBe('boolean');
      expect(r).toBe(true);
    });
  });

  describe('summarizeCurveSwapParamsCollapsedResult', () => {
    it('returns explicit failure reasons instead of only null', () => {
      const badInner: DecodedValue = {
        kind: 'array',
        elementType: 'uint256[5][5]',
        elements: [
          row('1', '2', '2', '10', '3'),
          { kind: 'array', elementType: 'uint256[2]', elements: [primitive('1'), primitive('2')] },
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
          row('0', '0', '0', '0', '0'),
        ],
      };
      expect(summarizeCurveSwapParamsCollapsed(badInner)).toBe(null);
      expect(summarizeCurveSwapParamsCollapsedResult(badInner)).toEqual({
        ok: false,
        reason: 'malformed_hop_row',
        hopIndex: 1,
      });
    });
  });
});
