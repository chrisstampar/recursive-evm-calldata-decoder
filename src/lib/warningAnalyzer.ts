import { getAddress } from 'ethers';
import type { DecodedCall, DecodedParam, DecodedValue, TxWarning, WarningSeverity } from '../types/index.ts';
import type { ContractRegistryEntry } from './abiRegistry.ts';
import {
  EIP1967_IMPLEMENTATION_SLOT,
  getContractName,
  getContractRegistryEntry,
  getTokenInfo,
} from './abiRegistry.ts';
import { DEFAULT_CHAIN_ID, describeDecodedChainIdForUi } from './chains.ts';
import {
  ENSO_EXECUTE_SHORTCUT_SELECTOR,
  getKnownPattern,
  isKnownMulticallSelector,
  type PatternRiskLevel,
} from './knownPatterns.ts';
import { extractLeftPaddedAddressFromBytes32 } from './valueFormatter.ts';

function checksumTxTo(addr: string): string {
  try {
    return getAddress(addr.trim());
  } catch {
    return addr.trim();
  }
}

/** What on the transaction triggered registry-based warnings (proxy, risk tier). */
function transactionTargetContext(txTo: string, chainId: number): string {
  const cs = checksumTxTo(txTo);
  const entry = getContractRegistryEntry(txTo, chainId);
  const label = entry?.name ?? getContractName(cs, chainId);
  return label
    ? `Trigger: transaction “To” = ${cs} (${label}).`
    : `Trigger: transaction “To” = ${cs}.`;
}

/** Which decoded call node a calldata heuristic refers to (top-level vs nested bytes). */
function warningCallFrameContext(call: DecodedCall): string {
  const sel = call.selector.toLowerCase();
  const fn = call.signature.name;
  const head = `${sel} · ${fn}()`;
  if (call.depth === 0) {
    return `Call frame: top level — ${head}. This is the root function of the pasted calldata or transaction input.`;
  }
  return `Call frame: nested at depth ${call.depth} — ${head}. Expand parent \`bytes\` or batch rows higher in the decode tree to find this inner call.`;
}

const UNLIMITED_APPROVAL = (1n << 256n) - 1n;

const APPROVAL_FUNCTIONS = new Set([
  'approve',
  'increaseAllowance',
]);

const APPROVAL_FOR_ALL_FUNCTIONS = new Set([
  'setApprovalForAll',
]);

const SUSPICIOUS_FUNCTION_NAMES = new Set([
  'SecurityUpdate',
  'securityUpdate',
  'ClaimReward',
  'claimReward',
  'ClaimAirdrop',
  'claimAirdrop',
  'ClaimTokens',
  'Multicall',
  'connectWallet',
  'enableTrading',
]);

const LARGE_ETH_THRESHOLD = 10n * 10n ** 18n; // 10 ETH in wei

/**
 * Rough spot anchors for {@link estimateUsdValue} only (large transfer/approval threshold ~$50k).
 * Not live prices — bump occasionally so the heuristic stays in the right order of magnitude.
 */
const HEURISTIC_ETH_USD_PER_UNIT = 2000;
const HEURISTIC_BTC_USD_PER_UNIT = 85_000;

export interface AnalyzeWarningsOptions {
  /** Transaction `to` when known (e.g. from RPC); drives proxy + registry risk-level warnings */
  txTo?: string | null;
  /** Chain for registry lookups (must match decode `chainId`) */
  chainId?: number;
}

export function analyzeWarnings(
  call: DecodedCall,
  msgValueWei?: string,
  options?: AnalyzeWarningsOptions,
): TxWarning[] {
  const warnings: TxWarning[] = [];
  const chainId = options?.chainId ?? DEFAULT_CHAIN_ID;

  const txTo = options?.txTo;
  if (txTo) {
    const entry = getContractRegistryEntry(txTo, chainId);
    const txCtx = transactionTargetContext(txTo, chainId);
    if (entry?.isProxy) {
      const slot = entry.implementationSlot ?? EIP1967_IMPLEMENTATION_SLOT;
      warnings.push({
        severity: 'info',
        title: 'Proxy contract target',
        context: `${txCtx} Why: this deployment is marked as a proxy in the in-app registry.`,
        message: `${entry.name} may point at upgradeable implementation code; bundled ABIs and labels can be stale. On explorers, implementation is often read from EIP-1967 slot ${slot.slice(0, 10)}….`,
      });
    }
    if (entry) {
      pushRegistryRiskWarning(warnings, entry, txCtx);
    }
  }

  if (msgValueWei) {
    try {
      const value = BigInt(msgValueWei);
      if (value >= LARGE_ETH_THRESHOLD) {
        const ethAmount = Number(value) / 1e18;
        warnings.push({
          severity: 'warning',
          title: 'Large native value',
          context:
            'Trigger: transaction msg.value (native ETH / POL / HYPE sent with the tx). Does not look at ERC-20 amounts inside calldata.',
          message: `About ${ethAmount.toFixed(4)} native tokens are attached to this transaction. Verify the contract and amount before signing.`,
        });
      }
    } catch { /* invalid value */ }
  }

  const seenPatternSelectors = new Set<string>();
  /** Same inner `bytes` selector often decodes ambiguously many times — warn once per (selector, function name). */
  const seenAmbiguousDecodes = new Set<string>();
  walkCall(call, warnings, chainId, seenPatternSelectors, seenAmbiguousDecodes);

  return warnings;
}

function patternRiskToSeverity(level: PatternRiskLevel): WarningSeverity {
  switch (level) {
    case 'high':
      return 'danger';
    case 'medium':
      return 'warning';
    case 'low':
      return 'info';
    default:
      return 'info';
  }
}

function checkKnownPatternRisk(call: DecodedCall, warnings: TxWarning[], seenSelectors: Set<string>) {
  const pattern = getKnownPattern(call.selector);
  if (!pattern?.riskLevel || !pattern.description) return;
  const key = call.selector.toLowerCase();
  if (seenSelectors.has(key)) return;
  seenSelectors.add(key);
  warnings.push({
    severity: patternRiskToSeverity(pattern.riskLevel),
    title: `Sensitive pattern: ${pattern.name}`,
    context: `${warningCallFrameContext(call)} Why: selector ${call.selector.toLowerCase()} is on our curated list (“${pattern.name}”).`,
    message: pattern.description,
  });
}

function pushRegistryRiskWarning(warnings: TxWarning[], entry: ContractRegistryEntry, txCtx: string) {
  const level = entry.riskLevel;
  if (!level) return;

  let severity: WarningSeverity;
  let title: string;
  let body: string;
  if (level === 'critical') {
    severity = 'danger';
    title = 'Critical-sensitivity contract';
    body =
      'The in-app registry marks this deployment as critical sensitivity (for example Aave-style pooled liquidity or Permit2-scale token allowances). Assume loss of funds is possible if calldata or approvals are wrong—verify every address, amount, and spender before signing.';
  } else if (level === 'high') {
    severity = 'warning';
    title = 'High-sensitivity contract';
    body =
      'The in-app registry treats this deployment as high sensitivity (for example aggregation routers, multisig execution, or other privileged surfaces). Review calldata, recipients, and any token approvals before signing.';
  } else if (level === 'medium') {
    severity = 'info';
    title = 'Moderate-sensitivity contract';
    body =
      'The in-app registry marks this contract as moderately sensitive. Confirm the interaction matches what you expect.';
  } else {
    severity = 'info';
    title = 'Labeled contract (low sensitivity hint)';
    body = 'Registry metadata indicates comparatively lower routine risk; still verify the transaction.';
  }

  let explorerNote = '';
  if (entry.verified === true) {
    explorerNote = ' Registry metadata: source verified on a block explorer.';
  } else if (entry.verified === false) {
    explorerNote = ' Registry metadata: not marked as verified—confirm on a block explorer.';
  }

  warnings.push({
    severity,
    title,
    context: `${txCtx} Why: that address has a sensitivity tier in this app's registry.`,
    message: `${entry.name}. ${body}${explorerNote}`,
  });
}

function walkCall(
  call: DecodedCall,
  warnings: TxWarning[],
  chainId: number,
  seenPatternSelectors: Set<string>,
  seenAmbiguousDecodes: Set<string>,
) {
  checkKnownPatternRisk(call, warnings, seenPatternSelectors);
  checkCallForWarnings(call, warnings, chainId, seenAmbiguousDecodes);

  for (const param of call.params) {
    walkValue(param.value, warnings, chainId, seenPatternSelectors, seenAmbiguousDecodes);
  }
}

function walkValue(
  value: DecodedValue,
  warnings: TxWarning[],
  chainId: number,
  seenPatternSelectors: Set<string>,
  seenAmbiguousDecodes: Set<string>,
) {
  if (value.kind === 'bytes' && value.decoded) {
    walkCall(value.decoded, warnings, chainId, seenPatternSelectors, seenAmbiguousDecodes);
  } else if (value.kind === 'array') {
    for (const el of value.elements) {
      walkValue(el, warnings, chainId, seenPatternSelectors, seenAmbiguousDecodes);
    }
  } else if (value.kind === 'tuple') {
    for (const field of value.fields) {
      walkValue(field.value, warnings, chainId, seenPatternSelectors, seenAmbiguousDecodes);
    }
  }
}

/** LayerZero V2 OFT `send(SendParam feeTuple refund)` — cross-chain token transfer. */
const LAYERZERO_OFT_SEND_SELECTOR = '0xc7c7f5b3';
/** Across SpokePool V2 `deposit(bytes32,…)` — bridge intent with bytes32-wrapped addresses. */
const ACROSS_SPOKE_DEPOSIT_SELECTOR = '0xad5425c6';
/** Enso Router V2 `routeMulti((uint8,bytes)[],bytes)` — batch inputs + strategy bytes (swaps, Stargate, LayerZero, …). */
const ENSO_ROUTE_MULTI_SELECTOR = '0xf52e33f5';
function checkCallForWarnings(
  call: DecodedCall,
  warnings: TxWarning[],
  chainId: number,
  seenAmbiguousDecodes: Set<string>,
) {
  const fnName = call.signature.name;
  const frame = warningCallFrameContext(call);

  if (call.selector.toLowerCase() === LAYERZERO_OFT_SEND_SELECTOR && fnName === 'send') {
    warnings.push({
      severity: 'info',
      title: 'LayerZero OFT bridge',
      context: `${frame} Why: selector ${LAYERZERO_OFT_SEND_SELECTOR} + function name \`send\` match LayerZero V2 OFT.`,
      message:
        'Token amounts in the first tuple are usually `amountLD` / `minAmountLD` for the OFT at transaction `to`. Destination chain is identified by `dstEid` (first `uint32` in that tuple). Confirm endpoint and peer on a block explorer.',
    });
  }

  if (call.depth === 0 && call.selector.toLowerCase() === ENSO_ROUTE_MULTI_SELECTOR && fnName === 'routeMulti') {
    warnings.push({
      severity: 'info',
      title: 'Enso routeMulti',
      context: `${frame} Why: root call uses Enso \`routeMulti\` (${ENSO_ROUTE_MULTI_SELECTOR}) — common for batched swaps and bridge payloads (e.g. Stargate / LayerZero).`,
      message:
        '`(uint8,bytes)[]` configures token pulls; trailing `routeData` usually decodes as `executeShortcut`, whose `commands[]` entries are the real swap / wrap / approval steps. **Transaction `msg.value` (native ETH) is separate** from WETH or ERC-20 amounts inside those inner calls—do not confuse a small `msg.value` with the full economic size of the route.',
    });
  }

  if (call.selector.toLowerCase() === ENSO_EXECUTE_SHORTCUT_SELECTOR && fnName === 'executeShortcut') {
    warnings.push({
      severity: 'info',
      title: 'Enso executeShortcut',
      context: `${frame} Why: selector ${ENSO_EXECUTE_SHORTCUT_SELECTOR} + \`executeShortcut\` — Enso shortcut runner (nested under \`routeData\`).`,
      message:
        'Expand each `commands[]` element in the tree: they hold the sequence of inner contract calls (e.g. approvals, swaps, WETH deposit/withdraw). Large token movements usually appear there, not in top-level `msg.value`.',
    });
  }

  if (call.selector.toLowerCase() === ACROSS_SPOKE_DEPOSIT_SELECTOR && fnName === 'deposit') {
    const inputTokenP = call.params.find(p => p.name === 'inputToken');
    const destP = call.params.find(p => p.name === 'destinationChainId');
    let tokenHint = '';
    if (inputTokenP?.value.kind === 'primitive' && typeof inputTokenP.value.raw === 'string') {
      const addr = extractLeftPaddedAddressFromBytes32(inputTokenP.value.raw);
      if (addr) {
        const info = getTokenInfo(addr, chainId);
        const nm = info?.symbol ?? getContractName(addr, chainId);
        if (nm) tokenHint = ` Origin-chain token (input): ${nm}.`;
      }
    }
    let destHint = '';
    if (destP?.value.kind === 'primitive' && destP.type.replace(/\s/g, '').toLowerCase().startsWith('uint')) {
      const dest = describeDecodedChainIdForUi(destP.value.raw);
      if (dest) {
        destHint = dest.friendlyName
          ? ` Decoded \`destinationChainId\`: ${dest.decimalLabel} (app registry name: ${dest.friendlyName}; not verified on-chain).`
          : ` Decoded \`destinationChainId\`: ${dest.decimalLabel}.`;
      }
    }
    warnings.push({
      severity: 'info',
      title: 'Across Protocol bridge',
      context: `${frame} Why: selector ${ACROSS_SPOKE_DEPOSIT_SELECTOR} + \`deposit\` match Across SpokePool V2 shape.`,
      message: `Locking or sending tokens on the origin chain for a fill on another chain.${tokenHint}${destHint} Confirm \`recipient\`, amounts, and deadlines before signing.`,
    });
  }

  // Unlimited ERC-20 approval
  if (APPROVAL_FUNCTIONS.has(fnName)) {
    const amountParam = findParamByNameOrType(call.params, 'amount', 'uint256');
    if (amountParam && isUnlimitedAmount(amountParam.value)) {
      const spenderParam = findParamByNameOrType(call.params, 'spender', 'address');
      const spenderLabel = getAddressLabel(spenderParam);
      const spenderDesc = spenderLabel
        ? `to ${spenderLabel}`
        : spenderParam
          ? `to an ${getContractName(extractAddress(spenderParam.value) ?? '', chainId) ? 'identified' : 'unrecognized'} address`
          : '';
      warnings.push({
        severity: 'danger',
        title: 'Unlimited token approval',
        context: `${frame} Why: \`${fnName}\` with \`amount\` = max uint256 (unlimited allowance).`,
        message: `Unlimited spending approval ${spenderDesc}. A compromised or malicious spender can drain all tokens of this type from your wallet.`,
      });
    }

    // Large token approval (non-unlimited)
    if (amountParam && !isUnlimitedAmount(amountParam.value)) {
      checkLargeTokenAmount(amountParam, call, warnings, 'approval');
    }
  }

  // setApprovalForAll — ERC-721 and ERC-1155 both use this function on the collection contract
  if (APPROVAL_FOR_ALL_FUNCTIONS.has(fnName)) {
    const approvedParam = findParamByNameOrType(call.params, 'approved', 'bool');
    if (approvedParam && approvedParam.value.kind === 'primitive' && approvedParam.value.display === 'true') {
      warnings.push({
        severity: 'danger',
        title: 'NFT approval for all',
        context: `${frame} Why: \`setApprovalForAll\` with \`approved\` = true.`,
        message:
          'The operator can move every token ID in this collection (ERC-721 or ERC-1155) while approval holds.',
      });
    }
  }

  // Suspicious function names
  if (SUSPICIOUS_FUNCTION_NAMES.has(fnName)) {
    const skipMulticallNoise = /^multicall$/i.test(fnName) && isKnownMulticallSelector(call.selector);
    if (!skipMulticallNoise) {
      warnings.push({
        severity: 'danger',
        title: 'Suspicious function name',
        context: `${frame} Why: function name "${fnName}" matches a phishing heuristic list (name alone is not proof of malice).`,
        message: 'Verify the contract on a block explorer and that you intended this interaction.',
      });
    }
  }

  // transferFrom where 'from' might not be the caller
  if (fnName === 'transferFrom' || fnName === 'safeTransferFrom') {
    checkLargeTransfer(call, warnings);
  }

  // Regular transfer with large amounts
  if (fnName === 'transfer') {
    checkLargeTransfer(call, warnings);
  }

  // Calls to unrecognized contracts with value
  if (call.confidence === 'ambiguous') {
    const ambKey = `${call.selector.toLowerCase()}:${fnName}`;
    if (!seenAmbiguousDecodes.has(ambKey)) {
      seenAmbiguousDecodes.add(ambKey);
      warnings.push({
        severity: 'info',
        title: 'Ambiguous decode',
        context: `${frame} Why: several ABI candidates from public databases all decode this payload; confidence is low. (One banner per selector+name even if this pattern appears in multiple nested frames.)`,
        message: `The UI chose "${fnName}" but argument types/names may be wrong. Paste a verified contract ABI when decoding unknown contracts.`,
      });
    }
  }
}

function checkLargeTransfer(call: DecodedCall, warnings: TxWarning[]) {
  const amountParam = findParamByNameOrType(call.params, 'amount', 'uint256')
    ?? findParamByNameOrType(call.params, 'value', 'uint256');
  if (!amountParam) return;

  checkLargeTokenAmount(amountParam, call, warnings, 'transfer');
}

function checkLargeTokenAmount(
  amountParam: DecodedParam,
  call: DecodedCall,
  warnings: TxWarning[],
  action: 'transfer' | 'approval',
) {
  if (amountParam.value.kind !== 'primitive') return;

  try {
    const raw = amountParam.value.raw;
    const value = BigInt(raw);
    if (value === 0n) return;

    // Check if interpretation mentions a known token with a large amount
    const interp = amountParam.value.interpretation;
    if (interp) {
      const match = interp.match(/^([\d,.]+)\s+(\w+)$/);
      if (match) {
        const amount = parseFloat(match[1].replace(/,/g, ''));
        const symbol = match[2];
        const tokenInfo = getTokenInfoBySymbol(symbol);

        if (tokenInfo && amount > 0) {
          const usdEstimate = estimateUsdValue(amount, symbol);
          if (usdEstimate !== null && usdEstimate > 50_000) {
            const label = action === 'transfer' ? 'Large token transfer' : 'Large token approval';
            warnings.push({
              severity: 'warning',
              title: label,
              context: `${warningCallFrameContext(call)} Why: \`${amountParam.name}\` / amount field decodes to ~${amount.toLocaleString()} ${symbol} (rough USD estimate for the warning threshold only).`,
              message: `Estimated ~$${Math.round(usdEstimate).toLocaleString()} notional. Double-check recipient and amount before signing.`,
            });
          }
        }
      }
    }
  } catch { /* not a number */ }
}

/**
 * Prefer ABI param `name`, else first param with exact Solidity `type` (e.g. `uint256`).
 * Type fallback can misfire if names are non-standard (`value` vs `amount`) — acceptable for heuristics only.
 */
function findParamByNameOrType(params: DecodedParam[], name: string, type: string): DecodedParam | undefined {
  return params.find(p => p.name.toLowerCase() === name.toLowerCase())
    ?? params.find(p => p.type === type);
}

function isUnlimitedAmount(value: DecodedValue): boolean {
  if (value.kind !== 'primitive') return false;
  try {
    return BigInt(value.raw) === UNLIMITED_APPROVAL;
  } catch {
    return false;
  }
}

function extractAddress(value: DecodedValue): string | undefined {
  if (value.kind === 'address') return value.address;
  return undefined;
}

function getAddressLabel(param: DecodedParam | undefined): string | undefined {
  if (!param) return undefined;
  if (param.value.kind === 'address') return param.value.label;
  return undefined;
}

function getTokenInfoBySymbol(symbol: string): { decimals: number } | null {
  const stablecoins = new Set(['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'crvUSD', 'PYUSD', 'USDS', 'GHO', 'fxUSD', 'USDe', 'sUSDe', 'sDAI', 'RLUSD', 'EURC']);
  const ethLike = new Set(['WETH', 'ETH', 'stETH', 'wstETH', 'weETH', 'rETH', 'cbETH', 'osETH', 'ETHx', 'rsETH', 'ezETH', 'tETH']);
  const btcLike = new Set(['WBTC', 'cbBTC', 'LBTC', 'tBTC', 'eBTC', 'FBTC']);

  if (stablecoins.has(symbol)) return { decimals: symbol === 'USDC' || symbol === 'USDT' || symbol === 'PYUSD' || symbol === 'EURC' ? 6 : 18 };
  if (ethLike.has(symbol)) return { decimals: 18 };
  if (btcLike.has(symbol)) return { decimals: 8 };
  return null;
}

/** Rough USD for {@link checkLargeTokenAmount} threshold only — uses {@link HEURISTIC_ETH_USD_PER_UNIT} / {@link HEURISTIC_BTC_USD_PER_UNIT}. */
function estimateUsdValue(amount: number, symbol: string): number | null {
  const stablecoins = new Set(['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'crvUSD', 'PYUSD', 'USDS', 'GHO', 'fxUSD', 'USDe', 'sUSDe', 'sDAI', 'RLUSD']);
  const ethLike = new Set(['WETH', 'ETH', 'stETH', 'wstETH', 'weETH', 'rETH', 'cbETH', 'osETH', 'rsETH', 'ezETH']);
  const btcLike = new Set(['WBTC', 'cbBTC', 'LBTC', 'tBTC', 'eBTC', 'FBTC']);

  if (stablecoins.has(symbol)) return amount;
  if (ethLike.has(symbol)) return amount * HEURISTIC_ETH_USD_PER_UNIT;
  if (btcLike.has(symbol)) return amount * HEURISTIC_BTC_USD_PER_UNIT;
  return null;
}
