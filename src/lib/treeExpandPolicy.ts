/**
 * Single place that decides whether decode-tree nodes start expanded.
 * Protocol-specific behavior lives in rule modules (e.g. `curveExpandRules.ts`) and shared ABI hints
 * (`curveRouterNgAbi.ts`); register more rules via `options.rules`.
 */

import { curveExpansionRules } from './curveExpandRules.ts';
import type { ComputeInitialExpandedInput, ExpansionRule } from './treeExpandTypes.ts';

export type { ComputeInitialExpandedInput, ExpansionRule, ExpandableNodeKind } from './treeExpandTypes.ts';

export {
  curveExpansionRules,
  CURVE_SWAP_PARAMS_HOP_EXPANSION_WEIGHT,
  isCurveSwapParamsOuterMatrix,
} from './curveExpandRules.ts';

export {
  CURVE_ROUTER_NG_SWAP_PARAMS_HOP_ROW_TYPE,
  CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE,
  CURVE_ROUTER_NG_SWAP_PARAMS_PARAM_ALIASES,
} from './curveRouterNgAbi.ts';

const structuralExpansionRules: readonly ExpansionRule[] = [
  {
    match: input => input.depth < 0,
    expand: false,
  },
  {
    match: input => input.kind === 'array' && input.childCount === 0,
    expand: false,
  },
];

/** Default ordered rules: structural edge cases, then Curve, then depth fallback in {@link computeInitialExpanded}. */
export const DEFAULT_EXPANSION_RULES: readonly ExpansionRule[] = [
  ...structuralExpansionRules,
  ...curveExpansionRules,
];

/**
 * Default expanded state for a new node (bulk expand/collapse overrides via `TreeExpansionContext`).
 *
 * @param options.rules — Optional full rule list (e.g. tests or extra protocol plugins prepended). When omitted,
 *   uses {@link DEFAULT_EXPANSION_RULES}.
 */
export function computeInitialExpanded(
  input: ComputeInitialExpandedInput,
  options?: { rules?: readonly ExpansionRule[] },
): boolean {
  const rules = options?.rules ?? DEFAULT_EXPANSION_RULES;
  for (const rule of rules) {
    if (rule.match(input)) return rule.expand;
  }

  const depth = Math.max(0, input.depth);
  if (input.kind === 'call' || input.kind === 'tuple' || input.kind === 'array') {
    return depth < input.autoExpandMaxDepth;
  }
  return false;
}
