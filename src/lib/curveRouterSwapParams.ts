/**
 * Curve router-ng `_swap_params` helpers.
 *
 * - **Purity:** {@link annotateCurveRouterSwapParams} never mutates its input; it deep-clones and only writes
 *   `interpretation` on the returned tree when `ok: true`.
 * - **Dimensions:** Hop/column counts come from `getCurveRouterNgSwapParamsLayout` /
 *   `CURVE_ROUTER_NG_SWAP_PARAMS_LAYOUTS` in `curveRouterNgAbi.ts` (not `HOP_ROWS` locals).
 */

import type { DecodedCall, DecodedValue } from '../types/index.ts';
import {
  CURVE_ROUTER_NG_PARAMS_VERSION_DEFAULT,
  getCurveRouterNgSwapParamsLayout,
} from './curveRouterNgAbi.ts';
import { tryParseBigInt } from './valueFormatter.ts';

function normElementType(t: string): string {
  return t.replace(/\s/g, '');
}

/** Default NatSpec-style labels for `swap_type` (column 2 in v1). Override or extend via options. */
export const DEFAULT_CURVE_ROUTER_SWAP_TYPE_LABELS: Readonly<Record<number, string>> = {
  1: 'exchange (plain pool swap)',
  2: 'exchange_underlying',
  3: 'underlying via zap (metapool / crypto-meta)',
  4: 'coin → LP (add_liquidity)',
  5: 'lending underlying → LP (add_liquidity)',
  6: 'LP → one coin (remove_liquidity_one_coin)',
  7: 'LP → lending/fake-pool underlying (remove_liquidity_one_coin)',
  8: 'ETH/WETH/stETH/frxETH/wstETH/wBETH helpers',
  9: 'ERC4626 asset ↔ share',
};

/** Default labels for `pool_type` (column 3 in v1). */
export const DEFAULT_CURVE_ROUTER_POOL_TYPE_LABELS: Readonly<Record<number, string>> = {
  1: 'stable',
  2: 'twocrypto',
  3: 'tricrypto',
  4: 'llamma',
  10: 'stable-ng',
  20: 'twocrypto-ng',
  30: 'tricrypto-ng',
};

function mergeNumericLabels(
  base: Readonly<Record<number, string>>,
  override?: Readonly<Record<number, string>>,
): Record<number, string> {
  return override ? { ...base, ...override } : { ...base };
}

/** Human-readable `swap_type` (column index 2 in v1 layout). */
export function formatCurveRouterSwapType(
  value: bigint,
  labels: Readonly<Record<number, string>> = DEFAULT_CURVE_ROUTER_SWAP_TYPE_LABELS,
): string {
  if (value === 0n) return 'unused / unset';
  const n = value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 'unknown swap_type';
  return labels[n] ?? 'unknown swap_type';
}

/** Human-readable `pool_type` (column index 3 in v1 layout). */
export function formatCurveRouterPoolType(
  value: bigint,
  labels: Readonly<Record<number, string>> = DEFAULT_CURVE_ROUTER_POOL_TYPE_LABELS,
): string {
  if (value === 0n) return 'unused / unset';
  const n = value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 'unknown pool_type';
  return labels[n] ?? 'unknown pool_type';
}

function cloneDecodedCall(call: DecodedCall): DecodedCall {
  return {
    ...call,
    signature: {
      ...call.signature,
      params: call.signature.params.map(p => ({ ...p })),
    },
    alternatives: call.alternatives.map(alt => ({
      ...alt,
      params: alt.params.map(p => ({ ...p })),
    })),
    params: call.params.map(p => ({ ...p, value: cloneDecodedValue(p.value) })),
  };
}

function cloneDecodedValue(value: DecodedValue): DecodedValue {
  switch (value.kind) {
    case 'primitive':
      return {
        kind: 'primitive',
        display: value.display,
        raw: value.raw,
        interpretation: value.interpretation,
        embeddedEvmAddress: value.embeddedEvmAddress
          ? { ...value.embeddedEvmAddress }
          : undefined,
      };
    case 'address':
      return { ...value };
    case 'bytes':
      return {
        kind: 'bytes',
        hex: value.hex,
        decoded: value.decoded ? cloneDecodedCall(value.decoded) : undefined,
        wordAlignedAddresses: value.wordAlignedAddresses?.map(w => ({ ...w })),
      };
    case 'array':
      return {
        kind: 'array',
        elementType: value.elementType,
        elements: value.elements.map(cloneDecodedValue),
      };
    case 'tuple':
      return {
        kind: 'tuple',
        fields: value.fields.map(f => ({
          ...f,
          value: cloneDecodedValue(f.value),
        })),
      };
    default: {
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}

function rowAllFiveZero(i: bigint, j: bigint, swapType: bigint, poolType: bigint, nCoins: bigint): boolean {
  return i === 0n && j === 0n && swapType === 0n && poolType === 0n && nCoins === 0n;
}

export type AnnotateCurveRouterSwapParamsFailureReason =
  | 'invalid_root_shape'
  | 'unsupported_router_version';

export type AnnotateCurveRouterSwapParamsHopIssueReason =
  | 'invalid_hop_row_shape'
  | 'non_primitive_cell'
  | 'unparseable_primitive';

export type AnnotateCurveRouterSwapParamsIssue = {
  hopIndex: number;
  reason: AnnotateCurveRouterSwapParamsHopIssueReason;
};

export type AnnotateCurveRouterSwapParamsOk = {
  ok: true;
  value: DecodedValue;
  issues: AnnotateCurveRouterSwapParamsIssue[];
};

export type AnnotateCurveRouterSwapParamsErr = {
  ok: false;
  reason: AnnotateCurveRouterSwapParamsFailureReason;
  value: DecodedValue;
};

export type AnnotateCurveRouterSwapParamsResult = AnnotateCurveRouterSwapParamsOk | AnnotateCurveRouterSwapParamsErr;

export interface AnnotateCurveRouterSwapParamsOptions {
  /** Matrix layout key; must exist in `CURVE_ROUTER_NG_SWAP_PARAMS_LAYOUTS`. */
  routerVersion?: string;
  swapTypeLabels?: Readonly<Record<number, string>>;
  poolTypeLabels?: Readonly<Record<number, string>>;
}

function annotateV1HopRow(
  row: Extract<DecodedValue, { kind: 'array' }>,
  hop: number,
  colsPerRow: number,
  swapLabels: Readonly<Record<number, string>>,
  poolLabels: Readonly<Record<number, string>>,
): AnnotateCurveRouterSwapParamsHopIssueReason | null {
  if (row.elements.length !== colsPerRow) return 'invalid_hop_row_shape';

  const cells = row.elements;
  const nums: bigint[] = [];
  for (let c = 0; c < colsPerRow; c++) {
    const cell = cells[c];
    if (cell.kind !== 'primitive') return 'non_primitive_cell';
    const v = tryParseBigInt(cell.raw);
    if (v === null) return 'unparseable_primitive';
    nums.push(v);
  }

  const [i, j, swapType, poolType, nCoins] = nums;

  if (rowAllFiveZero(i, j, swapType, poolType, nCoins)) {
    const z0 = cells[0];
    if (z0.kind === 'primitive') {
      z0.interpretation = `Hop ${hop + 1}: unused row (padding)`;
    }
    for (let c = 1; c < colsPerRow; c++) {
      const cell = cells[c];
      if (cell.kind === 'primitive') cell.interpretation = undefined;
    }
    return null;
  }

  const erc4626Note =
    swapType === 9n ? ' — ERC4626: i=0 asset→share, i=1 share→asset' : '';

  const c0 = cells[0];
  const c1 = cells[1];
  const c2 = cells[2];
  const c3 = cells[3];
  const c4 = cells[4];
  if (c0.kind === 'primitive') {
    c0.interpretation = `i: ${i} (input coin index${erc4626Note})`;
  }
  if (c1.kind === 'primitive') {
    c1.interpretation = `j: ${j} (output coin index)`;
  }
  if (c2.kind === 'primitive') {
    c2.interpretation = `swap_type: ${swapType} (${formatCurveRouterSwapType(swapType, swapLabels)})`;
  }
  if (c3.kind === 'primitive') {
    c3.interpretation = `pool_type: ${poolType} (${formatCurveRouterPoolType(poolType, poolLabels)})`;
  }
  if (c4.kind === 'primitive') {
    c4.interpretation = `n_coins: ${nCoins} (coins in this pool)`;
  }
  return null;
}

/**
 * Returns a **deep copy** of `swapParams` with per-cell `interpretation` for Curve router-ng `_swap_params`
 * (`[i, j, swap_type, pool_type, n_coins]` per hop for v1).
 *
 * **Does not mutate** `swapParams`: the argument is read-only from the caller’s perspective; when `ok: true`,
 * only the returned `value` (a clone) is updated. When `ok: false`, `value` is the same reference as the input.
 */
export function annotateCurveRouterSwapParams(
  swapParams: DecodedValue,
  options?: AnnotateCurveRouterSwapParamsOptions,
): AnnotateCurveRouterSwapParamsResult {
  const version = options?.routerVersion ?? CURVE_ROUTER_NG_PARAMS_VERSION_DEFAULT;
  const layout = getCurveRouterNgSwapParamsLayout(version);
  if (!layout) {
    return { ok: false, reason: 'unsupported_router_version', value: swapParams };
  }

  if (
    swapParams.kind !== 'array' ||
    swapParams.elements.length !== layout.hopCount ||
    normElementType(swapParams.elementType) !== normElementType(layout.matrixElementType)
  ) {
    return { ok: false, reason: 'invalid_root_shape', value: swapParams };
  }

  const swapLabels = mergeNumericLabels(DEFAULT_CURVE_ROUTER_SWAP_TYPE_LABELS, options?.swapTypeLabels);
  const poolLabels = mergeNumericLabels(DEFAULT_CURVE_ROUTER_POOL_TYPE_LABELS, options?.poolTypeLabels);

  const out = cloneDecodedValue(swapParams);
  if (out.kind !== 'array') {
    return { ok: false, reason: 'invalid_root_shape', value: swapParams };
  }

  const issues: AnnotateCurveRouterSwapParamsIssue[] = [];

  for (let hop = 0; hop < layout.hopCount; hop++) {
    const row = out.elements[hop];
    if (row.kind !== 'array') {
      issues.push({ hopIndex: hop, reason: 'invalid_hop_row_shape' });
      continue;
    }
    const err = annotateV1HopRow(row, hop, layout.colsPerRow, swapLabels, poolLabels);
    if (err) issues.push({ hopIndex: hop, reason: err });
  }

  return { ok: true, value: out, issues };
}

export interface CurveSwapParamsMatrixOptions {
  routerVersion?: string;
  swapTypeLabels?: Readonly<Record<number, string>>;
  poolTypeLabels?: Readonly<Record<number, string>>;
}

/**
 * **Boolean** type guard only (never `null`). True when `value` is an array whose `elementType` and row count
 * match the given `routerVersion` layout in `curveRouterNgAbi.ts`. Does **not** validate
 * inner hop rows—use {@link summarizeCurveSwapParamsCollapsedResult} when you need row-level failure reasons.
 */
export function isCurveSwapParamsMatrixOuterValue(
  value: DecodedValue,
  routerVersion: string = CURVE_ROUTER_NG_PARAMS_VERSION_DEFAULT,
): value is Extract<DecodedValue, { kind: 'array' }> {
  const layout = getCurveRouterNgSwapParamsLayout(routerVersion);
  if (!layout) return false;
  return (
    value.kind === 'array' &&
    normElementType(value.elementType) === normElementType(layout.matrixElementType) &&
    value.elements.length === layout.hopCount
  );
}

export type SummarizeCurveSwapParamsFailureReason =
  | 'unsupported_router_version'
  | 'not_an_array'
  | 'wrong_matrix_element_type'
  | 'wrong_hop_row_count'
  | 'malformed_hop_row'
  | 'non_primitive_cell'
  | 'unparseable_primitive'
  | 'unsupported_column_layout';

export type SummarizeCurveSwapParamsCollapsedResult =
  | { ok: true; summary: string }
  | { ok: false; reason: SummarizeCurveSwapParamsFailureReason; hopIndex?: number };

/**
 * Like {@link summarizeCurveSwapParamsCollapsed} but returns **structured** success/failure (with `reason` and
 * optional `hopIndex`) instead of collapsing all errors to `null`.
 */
export function summarizeCurveSwapParamsCollapsedResult(
  value: DecodedValue,
  options?: CurveSwapParamsMatrixOptions,
): SummarizeCurveSwapParamsCollapsedResult {
  const version = options?.routerVersion ?? CURVE_ROUTER_NG_PARAMS_VERSION_DEFAULT;
  const layout = getCurveRouterNgSwapParamsLayout(version);
  if (!layout) return { ok: false, reason: 'unsupported_router_version' };

  if (value.kind !== 'array') return { ok: false, reason: 'not_an_array' };
  if (normElementType(value.elementType) !== normElementType(layout.matrixElementType)) {
    return { ok: false, reason: 'wrong_matrix_element_type' };
  }
  if (value.elements.length !== layout.hopCount) {
    return { ok: false, reason: 'wrong_hop_row_count' };
  }

  if (layout.colsPerRow !== 5) {
    return { ok: false, reason: 'unsupported_column_layout' };
  }

  const swapLabels = mergeNumericLabels(DEFAULT_CURVE_ROUTER_SWAP_TYPE_LABELS, options?.swapTypeLabels);
  const poolLabels = mergeNumericLabels(DEFAULT_CURVE_ROUTER_POOL_TYPE_LABELS, options?.poolTypeLabels);

  const activeRows: number[] = [];
  let firstLine = '';

  for (let hop = 0; hop < layout.hopCount; hop++) {
    const row = value.elements[hop];
    if (row.kind !== 'array' || row.elements.length !== layout.colsPerRow) {
      return { ok: false, reason: 'malformed_hop_row', hopIndex: hop };
    }

    const nums: bigint[] = [];
    for (let c = 0; c < layout.colsPerRow; c++) {
      const cell = row.elements[c];
      if (cell.kind !== 'primitive') {
        return { ok: false, reason: 'non_primitive_cell', hopIndex: hop };
      }
      const v = tryParseBigInt(cell.raw);
      if (v === null) {
        return { ok: false, reason: 'unparseable_primitive', hopIndex: hop };
      }
      nums.push(v);
    }

    const [i, j, swapType, poolType, nCoins] = nums;
    if (rowAllFiveZero(i, j, swapType, poolType, nCoins)) continue;

    activeRows.push(hop);
    if (!firstLine) {
      const st = formatCurveRouterSwapType(swapType, swapLabels);
      const pt = formatCurveRouterPoolType(poolType, poolLabels);
      firstLine = `Hop ${hop + 1}: i=${i} j=${j} · ${st} · ${pt} · ${nCoins} coin${nCoins === 1n ? '' : 's'}`;
    }
  }

  if (activeRows.length === 0) return { ok: true, summary: 'No active hops (all rows padding).' };
  if (activeRows.length === 1) return { ok: true, summary: firstLine };
  return { ok: true, summary: `${activeRows.length} active hops — ${firstLine}` };
}

/**
 * One-line preview when the matrix is collapsed (reads decoded cells; no network).
 * Returns `null` on any structural mismatch; use {@link summarizeCurveSwapParamsCollapsedResult} for **why**.
 */
export function summarizeCurveSwapParamsCollapsed(
  value: DecodedValue,
  options?: CurveSwapParamsMatrixOptions,
): string | null {
  const r = summarizeCurveSwapParamsCollapsedResult(value, options);
  return r.ok ? r.summary : null;
}
