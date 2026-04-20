import { isValidFunctionSelector } from './sanitize.ts';

/**
 * Defines which parameters in known multicall/batch function signatures
 * contain nested calldata that should be recursively decoded.
 *
 * The `calldataParams` array contains paths to the bytes field(s)
 * that hold encoded function calls:
 *   - A number means: decoded params[N] is calldata (bytes or bytes[])
 *   - A tuple like [N, fieldIndex] means: params[N] is a tuple/struct array,
 *     and fieldIndex within each tuple element is calldata
 *
 * **Nesting limits** (enforced in `decoder.ts`, not here): each pattern-driven nested
 * decode increments a counter capped by `DecodeOptions.multicallNestLimit` (default
 * {@link DEFAULT_MULTICALL_PATTERN_NEST_LIMIT}), `DecodeOptions.maxDepth`, and optional
 * per-pattern `maxRecursionDepth`. Set `allowRecursive: false` to refuse expanding nested
 * calldata whose selector is another known multicall (pathological chains).
 *
 * **Gnosis `multiSend(bytes)`** (`0x8d80ff0a`): the first argument uses **custom packed encoding**, not
 * standard ABI tuple layout. Each segment is: `operation` (1 byte) + `to` (20 bytes) + `value` (32 bytes)
 * + `dataLength` (32 bytes) + `data` (`dataLength` bytes). Parsed in `convertGnosisMultiSend` in `decoder.ts`;
 * malformed tails stop at boundary checks without throwing.
 *
 * **Permit2 `permit` and ERC-20 EIP-2612 `permit`**: not modeled as nested-calldata patterns. Both carry
 * **structured approval data** (token, spender, amount or allowance, deadline, nonce, and `v`/`r`/`s` or typed
 * signatures)—not generic `bytes` that ABI-decodes into another **contract call**. The decoder therefore has no
 * inner calldata tree to expand; normal ABI decoding is the right way to present these fields.
 */

/** Default cap on nested calldata expansion along known batch/multicall patterns (decoder may set lower via `DecodeOptions.multicallNestLimit`). */
export const DEFAULT_MULTICALL_PATTERN_NEST_LIMIT = 5;

/**
 * Default max elements expanded for `bytes[]` and tuple batch rows when a pattern omits `maxArrayLength`.
 * (Gnosis `multiSend` uses {@link DEFAULT_MAX_MULTISEND_OPERATIONS} instead—Safe batches are typically small.)
 */
export const DEFAULT_MAX_PATTERN_ARRAY_EXPAND = 200;

/**
 * Default max packed operations parsed from Gnosis `multiSend(bytes)` when `maxOperations` is omitted on the hint.
 * Lower than {@link DEFAULT_MAX_PATTERN_ARRAY_EXPAND}: gas limits usually keep Safe batches modest (often on the order of 10–20 ops).
 */
export const DEFAULT_MAX_MULTISEND_OPERATIONS = 20;

export type PatternRiskLevel = 'low' | 'medium' | 'high';

export interface MulticallPattern {
  selector: string;
  name: string;
  calldataIndices: CalldataIndex[];
  /**
   * Max nested calldata decode levels along pattern-driven `bytes` expansion for children of this call.
   * Capped by `DecodeOptions.multicallNestLimit` and `maxDepth`. Omit for global default only.
   */
  maxRecursionDepth?: number;
  /**
   * When false, nested calldata that resolves to another known multicall selector is left as raw `bytes`
   * (guards malicious / pathological multicall-of-multicall chains). Default true.
   */
  allowRecursive?: boolean;
  /**
   * True when decoding relies on non-standard ABI rules (e.g. Gnosis packed `multiSend`). UI may show a notice.
   */
  requiresSpecialHandling?: boolean;
  /** Security hint for UI: nested calldata can perform arbitrary calls (or delegatecalls). */
  riskLevel?: PatternRiskLevel;
  /** Short explanation shown in warning banners (pair with `riskLevel`). */
  description?: string;
}

/**
 * Describes where nested contract calldata lives inside **already ABI-decoded** top-level parameters.
 * Indices are **0-based** and refer to the function’s parameter list in declaration order.
 *
 * The decoder matches {@link MulticallPattern} by selector, then filters these hints to the current
 * `paramIndex` before walking values. Before recursing, `decoder.ts` checks that the resolved Solidity
 * type is actually `bytes` or `bytes[]` where required — mismatched user ABIs skip expansion.
 *
 * @example `tuple-field` — Multicall3 `aggregate3((address,bool,bytes)[])`
 * - `paramIndex: 0` → the whole dynamic array parameter `(address,bool,bytes)[]`.
 * - `fieldIndex: 2` → inside **each** tuple element, the third field (`bytes`) holds nested calldata.
 * ```ts
 * { kind: 'tuple-field', paramIndex: 0, fieldIndex: 2 }
 * ```
 *
 * @example `direct` — Gnosis `execTransaction(..., bytes data, ...)`
 * - `paramIndex: 2` → top-level argument `data` is dynamic `bytes` containing the inner call.
 *
 * @example `array-direct` — Uniswap-style `multicall(bytes[])`
 * - `paramIndex: 0` → each `bytes` element in the array is decoded as nested calldata.
 *
 * @example `gnosis-multisend` — Safe `multiSend(bytes)`
 * - `paramIndex: 0` → the single `bytes` argument is **packed** sub-transactions (not standard ABI tuple layout);
 *   see file header and `convertGnosisMultiSend` in `decoder.ts`.
 * - Optional `maxOperations` (default {@link DEFAULT_MAX_MULTISEND_OPERATIONS} in bundled pattern / decoder fallback)
 *   caps parsed segments before further nested decode work.
 */
export type CalldataIndex =
  | { kind: 'direct'; paramIndex: number }
  | { kind: 'array-direct'; paramIndex: number; maxArrayLength?: number }
  | {
      kind: 'tuple-field';
      paramIndex: number;
      fieldIndex: number;
      /** Max tuple rows expanded for this batch param (default {@link DEFAULT_MAX_PATTERN_ARRAY_EXPAND}). */
      maxArrayLength?: number;
      /**
       * When set, the hinted parameter’s Solidity type must match before expanding nested calldata:
       * `tuple[]` → dynamic array whose elements are tuples, e.g. `(address,bytes)[]`.
       * `tuple` → a single tuple parameter (no trailing `[]` on the top-level type).
       */
      expectedParentType?: 'tuple[]' | 'tuple';
      /** When set, the tuple field at `fieldIndex` must be dynamic `bytes` (avoids mis-ABI treating addresses as calldata). */
      expectedFieldType?: 'bytes';
    }
  | { kind: 'gnosis-multisend'; paramIndex: number; maxOperations?: number };

const isTestRuntime =
  typeof process !== 'undefined' && process.env.NODE_ENV === 'test';

/** Enso `executeShortcut` — `decoder.ts` uses this to unwrap length-prefixed `commands[]` payloads. */
export const ENSO_EXECUTE_SHORTCUT_SELECTOR = '0x95352c9f';

const PATTERNS: MulticallPattern[] = [
  // --- Uniswap-style multicall + Universal Router ---
  // multicall(bytes[]) - Uniswap style
  {
    selector: '0xac9650d8',
    name: 'multicall(bytes[])',
    calldataIndices: [{ kind: 'array-direct', paramIndex: 0 }],
    riskLevel: 'medium',
    description:
      'Each `bytes` element is arbitrary contract calldata executed in sequence by the target contract. Verify every inner call.',
  },
  // multicall(uint256,bytes[])
  {
    selector: '0x5ae401dc',
    name: 'multicall(uint256,bytes[])',
    calldataIndices: [{ kind: 'array-direct', paramIndex: 1 }],
    riskLevel: 'medium',
    description:
      'Each `bytes` element is arbitrary contract calldata executed in sequence. Verify every inner call before signing.',
  },
  // multicall(bytes32,bytes[])
  {
    selector: '0x1f0464d1',
    name: 'multicall(bytes32,bytes[])',
    calldataIndices: [{ kind: 'array-direct', paramIndex: 1 }],
    riskLevel: 'medium',
    description:
      'Each `bytes` element is arbitrary contract calldata executed in sequence. Verify every inner call before signing.',
  },
  // execute(bytes,bytes[],uint256) - Universal Router
  {
    selector: '0x3593564c',
    name: 'execute',
    calldataIndices: [{ kind: 'array-direct', paramIndex: 1 }],
    riskLevel: 'medium',
    description:
      'Universal Router command stream: `bytes[]` inputs drive nested swaps and calls. Treat as arbitrary execution relative to the router.',
  },
  // execute(bytes,bytes[])
  {
    selector: '0x24856bc3',
    name: 'execute',
    calldataIndices: [{ kind: 'array-direct', paramIndex: 1 }],
    riskLevel: 'medium',
    description:
      'Universal Router command stream: `bytes[]` inputs drive nested swaps and calls. Treat as arbitrary execution relative to the router.',
  },
  // swapCompact — selector is `swapCompact()` on 4byte; real txs often append a non-ABI packed blob (decoder path in `decoder.ts`).
  {
    selector: '0x83bd37f9',
    name: 'swapCompact',
    calldataIndices: [{ kind: 'direct', paramIndex: 0 }],
    requiresSpecialHandling: true,
    riskLevel: 'medium',
    description:
      'Signature DBs list zero-arg `swapCompact()`, but calldata may carry a packed strategy tail. The decoder exposes it as `bytes` for nested decode and padded-address scan.',
  },
  // --- Multicall2 / Multicall3 ---
  // aggregate((address,bytes)[]) — Multicall2 and Multicall3
  {
    selector: '0x252dba42',
    name: 'aggregate',
    calldataIndices: [
      {
        kind: 'tuple-field',
        paramIndex: 0,
        fieldIndex: 1,
        expectedParentType: 'tuple[]',
        expectedFieldType: 'bytes',
      },
    ],
    riskLevel: 'medium',
    description:
      'Batch `aggregate` (Multicall2 / Multicall3): each row is a target address plus arbitrary `bytes` calldata. Review every sub-call.',
  },
  // tryAggregate(bool,(address,bytes)[])
  {
    selector: '0xbce38bd7',
    name: 'tryAggregate',
    calldataIndices: [
      {
        kind: 'tuple-field',
        paramIndex: 1,
        fieldIndex: 1,
        expectedParentType: 'tuple[]',
        expectedFieldType: 'bytes',
      },
    ],
    riskLevel: 'medium',
    description:
      'Multicall2-style batch: each row carries target + arbitrary `bytes` calldata. Review every sub-call.',
  },
  // tryBlockAndAggregate(bool,(address,bytes)[])
  {
    selector: '0x399542e9',
    name: 'tryBlockAndAggregate',
    calldataIndices: [
      {
        kind: 'tuple-field',
        paramIndex: 1,
        fieldIndex: 1,
        expectedParentType: 'tuple[]',
        expectedFieldType: 'bytes',
      },
    ],
    riskLevel: 'medium',
    description:
      'Multicall2-style batch: each row carries target + arbitrary `bytes` calldata. Review every sub-call.',
  },
  // aggregate3((address,bool,bytes)[]) - Multicall3
  {
    selector: '0x82ad56cb',
    name: 'aggregate3',
    calldataIndices: [
      {
        kind: 'tuple-field',
        paramIndex: 0,
        fieldIndex: 2,
        expectedParentType: 'tuple[]',
        expectedFieldType: 'bytes',
      },
    ],
    riskLevel: 'medium',
    description:
      'Multicall3 batch: each row includes arbitrary `bytes` executed against a target. Verify targets and payloads.',
  },
  // aggregate3Value((address,bool,uint256,bytes)[])
  {
    selector: '0x174dea71',
    name: 'aggregate3Value',
    calldataIndices: [
      {
        kind: 'tuple-field',
        paramIndex: 0,
        fieldIndex: 3,
        expectedParentType: 'tuple[]',
        expectedFieldType: 'bytes',
      },
    ],
    riskLevel: 'medium',
    description:
      'Multicall3 batch with value: each row includes arbitrary `bytes` and may send ETH. Verify targets, values, and payloads.',
  },
  // --- Gnosis Safe ---
  // execTransaction(address,uint256,bytes,...) - Gnosis Safe
  {
    selector: '0x6a761202',
    name: 'execTransaction',
    calldataIndices: [{ kind: 'direct', paramIndex: 2 }],
    riskLevel: 'high',
    description:
      'Safe transaction execution: the `data` field is arbitrary calldata (CALL or DELEGATECALL per operation). Verify operation type, target, and payload.',
  },
  // execTransactionFromModule(address,uint256,bytes,uint8) - Gnosis Safe modules
  {
    selector: '0x468721a7',
    name: 'execTransactionFromModule',
    calldataIndices: [{ kind: 'direct', paramIndex: 2 }],
    riskLevel: 'high',
    description:
      'Module execution: arbitrary calldata from an enabled module. Confirm module trustworthiness and inner call intent.',
  },
  // multiSend(bytes) — Gnosis Safe packed encoding (NOT standard ABI for the inner payload; see file JSDoc).
  {
    selector: '0x8d80ff0a',
    name: 'multiSend',
    calldataIndices: [
      {
        kind: 'gnosis-multisend',
        paramIndex: 0,
        maxOperations: DEFAULT_MAX_MULTISEND_OPERATIONS,
      },
    ],
    requiresSpecialHandling: true,
    riskLevel: 'high',
    description:
      'Packed batch: segments can perform CALL or DELEGATECALL with arbitrary calldata. Verify each internal transaction carefully.',
  },
  // --- Meta-transactions (OZ ERC2771Forwarder / Defender) ---
  // execute((address,address,uint256,uint256,uint48,bytes,bytes)) - OZ ERC2771Forwarder / Defender meta-tx
  {
    selector: '0xdf905caf',
    name: 'execute((forwarder metatx request))',
    calldataIndices: [
      { kind: 'tuple-field', paramIndex: 0, fieldIndex: 5, expectedParentType: 'tuple', expectedFieldType: 'bytes' },
      { kind: 'tuple-field', paramIndex: 0, fieldIndex: 6, expectedParentType: 'tuple', expectedFieldType: 'bytes' },
    ],
    riskLevel: 'medium',
    description:
      'ERC-2771 forwarder executes arbitrary `bytes` on behalf of a user. Confirm the inner call matches your intent.',
  },
  // executeBatch((address,address,uint256,uint256,uint48,bytes,bytes)[],address)
  {
    selector: '0xccf96b4a',
    name: 'executeBatch',
    calldataIndices: [
      { kind: 'tuple-field', paramIndex: 0, fieldIndex: 5, expectedParentType: 'tuple[]', expectedFieldType: 'bytes' },
      { kind: 'tuple-field', paramIndex: 0, fieldIndex: 6, expectedParentType: 'tuple[]', expectedFieldType: 'bytes' },
    ],
    riskLevel: 'medium',
    description:
      'Forwarder batch: each request includes arbitrary `bytes` calldata. Review every forwarded call.',
  },
  // --- DEX / aggregation / settlement ---
  // swap(address,(address,address,address,address,uint256,uint256,uint256),bytes,bytes) - 1inch Aggregation Router
  {
    selector: '0x12aa3caf',
    name: 'swap',
    calldataIndices: [
      { kind: 'direct', paramIndex: 2 },
      { kind: 'direct', paramIndex: 3 },
    ],
    riskLevel: 'medium',
    description:
      'Aggregator swap: `data` and `callbackData` drive nested router logic. Treat as sensitive execution against the executor.',
  },
  // settle(...) - CoW Protocol GPv2Settlement (interactions use nested contract calldata)
  {
    selector: '0x13d79a0b',
    name: 'settle',
    calldataIndices: [
      {
        kind: 'tuple-field',
        paramIndex: 3,
        fieldIndex: 2,
        expectedParentType: 'tuple[]',
        expectedFieldType: 'bytes',
      },
    ],
    riskLevel: 'medium',
    description:
      'Settlement batch: solver-supplied interactions include arbitrary `callData` executed from the settlement contract.',
  },
  // --- Pendle RouterV4 / PendleSwap ---
  // swapTokensToTokens(address,(address,address,uint256,(uint8,address,bytes,bool))[],uint256[])
  {
    selector: '0xa373cf1a',
    name: 'swapTokensToTokens',
    calldataIndices: [
      {
        kind: 'tuple-field',
        paramIndex: 1,
        fieldIndex: 3,
        expectedParentType: 'tuple[]',
        expectedFieldType: 'bytes',
      },
    ],
    riskLevel: 'medium',
    description:
      'Batch swap payload: each row ends with a `(uint8,address,bytes,bool)` step (or an array of them) — the `bytes` slot holds nested router calls (e.g. Curve legs, approvals).',
  },
  // multicall((bool,bytes)[]) - Pendle RouterV4
  {
    selector: '0x60fc8466',
    name: 'multicall',
    calldataIndices: [
      {
        kind: 'tuple-field',
        paramIndex: 0,
        fieldIndex: 1,
        expectedParentType: 'tuple[]',
        expectedFieldType: 'bytes',
      },
    ],
    riskLevel: 'medium',
    description:
      'Router multicall: each `(bool,bytes)` row runs arbitrary calldata on the router. Inspect every inner call.',
  },
  // callAndReflect(address,bytes,bytes,bytes) - Pendle RouterV4
  {
    selector: '0x9fa02c86',
    name: 'callAndReflect',
    calldataIndices: [
      { kind: 'direct', paramIndex: 1 },
      { kind: 'direct', paramIndex: 2 },
      { kind: 'direct', paramIndex: 3 },
    ],
    riskLevel: 'medium',
    description:
      'Multiple `bytes` arguments are executed or reflected as nested calls on the router. Review each payload.',
  },
  // --- Contango ---
  // closeOrRemovePositionFlashLoanV2(...,bytes) - Contango
  {
    selector: '0xe8e9fc2a',
    name: 'closeOrRemovePositionFlashLoanV2',
    calldataIndices: [{ kind: 'direct', paramIndex: 5 }],
    riskLevel: 'medium',
    description:
      'Flash-loan style flow: trailing `bytes` often encodes nested protocol calls. Verify the full execution path.',
  },
  // --- Enso Router V2 ---
  // routeMulti((uint8,bytes)[],bytes) — `routeData` is standard ABI calldata (typically `executeShortcut`).
  {
    selector: '0xf52e33f5',
    name: 'routeMulti',
    calldataIndices: [{ kind: 'direct', paramIndex: 1 }],
    riskLevel: 'medium',
    description:
      'Enso batch: trailing `bytes` (`routeData`) is the composed shortcut runner payload—expand it to inspect each inner command.',
  },
  // executeShortcut(bytes32,bytes32,bytes32[],bytes[]) — `commands` holds nested contract calldata steps.
  {
    selector: ENSO_EXECUTE_SHORTCUT_SELECTOR,
    name: 'executeShortcut',
    calldataIndices: [{ kind: 'array-direct', paramIndex: 3 }],
    riskLevel: 'medium',
    description:
      'Enso shortcut runner: each `commands[]` element is arbitrary calldata executed in sequence. Verify approvals, swaps, and destinations.',
  },
];

const patternMap = new Map<string, MulticallPattern>();
for (const p of PATTERNS) {
  const sel = p.selector.trim();
  if (!isValidFunctionSelector(sel)) {
    throw new Error(`Invalid multicall pattern selector for "${p.name}": ${p.selector}`);
  }
  const key = sel.toLowerCase();
  const existing = patternMap.get(key);
  if (existing && !isTestRuntime) {
    console.warn(`Duplicate multicall pattern for ${key}: "${p.name}" overwrites "${existing.name}"`);
  }
  patternMap.set(key, { ...p, selector: key });
}

export function getKnownPattern(selector: string): MulticallPattern | undefined {
  return patternMap.get(selector.toLowerCase());
}

export function isKnownMulticallSelector(selector: string): boolean {
  return patternMap.has(selector.toLowerCase());
}
