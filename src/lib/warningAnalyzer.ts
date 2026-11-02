import { formatUnits, getAddress } from 'ethers';
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
const UINT160_MAX = (1n << 160n) - 1n;

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

  checkApprovals(call, warnings, chainId, frame);
  checkSafeOperations(call, warnings, chainId, frame);

  // Offset scans inside packed payloads always run to the end of the buffer, so a tail there is expected.
  if (call.unparsedTrailingHex && !call.speculative) {
    const n = (call.unparsedTrailingHex.length - 2) / 2;
    warnings.push({
      severity: 'warning',
      title: 'Unparsed trailing calldata',
      context: `${frame} Why: ${n} byte(s) follow the ABI-encoded arguments of \`${fnName}\`.`,
      message: `These bytes are not shown as parameters, but the contract can still read them from msg.data.${n === 20 ? ' 20 bytes is the ERC-2771 pattern (a forwarder appending the original sender) — check the trusted forwarder.' : ' Legitimate contracts rarely need this; a malicious one can hide instructions there.'}`,
    });
  }
  if (call.nonCanonicalEncoding && !call.speculative) {
    warnings.push({
      severity: 'warning',
      title: 'Non-standard ABI encoding',
      context: `${frame} Why: the decoded arguments of \`${fnName}\` do not re-encode to the same bytes.`,
      message:
        'Some values may be shown differently from how the contract reads them (for example an out-of-range uint8 or bool shown masked). Standard tooling never produces this encoding.',
    });
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

  const transferAmount = findTransferAmountParam(call);
  if (transferAmount) {
    checkLargeTokenAmount(transferAmount, call, warnings, 'transfer');
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

/**
 * Standard approval selectors → parameter positions. Keyed by selector, not by name: names from public signature
 * databases are attacker-influenced, and Permit2 / EIP-2612 / DAI permits do not all call it `amount`.
 */
const APPROVAL_SPECS: Readonly<Record<string, { amount: number; spender: number; label: string }>> = {
  '0x095ea7b3': { amount: 1, spender: 0, label: 'approve' },
  '0x39509351': { amount: 1, spender: 0, label: 'increaseAllowance' },
  '0xd505accf': { amount: 2, spender: 1, label: 'permit (EIP-2612)' },
  '0x87517c45': { amount: 2, spender: 1, label: 'Permit2 approve' },
};
/** DAI-style `permit(holder, spender, nonce, expiry, bool allowed, v, r, s)` — `allowed = true` is unlimited. */
const DAI_PERMIT_SELECTOR = '0x8fcbaf0c';
/** Permit2 `permit(owner, PermitSingle, sig)` / `permit(owner, PermitBatch, sig)`. */
const PERMIT2_PERMIT_SINGLE_SELECTOR = '0x2b67b570';
const PERMIT2_PERMIT_BATCH_SELECTOR = '0x2a2d80d1';

/** Transfer selectors → amount parameter index (ERC-20 `transferFrom` shares its selector with ERC-721). */
const TRANSFER_AMOUNT_INDEX: Readonly<Record<string, number>> = {
  '0xa9059cbb': 1,
  '0x23b872dd': 2,
};

function unlimitedApprovalWarning(
  frame: string,
  label: string,
  why: string,
  spenderDesc: string,
): TxWarning {
  return {
    severity: 'danger',
    title: 'Unlimited token approval',
    context: `${frame} Why: ${why}`,
    message: `Unlimited spending approval via ${label}${spenderDesc ? ` ${spenderDesc}` : ''}. A compromised or malicious spender can drain all tokens of this type from the owner's wallet.`,
  };
}

function describeSpender(param: DecodedParam | undefined, chainId: number): string {
  if (!param) return '';
  const label = getAddressLabel(param);
  if (label) return `to ${label}`;
  const addr = extractAddress(param.value);
  if (!addr) return '';
  return getContractName(addr, chainId) ? `to an identified address (${addr})` : `to an unrecognized address (${addr})`;
}

function checkApprovals(call: DecodedCall, warnings: TxWarning[], chainId: number, frame: string): void {
  const sel = call.selector.toLowerCase();
  const fnName = call.signature.name;

  if (sel === DAI_PERMIT_SELECTOR) {
    const allowed = call.params[4];
    if (allowed?.value.kind === 'primitive' && allowed.value.display === 'true') {
      warnings.push(
        unlimitedApprovalWarning(frame, 'DAI-style permit', '`permit` with `allowed = true` grants an unlimited allowance.', describeSpender(call.params[1], chainId)),
      );
    }
    return;
  }

  if (sel === PERMIT2_PERMIT_SINGLE_SELECTOR || sel === PERMIT2_PERMIT_BATCH_SELECTOR) {
    const permit = call.params[1]?.value;
    if (permit?.kind !== 'tuple') return;
    const [detailsField, spenderField] = permit.fields;
    const details =
      detailsField?.value.kind === 'tuple'
        ? [detailsField.value]
        : detailsField?.value.kind === 'array'
          ? detailsField.value.elements
          : [];
    const unlimited = details.some(d => d.kind === 'tuple' && d.fields[1] && isUnlimitedAmount(d.fields[1].value, d.fields[1].type));
    const spenderDesc = describeSpender(spenderField, chainId);
    warnings.push(
      unlimited
        ? unlimitedApprovalWarning(frame, 'Permit2 permit', 'a Permit2 allowance `amount` is the maximum uint160.', spenderDesc)
        : {
            severity: 'warning',
            title: 'Permit2 allowance',
            context: `${frame} Why: Permit2 \`permit\` sets a token allowance from an off-chain signature.`,
            message: `Grants a Permit2 allowance ${spenderDesc || 'to the listed spender'}. Check the token, amount, expiration and spender.`,
          },
    );
    return;
  }

  const spec = APPROVAL_SPECS[sel];
  const amountParam = spec
    ? call.params[spec.amount]
    : APPROVAL_FUNCTIONS.has(fnName)
      ? findParamByNameOrType(call.params, 'amount', 'uint256')
      : undefined;
  if (!amountParam) return;
  const spenderParam = spec ? call.params[spec.spender] : findParamByNameOrType(call.params, 'spender', 'address');
  const label = spec?.label ?? fnName;

  if (isUnlimitedAmount(amountParam.value, amountParam.type)) {
    warnings.push(
      unlimitedApprovalWarning(frame, `\`${label}\``, `\`${label}\` with the maximum ${amountParam.type} amount (unlimited allowance).`, describeSpender(spenderParam, chainId)),
    );
    return;
  }
  checkLargeTokenAmount(amountParam, call, warnings, 'approval');
}

/** Safe batching libraries that are normal DELEGATECALL targets (MultiSend / MultiSendCallOnly 1.3.0 and 1.4.1). */
const SAFE_MULTISEND_LIBRARIES = new Set([
  '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761',
  '0x40a2accbd92bca938b02010e17a5b8929b49130d',
  '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526',
  '0x9641d764fc13c8b624c04430c7356c1c7c8102e2',
]);
const SAFE_EXEC_SELECTORS = new Set(['0x6a761202', '0x468721a7']);
const SAFE_MULTISEND_SELECTOR = '0x8d80ff0a';

/**
 * Safe `operation` values: 0 = CALL, 1 = DELEGATECALL. A DELEGATECALL runs the target's code with the Safe's own
 * storage and balance — the vector used to take over the Bybit Safe in Feb 2025 — so it gets its own warning.
 */
function checkSafeOperations(call: DecodedCall, warnings: TxWarning[], chainId: number, frame: string): void {
  const sel = call.selector.toLowerCase();

  if (SAFE_EXEC_SELECTORS.has(sel)) {
    const toP = call.params[0];
    const opP = call.params[3];
    if (!opP || opP.value.kind !== 'primitive') return;
    const op = opP.value.raw;
    const target = extractAddress(toP?.value ?? { kind: 'tuple', fields: [] });
    if (op === '1') {
      warnings.push(safeDelegatecallWarning(frame, target, chainId, '`operation` = 1 (DELEGATECALL)'));
    } else if (op !== '0') {
      warnings.push({
        severity: 'danger',
        title: 'Unknown Safe operation',
        context: `${frame} Why: \`operation\` = ${op}; Safe only defines 0 (CALL) and 1 (DELEGATECALL).`,
        message: 'Do not sign: this operation value is not a standard Safe call type.',
      });
    }
    return;
  }

  if (sel === SAFE_MULTISEND_SELECTOR) {
    const rows = call.params[0]?.value;
    if (rows?.kind !== 'array') return;
    rows.elements.forEach((row, i) => {
      if (row.kind !== 'tuple') return;
      const opV = row.fields[0]?.value;
      if (opV?.kind !== 'primitive') return;
      const target = extractAddress(row.fields[1]?.value ?? { kind: 'tuple', fields: [] });
      if (opV.raw === '1') {
        warnings.push(safeDelegatecallWarning(frame, target, chainId, `multiSend row ${i} is a DELEGATECALL`));
      } else if (opV.raw === '2') {
        warnings.push({
          severity: 'warning',
          title: 'Contract creation in multiSend',
          context: `${frame} Why: multiSend row ${i} has operation 2 (CREATE).`,
          message: 'This batch deploys a contract. Make sure you know what the init code does.',
        });
      } else if (opV.raw !== '0') {
        warnings.push({
          severity: 'danger',
          title: 'Unknown multiSend operation',
          context: `${frame} Why: multiSend row ${i} has operation byte ${opV.raw}.`,
          message: 'Only 0 (CALL), 1 (DELEGATECALL) and 2 (CREATE) are defined. Do not sign a batch you cannot fully decode.',
        });
      }
    });
  }
}

function safeDelegatecallWarning(frame: string, target: string | undefined, chainId: number, why: string): TxWarning {
  const lower = target?.toLowerCase();
  const name = target ? getContractName(target, chainId) : undefined;
  const who = target ? `${checksumTxTo(target)}${name ? ` (${name})` : ''}` : 'the target';
  if (lower && SAFE_MULTISEND_LIBRARIES.has(lower)) {
    return {
      severity: 'warning',
      title: 'Safe DELEGATECALL to MultiSend',
      context: `${frame} Why: ${why} to the canonical Safe MultiSend library.`,
      message: `Normal for batched Safe transactions: ${who} runs each row below with the Safe's permissions. Check every row, and especially any row that is itself a DELEGATECALL.`,
    };
  }
  return {
    severity: 'danger',
    title: 'Safe DELEGATECALL',
    context: `${frame} Why: ${why}.`,
    message: `The Safe will run code at ${who} with full control of its storage and funds (owners, modules, threshold, balances). This is how the Bybit Safe was taken over in Feb 2025. Only sign if you know exactly what this contract does.`,
  };
}

/** Amount of a `transfer` / `transferFrom` (by selector), else a name-based guess for other `transfer*` names. */
function findTransferAmountParam(call: DecodedCall): DecodedParam | undefined {
  const idx = TRANSFER_AMOUNT_INDEX[call.selector.toLowerCase()];
  if (idx !== undefined) return call.params[idx];
  const fnName = call.signature.name;
  if (fnName === 'transfer' || fnName === 'transferFrom' || fnName === 'safeTransferFrom') {
    return findParamByNameOrType(call.params, 'amount', 'uint256') ?? findParamByNameOrType(call.params, 'value', 'uint256');
  }
  return undefined;
}

/**
 * Large transfer / approval: uses the decoder's structured {@link DecodedValue} `tokenAmount` (never parses the
 * display text). Tokens whose metadata came from the contract itself are skipped — their symbol is not evidence of
 * value — and flagged separately as unverified.
 */
function checkLargeTokenAmount(
  amountParam: DecodedParam,
  call: DecodedCall,
  warnings: TxWarning[],
  action: 'transfer' | 'approval',
) {
  const v = amountParam.value;
  if (v.kind !== 'primitive' || !v.tokenAmount) return;
  const ta = v.tokenAmount;
  if (ta.unverified) {
    warnings.push({
      severity: 'warning',
      title: 'Unverified token',
      context: `${warningCallFrameContext(call)} Why: the token calls itself "${ta.symbol}" but is not in this app's registry.`,
      message: 'Anyone can deploy a contract with any name and decimals. Check the token address on a block explorer before trusting the amount.',
    });
    return;
  }
  let amount: number;
  try {
    amount = Number(formatUnits(BigInt(v.raw), ta.decimals));
  } catch {
    return;
  }
  if (!(amount > 0)) return;
  const usdEstimate = estimateUsdValue(amount, ta.symbol);
  if (usdEstimate === null || usdEstimate <= 50_000) return;
  const label = action === 'transfer' ? 'Large token transfer' : 'Large token approval';
  warnings.push({
    severity: 'warning',
    title: label,
    context: `${warningCallFrameContext(call)} Why: \`${amountParam.name}\` decodes to ~${amount.toLocaleString()} ${ta.symbol} (rough USD estimate for the warning threshold only).`,
    message: `Estimated ~$${Math.round(usdEstimate).toLocaleString()} notional. Double-check recipient and amount before signing.`,
  });
}

/**
 * Prefer ABI param `name`, else first param with exact Solidity `type` (e.g. `uint256`).
 * Type fallback can misfire if names are non-standard (`value` vs `amount`) — acceptable for heuristics only.
 */
function findParamByNameOrType(params: DecodedParam[], name: string, type: string): DecodedParam | undefined {
  return params.find(p => p.name.toLowerCase() === name.toLowerCase())
    ?? params.find(p => p.type === type);
}

/** Max of the param's own width (`uint160` for Permit2), plus the common uint256 / uint160 sentinels. */
function isUnlimitedAmount(value: DecodedValue, solidityType = 'uint256'): boolean {
  if (value.kind !== 'primitive') return false;
  try {
    const v = BigInt(value.raw);
    const bits = /^uint(\d+)$/.exec(solidityType.replace(/\s/g, ''))?.[1];
    const typeMax = bits ? (1n << BigInt(bits)) - 1n : UNLIMITED_APPROVAL;
    return v === typeMax || v === UNLIMITED_APPROVAL || v === UINT160_MAX;
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
