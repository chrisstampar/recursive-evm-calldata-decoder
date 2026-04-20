/**
 * Canonical **curve-router-ng** (`Router.vy`) ABI hints shared by expansion policy and swap-param formatting.
 *
 * **Forks / upgrades:** Parameter names and exact type spellings can differ on forked routers or future Curve
 * releases. Prefer appending aliases here (or passing extra rules to `computeInitialExpanded`) rather than
 * scattering new magic strings. Shape-based detection (fixed `uint256[5][5]` matrix) is
 * still inherently tied to this router family’s encoding.
 */

/** Declared parameter names treated as the routing matrix (canonical + optional fork aliases). */
export const CURVE_ROUTER_NG_SWAP_PARAMS_PARAM_ALIASES = ['_swap_params'] as const;

/** Outer routing matrix: five hop rows, each a fixed quintuple of router indices. Whitespace-normalized before compare. */
export const CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE = 'uint256[5][5]';

/** Single hop row inside {@link CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE}. */
export const CURVE_ROUTER_NG_SWAP_PARAMS_HOP_ROW_TYPE = 'uint256[5]';

export const CURVE_ROUTER_NG_SWAP_PARAMS_HOP_COUNT = 5;
export const CURVE_ROUTER_NG_SWAP_PARAMS_COLS_PER_ROW = 5;

function normAbiType(t: string): string {
  return t.replace(/\s/g, '');
}

function buildHopRowType(colsPerRow: number): string {
  return `uint256[${colsPerRow}]`;
}

function buildMatrixType(colsPerRow: number, hopCount: number): string {
  return `uint256[${colsPerRow}][${hopCount}]`;
}

/** Known router `_swap_params` matrix shapes (add rows here when Curve ships new column counts). */
export interface CurveRouterNgSwapParamsLayout {
  hopCount: number;
  colsPerRow: number;
  matrixElementType: string;
  hopRowElementType: string;
}

export const CURVE_ROUTER_NG_SWAP_PARAMS_LAYOUTS: Readonly<
  Record<string, CurveRouterNgSwapParamsLayout>
> = {
  v1: {
    hopCount: CURVE_ROUTER_NG_SWAP_PARAMS_HOP_COUNT,
    colsPerRow: CURVE_ROUTER_NG_SWAP_PARAMS_COLS_PER_ROW,
    matrixElementType: CURVE_ROUTER_NG_SWAP_PARAMS_MATRIX_TYPE,
    hopRowElementType: CURVE_ROUTER_NG_SWAP_PARAMS_HOP_ROW_TYPE,
  },
};

export function getCurveRouterNgSwapParamsLayout(version: string): CurveRouterNgSwapParamsLayout | null {
  const layout = CURVE_ROUTER_NG_SWAP_PARAMS_LAYOUTS[version];
  return layout ?? null;
}

/** Default `routerVersion` for `annotateCurveRouterSwapParams` / collapsed summaries. */
export const CURVE_ROUTER_NG_PARAMS_VERSION_DEFAULT = 'v1';

/** @internal Dev-only consistency check between literals and derived `uint256[c][h]` names. */
export function curveRouterNgLayoutsMatchDerivedTypes(): boolean {
  const l = CURVE_ROUTER_NG_SWAP_PARAMS_LAYOUTS.v1;
  return (
    normAbiType(l.matrixElementType) === normAbiType(buildMatrixType(l.colsPerRow, l.hopCount)) &&
    normAbiType(l.hopRowElementType) === normAbiType(buildHopRowType(l.colsPerRow))
  );
}
