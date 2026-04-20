export type ExpandableNodeKind = 'call' | 'array' | 'tuple';

export interface ComputeInitialExpandedInput {
  kind: ExpandableNodeKind;
  /** Call-frame depth or ValueDisplay depth (0-based); negative values are treated as collapsed. */
  depth: number;
  autoExpandMaxDepth: number;
  /** For arrays/tuples: number of children (elements or fields). Used for empty-container defaults. */
  childCount: number;
  /**
   * When this value is rendered as a function argument or tuple field (`ParamRow`).
   * Omitted for nested values inside arrays (e.g. hop rows under `_swap_params`).
   */
  declaringParam?: { name: string; type: string };
  /** `DecodedValue.elementType` when `kind === 'array'`. */
  elementType?: string;
  /**
   * Optional UI “weight” so rules can threshold on complexity (e.g. number of numeric children) instead of
   * protocol-specific booleans. Example: set `curveExpandRules`’ hop weight only for `uint256[5]` rows
   * nested under a Curve `_swap_params` matrix.
   */
  expansionWeight?: number;
}

/**
 * Ordered rule list: first matching rule wins; if none match, depth-based fallback applies in `treeExpandPolicy`.
 */
export interface ExpansionRule {
  match: (input: ComputeInitialExpandedInput) => boolean;
  expand: boolean;
}
