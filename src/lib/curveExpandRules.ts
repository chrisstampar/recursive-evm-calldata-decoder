import {
  CURVE_ROUTER_NG_SWAP_PARAMS_HOP_ROW_TYPE,
  CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE,
  CURVE_ROUTER_NG_SWAP_PARAMS_PARAM_ALIASES,
} from './curveRouterNgAbi.ts';
import type { ComputeInitialExpandedInput, ExpansionRule } from './treeExpandTypes.ts';

const SWAP_PARAMS_PARAM_NAMES = new Set<string>(CURVE_ROUTER_NG_SWAP_PARAMS_PARAM_ALIASES);

function normType(t: string | undefined): string {
  return (t ?? '').replace(/\s/g, '');
}

/**
 * Whether this array is the outer Curve router-ng swap-params matrix for a declaring param.
 * Uses names/types from `curveRouterNgAbi.ts` (`CURVE_ROUTER_NG_SWAP_PARAMS_*`).
 */
export function isCurveSwapParamsOuterMatrix(
  declaringParam: { name: string; type: string } | undefined,
  elementType: string | undefined,
): boolean {
  if (!declaringParam) return false;
  const matrix = normType(CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE);
  return (
    SWAP_PARAMS_PARAM_NAMES.has(declaringParam.name) &&
    normType(declaringParam.type) === matrix &&
    normType(elementType) === matrix
  );
}

/**
 * Minimum `expansionWeight` for treating a hop-row array as nested under the swap-params matrix. Callers set
 * this weight only when `isCurveSwapParamsOuterMatrix` applies to the parent so unrelated hop-row-shaped arrays
 * stay depth-expanded as usual.
 */
export const CURVE_SWAP_PARAMS_HOP_EXPANSION_WEIGHT = 1;

/**
 * Curve router-ng swap-params defaults to **collapsed** because:
 *
 * - The outer value is a **`uint256[5][5]`** “routing matrix”: each row is five **numeric indices**
 *   (`swap_type`, `pool_type`, pool id slots, `n_coins`, etc.) that are meaningful mainly next to the parent
 *   **`exchange`** / router call—not as five bare numbers in a list.
 * - Expanding the matrix upfront pushes **25 opaque integers** ahead of the function name and amounts, which
 *   reads worse than a single **`[5 hops]`** row plus the italic collapsed summary from `curveRouterSwapParams`.
 *
 * Per-hop **`uint256[5]`** rows use the same default for the same reason: the five fields are index/config
 * tuples; the parent matrix toggle is the right primary control.
 *
 * Protocol-specific rules for this family live in this file only; generic policy is `treeExpandPolicy.ts`.
 */
export const curveExpansionRules: readonly ExpansionRule[] = [
  {
    match: (input: ComputeInitialExpandedInput) =>
      input.kind === 'array' &&
      isCurveSwapParamsOuterMatrix(input.declaringParam, input.elementType),
    expand: false,
  },
  {
    match: (input: ComputeInitialExpandedInput) =>
      input.kind === 'array' &&
      normType(input.elementType) === normType(CURVE_ROUTER_NG_SWAP_PARAMS_HOP_ROW_TYPE) &&
      (input.expansionWeight ?? 0) >= CURVE_SWAP_PARAMS_HOP_EXPANSION_WEIGHT,
    expand: false,
  },
];
