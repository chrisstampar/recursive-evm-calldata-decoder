import { describe, expect, it } from 'vitest';

import {
  computeInitialExpanded,
  CURVE_ROUTER_NG_SWAP_PARAMS_HOP_ROW_TYPE,
  CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE,
  CURVE_ROUTER_NG_SWAP_PARAMS_PARAM_ALIASES,
  CURVE_SWAP_PARAMS_HOP_EXPANSION_WEIGHT,
  DEFAULT_EXPANSION_RULES,
  isCurveSwapParamsOuterMatrix,
} from './treeExpandPolicy.ts';
import type { ComputeInitialExpandedInput, ExpansionRule } from './treeExpandTypes.ts';

const base = { autoExpandMaxDepth: 3, childCount: 5 };

describe('treeExpandPolicy', () => {
  it('expands calls and tuples by depth vs autoExpandMaxDepth', () => {
    expect(computeInitialExpanded({ kind: 'call', depth: 0, ...base })).toBe(true);
    expect(computeInitialExpanded({ kind: 'call', depth: 2, ...base })).toBe(true);
    expect(computeInitialExpanded({ kind: 'call', depth: 3, ...base })).toBe(false);
    expect(computeInitialExpanded({ kind: 'tuple', depth: 1, ...base, childCount: 2 })).toBe(true);
  });

  it('collapses empty arrays regardless of depth budget', () => {
    expect(
      computeInitialExpanded({
        kind: 'array',
        depth: 0,
        autoExpandMaxDepth: 3,
        childCount: 0,
        elementType: 'uint256[]',
      }),
    ).toBe(false);
  });

  it('collapses when depth is negative', () => {
    expect(
      computeInitialExpanded({
        kind: 'array',
        depth: -1,
        ...base,
        elementType: 'uint256[]',
      }),
    ).toBe(false);
    expect(
      computeInitialExpanded({
        kind: 'call',
        depth: -3,
        ...base,
        childCount: 2,
      }),
    ).toBe(false);
  });

  it('fallback clamps depth when the negative-depth rule is not in the list', () => {
    const probe: ComputeInitialExpandedInput = {
      kind: 'tuple',
      depth: -1,
      autoExpandMaxDepth: 3,
      childCount: 1,
    };
    const withoutNegativeDepth = DEFAULT_EXPANSION_RULES.filter(r => !r.match(probe));
    expect(withoutNegativeDepth.length).toBe(DEFAULT_EXPANSION_RULES.length - 1);
    expect(computeInitialExpanded(probe, { rules: withoutNegativeDepth })).toBe(true);
  });

  it('collapses Curve router-ng swap-params outer matrix and hop rows', () => {
    const paramName = CURVE_ROUTER_NG_SWAP_PARAMS_PARAM_ALIASES[0];
    expect(
      isCurveSwapParamsOuterMatrix(
        { name: paramName, type: CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE },
        CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE,
      ),
    ).toBe(true);

    expect(
      computeInitialExpanded({
        kind: 'array',
        depth: 0,
        ...base,
        declaringParam: { name: paramName, type: CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE },
        elementType: CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE,
      }),
    ).toBe(false);

    expect(
      computeInitialExpanded({
        kind: 'array',
        depth: 1,
        ...base,
        elementType: CURVE_ROUTER_NG_SWAP_PARAMS_HOP_ROW_TYPE,
        expansionWeight: CURVE_SWAP_PARAMS_HOP_EXPANSION_WEIGHT,
      }),
    ).toBe(false);
  });

  it('does not collapse same matrix shape under an unknown param name (fork / ABI drift)', () => {
    expect(
      computeInitialExpanded({
        kind: 'array',
        depth: 0,
        ...base,
        declaringParam: { name: 'swap_params', type: CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE },
        elementType: CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE,
      }),
    ).toBe(true);
  });

  it('does not treat inner hop row type as special without hop expansion weight', () => {
    expect(
      computeInitialExpanded({
        kind: 'array',
        depth: 1,
        ...base,
        elementType: CURVE_ROUTER_NG_SWAP_PARAMS_HOP_ROW_TYPE,
      }),
    ).toBe(true);
  });

  it('allows prepended plugin rules via options.rules', () => {
    const plugin: ExpansionRule = {
      match: i => i.kind === 'array' && i.elementType === 'uint256[]',
      expand: false,
    };
    expect(
      computeInitialExpanded(
        {
          kind: 'array',
          depth: 0,
          autoExpandMaxDepth: 5,
          childCount: 3,
          elementType: 'uint256[]',
        },
        { rules: [plugin, ...DEFAULT_EXPANSION_RULES] },
      ),
    ).toBe(false);
  });
});
