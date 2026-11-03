import type { SignatureParam } from '../types/index.ts';

/**
 * Uniswap Universal Router `execute(bytes commands, bytes[] inputs[, uint256 deadline])`.
 *
 * `inputs[i]` is NOT contract calldata: it is the ABI-encoded argument list for command `commands[i]` (no
 * selector). Decoding it as calldata produced junk nested calls on every UR transaction (found in a real-transaction
 * run, Nov 2026). Each command byte is `flags (bit 7 = allow revert) | command id (bits 0–5)`.
 *
 * Newer routers append a per-hop slippage array (`uint256[]`) to the v2/v3 swap commands; both layouts are listed.
 *
 * Command ids 0x00–0x0e are the same across router versions. 0x10+ changed meaning (v1.x: NFT marketplaces;
 * v2: Uniswap v4), so the decoder only accepts a table entry when the input re-encodes exactly to the same bytes
 * under its types; anything else stays raw bytes with a note.
 *
 * @see https://github.com/Uniswap/universal-router/blob/main/contracts/libraries/Commands.sol
 * @see https://github.com/Uniswap/v4-periphery/blob/main/src/libraries/Actions.sol
 */

export type RouterStepSpec =
  /** Input is `abi.encode(params…)`; `variants` are tried in order, first exact canonical fit wins. */
  | { kind: 'args'; name: string; variants: SignatureParam[][]; tokenFlow?: TokenFlow }
  /** Input is plain contract calldata (selector + args), e.g. position-manager calls. */
  | { kind: 'calldata'; name: string }
  /** Input is `abi.encode(bytes commands, bytes[] inputs)` for a nested plan. */
  | { kind: 'sub-plan'; name: string }
  /** Input is `abi.encode(bytes actions, bytes[] params)` for the Uniswap v4 router. */
  | { kind: 'v4-swap'; name: string };

/** Where the input / output token of a swap step lives, so amounts get the right units. */
export type TokenFlow =
  | { kind: 'v3-path'; exactOut: boolean }
  | { kind: 'v2-path'; exactOut: boolean }
  | { kind: 'v4-single'; exactOut: boolean }
  | { kind: 'v4-path'; exactOut: boolean };

const p = (name: string, type: string, components?: SignatureParam[]): SignatureParam =>
  components ? { name, type, components } : { name, type };

const PERMIT_DETAILS = [p('token', 'address'), p('amount', 'uint160'), p('expiration', 'uint48'), p('nonce', 'uint48')];
const POOL_KEY = [p('currency0', 'address'), p('currency1', 'address'), p('fee', 'uint24'), p('tickSpacing', 'int24'), p('hooks', 'address')];
const PATH_KEY = [p('intermediateCurrency', 'address'), p('fee', 'uint24'), p('tickSpacing', 'int24'), p('hooks', 'address'), p('hookData', 'bytes')];
const POOL_KEY_T = '(address,address,uint24,int24,address)';
const PATH_KEY_T = '(address,uint24,int24,address,bytes)';

export const UNIVERSAL_ROUTER_COMMANDS: Readonly<Record<number, RouterStepSpec>> = {
  0x00: {
    kind: 'args',
    name: 'V3_SWAP_EXACT_IN',
    variants: [[p('recipient', 'address'), p('amountIn', 'uint256'), p('amountOutMin', 'uint256'), p('path', 'bytes'), p('payerIsUser', 'bool')], [p('recipient', 'address'), p('amountIn', 'uint256'), p('amountOutMin', 'uint256'), p('path', 'bytes'), p('payerIsUser', 'bool'), p('hopLimits', 'uint256[]')]],
    tokenFlow: { kind: 'v3-path', exactOut: false },
  },
  0x01: {
    kind: 'args',
    name: 'V3_SWAP_EXACT_OUT',
    variants: [[p('recipient', 'address'), p('amountOut', 'uint256'), p('amountInMax', 'uint256'), p('path', 'bytes'), p('payerIsUser', 'bool')], [p('recipient', 'address'), p('amountOut', 'uint256'), p('amountInMax', 'uint256'), p('path', 'bytes'), p('payerIsUser', 'bool'), p('hopLimits', 'uint256[]')]],
    tokenFlow: { kind: 'v3-path', exactOut: true },
  },
  0x02: { kind: 'args', name: 'PERMIT2_TRANSFER_FROM', variants: [[p('token', 'address'), p('recipient', 'address'), p('amount', 'uint160')]] },
  0x03: {
    kind: 'args',
    name: 'PERMIT2_PERMIT_BATCH',
    variants: [[
      p('permitBatch', '((address,uint160,uint48,uint48)[],address,uint256)', [
        p('details', '(address,uint160,uint48,uint48)[]', PERMIT_DETAILS),
        p('spender', 'address'),
        p('sigDeadline', 'uint256'),
      ]),
      p('signature', 'bytes'),
    ]],
  },
  0x04: { kind: 'args', name: 'SWEEP', variants: [[p('token', 'address'), p('recipient', 'address'), p('amountMin', 'uint256')]] },
  0x05: { kind: 'args', name: 'TRANSFER', variants: [[p('token', 'address'), p('recipient', 'address'), p('value', 'uint256')]] },
  0x06: { kind: 'args', name: 'PAY_PORTION', variants: [[p('token', 'address'), p('recipient', 'address'), p('bips', 'uint256')]] },
  0x08: {
    kind: 'args',
    name: 'V2_SWAP_EXACT_IN',
    variants: [[p('recipient', 'address'), p('amountIn', 'uint256'), p('amountOutMin', 'uint256'), p('path', 'address[]'), p('payerIsUser', 'bool')], [p('recipient', 'address'), p('amountIn', 'uint256'), p('amountOutMin', 'uint256'), p('path', 'address[]'), p('payerIsUser', 'bool'), p('hopLimits', 'uint256[]')]],
    tokenFlow: { kind: 'v2-path', exactOut: false },
  },
  0x09: {
    kind: 'args',
    name: 'V2_SWAP_EXACT_OUT',
    variants: [[p('recipient', 'address'), p('amountOut', 'uint256'), p('amountInMax', 'uint256'), p('path', 'address[]'), p('payerIsUser', 'bool')], [p('recipient', 'address'), p('amountOut', 'uint256'), p('amountInMax', 'uint256'), p('path', 'address[]'), p('payerIsUser', 'bool'), p('hopLimits', 'uint256[]')]],
    tokenFlow: { kind: 'v2-path', exactOut: true },
  },
  0x0a: {
    kind: 'args',
    name: 'PERMIT2_PERMIT',
    variants: [[
      p('permitSingle', '((address,uint160,uint48,uint48),address,uint256)', [
        p('details', '(address,uint160,uint48,uint48)', PERMIT_DETAILS),
        p('spender', 'address'),
        p('sigDeadline', 'uint256'),
      ]),
      p('signature', 'bytes'),
    ]],
  },
  0x0b: { kind: 'args', name: 'WRAP_ETH', variants: [[p('recipient', 'address'), p('amountMin', 'uint256')]] },
  0x0c: { kind: 'args', name: 'UNWRAP_WETH', variants: [[p('recipient', 'address'), p('amountMin', 'uint256')]] },
  0x0d: {
    kind: 'args',
    name: 'PERMIT2_TRANSFER_FROM_BATCH',
    variants: [[
      p('batchDetails', '(address,address,uint160,address)[]', [p('from', 'address'), p('to', 'address'), p('amount', 'uint160'), p('token', 'address')]),
    ]],
  },
  0x0e: { kind: 'args', name: 'BALANCE_CHECK_ERC20', variants: [[p('owner', 'address'), p('token', 'address'), p('minBalance', 'uint256')]] },
  // Universal Router v2 (Uniswap v4 era). v1.x used these ids for NFT marketplaces; exact-fit decoding keeps a
  // v1 input from being misread as one of these.
  0x10: { kind: 'v4-swap', name: 'V4_SWAP' },
  0x11: { kind: 'calldata', name: 'V3_POSITION_MANAGER_PERMIT' },
  0x12: { kind: 'calldata', name: 'V3_POSITION_MANAGER_CALL' },
  0x13: {
    kind: 'args',
    name: 'V4_INITIALIZE_POOL',
    variants: [[p('poolKey', POOL_KEY_T, POOL_KEY), p('sqrtPriceX96', 'uint160')]],
  },
  0x14: { kind: 'calldata', name: 'V4_POSITION_MANAGER_CALL' },
  0x21: { kind: 'sub-plan', name: 'EXECUTE_SUB_PLAN' },
};

/** Uniswap v4 `V4Router` actions used by `V4_SWAP` (liquidity-management actions are left raw). */
export const V4_ROUTER_ACTIONS: Readonly<Record<number, RouterStepSpec>> = {
  0x06: {
    kind: 'args',
    name: 'SWAP_EXACT_IN_SINGLE',
    variants: [[
      p('params', `(${POOL_KEY_T},bool,uint128,uint128,bytes)`, [
        p('poolKey', POOL_KEY_T, POOL_KEY), p('zeroForOne', 'bool'), p('amountIn', 'uint128'), p('amountOutMinimum', 'uint128'), p('hookData', 'bytes'),
      ]),
    ], [
      // v4-periphery after the per-hop slippage change: adds `minHopPriceX36`
      p('params', `(${POOL_KEY_T},bool,uint128,uint128,uint256,bytes)`, [
        p('poolKey', POOL_KEY_T, POOL_KEY), p('zeroForOne', 'bool'), p('amountIn', 'uint128'), p('amountOutMinimum', 'uint128'), p('minHopPriceX36', 'uint256'), p('hookData', 'bytes'),
      ]),
    ]],
    tokenFlow: { kind: 'v4-single', exactOut: false },
  },
  0x07: {
    kind: 'args',
    name: 'SWAP_EXACT_IN',
    variants: [[
      p('params', `(address,${PATH_KEY_T}[],uint128,uint128)`, [
        p('currencyIn', 'address'), p('path', `${PATH_KEY_T}[]`, PATH_KEY), p('amountIn', 'uint128'), p('amountOutMinimum', 'uint128'),
      ]),
    ], [
      p('params', `(address,${PATH_KEY_T}[],uint256[],uint128,uint128)`, [
        p('currencyIn', 'address'), p('path', `${PATH_KEY_T}[]`, PATH_KEY), p('minHopPriceX36', 'uint256[]'), p('amountIn', 'uint128'), p('amountOutMinimum', 'uint128'),
      ]),
    ]],
    tokenFlow: { kind: 'v4-path', exactOut: false },
  },
  0x08: {
    kind: 'args',
    name: 'SWAP_EXACT_OUT_SINGLE',
    variants: [[
      p('params', `(${POOL_KEY_T},bool,uint128,uint128,bytes)`, [
        p('poolKey', POOL_KEY_T, POOL_KEY), p('zeroForOne', 'bool'), p('amountOut', 'uint128'), p('amountInMaximum', 'uint128'), p('hookData', 'bytes'),
      ]),
    ], [
      p('params', `(${POOL_KEY_T},bool,uint128,uint128,uint256,bytes)`, [
        p('poolKey', POOL_KEY_T, POOL_KEY), p('zeroForOne', 'bool'), p('amountOut', 'uint128'), p('amountInMaximum', 'uint128'), p('minHopPriceX36', 'uint256'), p('hookData', 'bytes'),
      ]),
    ]],
    tokenFlow: { kind: 'v4-single', exactOut: true },
  },
  0x09: {
    kind: 'args',
    name: 'SWAP_EXACT_OUT',
    variants: [[
      p('params', `(address,${PATH_KEY_T}[],uint128,uint128)`, [
        p('currencyOut', 'address'), p('path', `${PATH_KEY_T}[]`, PATH_KEY), p('amountOut', 'uint128'), p('amountInMaximum', 'uint128'),
      ]),
    ], [
      p('params', `(address,${PATH_KEY_T}[],uint256[],uint128,uint128)`, [
        p('currencyOut', 'address'), p('path', `${PATH_KEY_T}[]`, PATH_KEY), p('minHopPriceX36', 'uint256[]'), p('amountOut', 'uint128'), p('amountInMaximum', 'uint128'),
      ]),
    ]],
    tokenFlow: { kind: 'v4-path', exactOut: true },
  },
  0x0b: { kind: 'args', name: 'SETTLE', variants: [[p('currency', 'address'), p('amount', 'uint256'), p('payerIsUser', 'bool')]] },
  0x0c: { kind: 'args', name: 'SETTLE_ALL', variants: [[p('currency', 'address'), p('maxAmount', 'uint256')]] },
  0x0d: { kind: 'args', name: 'SETTLE_PAIR', variants: [[p('currency0', 'address'), p('currency1', 'address')]] },
  0x0e: { kind: 'args', name: 'TAKE', variants: [[p('currency', 'address'), p('recipient', 'address'), p('amount', 'uint256')]] },
  0x0f: { kind: 'args', name: 'TAKE_ALL', variants: [[p('currency', 'address'), p('minAmount', 'uint256')]] },
  0x10: { kind: 'args', name: 'TAKE_PORTION', variants: [[p('currency', 'address'), p('recipient', 'address'), p('bips', 'uint256')]] },
  0x11: { kind: 'args', name: 'TAKE_PAIR', variants: [[p('currency0', 'address'), p('currency1', 'address'), p('recipient', 'address')]] },
  0x12: { kind: 'args', name: 'CLOSE_CURRENCY', variants: [[p('currency', 'address')]] },
  0x13: { kind: 'args', name: 'CLEAR_OR_TAKE', variants: [[p('currency', 'address'), p('amountMax', 'uint256')]] },
  0x14: { kind: 'args', name: 'SWEEP', variants: [[p('currency', 'address'), p('to', 'address')]] },
  0x15: { kind: 'args', name: 'WRAP', variants: [[p('amount', 'uint256')]] },
  0x16: { kind: 'args', name: 'UNWRAP', variants: [[p('amount', 'uint256')]] },
};

/** Universal Router `execute` selectors (with and without deadline). */
export const UNIVERSAL_ROUTER_EXECUTE_SELECTORS = new Set(['0x3593564c', '0x24856bc3']);

/** Recipient sentinels in Universal Router / v4 periphery (`ActionConstants`). */
export const ROUTER_ADDRESS_SENTINELS: Readonly<Record<string, string>> = {
  '0x0000000000000000000000000000000000000001': 'MSG_SENDER: the account that called the router',
  '0x0000000000000000000000000000000000000002': 'ADDRESS_THIS: the router itself',
};

/** `ActionConstants.CONTRACT_BALANCE`: "use the router's whole balance of this token". */
export const ROUTER_CONTRACT_BALANCE = 1n << 255n;
