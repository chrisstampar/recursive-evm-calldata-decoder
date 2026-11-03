/**
 * Plain-language summary of a decoded transaction: one line per step ("Swap up to 100 USDT for 3,017 NAORIS → 0x8Bb8…"),
 * built only from what the decoder already resolved. Known shapes (ERC-20, Permit2, swaps, router steps) get a
 * sentence; anything else gets its function name and its addresses and token amounts. Batches and router plans are
 * flattened into their steps.
 */
import type { DecodedCall, DecodedParam, DecodedValue, UniswapV3Path } from '../types/index.ts';
import { getTokenInfo } from './abiRegistry.ts';
import { childCalls, listDecodedCalls } from './callTree.ts';
import { splitInterpretation } from './valueFormatter.ts';

export type SummaryPart =
  | { kind: 'text'; text: string }
  /** `caution` flags amounts whose unit came from the token contract itself or was guessed. */
  | { kind: 'amount'; text: string; caution?: string }
  | { kind: 'address'; address: string; label?: string }
  | { kind: 'path'; path: UniswapV3Path };

export interface SummaryStep {
  /** Position in `listDecodedCalls(root)`, for "show in tree". */
  callIndex: number;
  /** Indent level: steps inside a summarised call (a v4 swap's actions, a Safe transaction's call) sit one deeper. */
  nesting: number;
  parts: SummaryPart[];
  /** Found by probing opaque bytes: may be a coincidental match. */
  guessed?: boolean;
  /** Router command flagged to continue if it reverts. */
  allowRevert?: boolean;
}

export interface TxSummary {
  steps: SummaryStep[];
  /** Steps left out to keep the summary short. */
  omitted: number;
}

const MAX_SUMMARY_STEPS = 40;
/** Fields listed for calls without a known shape. */
const MAX_GENERIC_FIELDS = 4;
const ALLOW_REVERT_SUFFIX = ' (allow revert)';

const text = (t: string): SummaryPart => ({ kind: 'text', text: t });

/** Top-level arguments plus the fields of top-level structs (router `params`, Permit2 `permitSingle`); first name wins. */
function fieldsOf(call: DecodedCall): Map<string, DecodedParam> {
  const out = new Map<string, DecodedParam>();
  const add = (p: DecodedParam) => {
    if (!out.has(p.name)) out.set(p.name, p);
  };
  call.params.forEach(add);
  for (const p of call.params) if (p.value.kind === 'tuple') p.value.fields.forEach(add);
  return out;
}

function addressPart(v: DecodedValue | undefined, chainId: number): SummaryPart | undefined {
  let address: string | undefined;
  let label: string | undefined;
  if (v?.kind === 'address') {
    address = v.checksummed;
    label = v.label ?? v.ensName;
  } else if (v?.kind === 'primitive' && v.embeddedEvmAddress) {
    address = v.embeddedEvmAddress.checksummed;
    label = v.embeddedEvmAddress.ensName;
  }
  if (!address) return undefined;
  label ??= getTokenInfo(address, chainId)?.symbol;
  // Keep labels short in a sentence: "native ETH (address(0) in Uniswap v4)" → "native ETH".
  if (label?.includes(' (')) label = label.slice(0, label.indexOf(' ('));
  return { kind: 'address', address, ...(label ? { label } : {}) };
}

/**
 * An amount as people read it. Without a known unit the raw number is shown with the token (or `fallbackUnit`)
 * next to it, so nothing is presented as more certain than it is.
 */
function amountParts(
  v: DecodedValue | undefined,
  chainId: number,
  /** The amount's token, as a decoded value or (for path endpoints) a checksummed address. */
  token?: DecodedValue | string,
  fallbackUnit = 'raw units',
): SummaryPart[] {
  if (v?.kind !== 'primitive') return [text('?')];
  if (v.interpretation && !v.interpretation.startsWith('Timestamp: ')) {
    // "Unlimited USDC approval" reads as a heading; mid-sentence it is "spend unlimited USDC".
    const headline = splitInterpretation(v.interpretation)
      .headline.replace(/^Unlimited (.+) approval$/, 'unlimited $1')
      .replace(/^Unlimited /, 'unlimited ');
    const ta = v.tokenAmount;
    const caution = ta?.unverified ? 'symbol and decimals set by the token contract' : ta?.guessed ? 'unit guessed' : undefined;
    return [{ kind: 'amount', text: headline, ...(caution ? { caution } : {}) }];
  }
  const tokenPart =
    typeof token === 'string'
      ? addressPart({ kind: 'address', address: token, checksummed: token }, chainId)
      : addressPart(token, chainId);
  if (tokenPart) return [{ kind: 'amount', text: v.display }, text(' '), tokenPart];
  return [{ kind: 'amount', text: `${v.display} ${fallbackUnit}` }];
}

function get(f: Map<string, DecodedParam>, ...names: string[]): DecodedValue | undefined {
  for (const n of names) {
    const p = f.get(n);
    if (p) return p.value;
  }
  return undefined;
}

function isZero(v: DecodedValue | undefined): boolean {
  return v?.kind === 'primitive' && v.raw === '0';
}

/** "V3_SWAP_EXACT_OUT" → "V3 swap exact out", "swapExactTokensForTokens" → "Swap exact tokens for tokens". */
export function humanizeFunctionName(name: string): string {
  const spaced = /^[A-Z0-9_]+$/.test(name)
    ? name.toLowerCase().replace(/_/g, ' ')
    : name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  const trimmed = spaced.trim() || name;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function permit2Parts(f: Map<string, DecodedParam>, chainId: number): SummaryPart[] | null {
  const details = get(f, 'details');
  const spender = addressPart(get(f, 'spender'), chainId);
  if (!details || !spender) return null;
  const rows = details.kind === 'array' ? details.elements : [details];
  const parts: SummaryPart[] = [text('Permit2: let '), spender, text(' spend ')];
  rows.forEach((row, i) => {
    if (row.kind !== 'tuple' || row.fields.length < 3) return;
    if (i > 0) parts.push(text(' and '));
    parts.push(...amountParts(row.fields[1].value, chainId, row.fields[0].value));
    const exp = row.fields[2].value;
    if (isZero(exp)) parts.push(text(' (this block only)'));
    else if (exp.kind === 'primitive' && exp.interpretation?.startsWith('Timestamp: ')) {
      parts.push(text(` until ${splitInterpretation(exp.interpretation).headline}`));
    }
  });
  return parts;
}

/** " until 1 Jan 2030" for a deadline read as a timestamp; nothing otherwise. */
function until(v: DecodedValue | undefined): SummaryPart[] {
  if (v?.kind === 'primitive' && v.interpretation?.startsWith('Timestamp: ')) {
    return [text(` until ${splitInterpretation(v.interpretation).headline}`)];
  }
  return [];
}

function isZeroAddress(v: DecodedValue): boolean {
  return v.kind === 'address' && /^0x0{40}$/i.test(v.address);
}

/** Seaport offer or consideration items: token amounts, NFTs by id, and (for consideration) who is paid. */
function seaportItems(v: DecodedValue | undefined, chainId: number, withRecipient: boolean): SummaryPart[] | null {
  if (v?.kind !== 'array') return null;
  if (v.elements.length === 0) return [text('nothing')];
  return v.elements.flatMap((item, i) => {
    if (item.kind !== 'tuple') return [];
    const f = new Map(item.fields.map(x => [x.name, x] as const));
    const type = get(f, 'itemType');
    const kind = type?.kind === 'primitive' ? Number(type.raw) : -1;
    const token = get(f, 'token');
    const parts: SummaryPart[] = i > 0 ? [text(', ')] : [];
    if (kind === 0 || kind === 1) {
      parts.push(...amountParts(get(f, 'startAmount'), chainId, kind === 0 ? undefined : token, kind === 0 ? 'wei of the native coin' : undefined));
    } else {
      const id = get(f, 'identifierOrCriteria');
      const ap = addressPart(token, chainId);
      parts.push(text(kind >= 4 ? 'any NFT from ' : 'NFT '), ...(ap ? [ap] : []));
      if (kind < 4 && id?.kind === 'primitive') parts.push(text(` #${id.display}`));
    }
    const recipient = withRecipient ? addressPart(get(f, 'recipient'), chainId) : undefined;
    if (recipient) parts.push(text(' to '), recipient);
    return parts;
  });
}

/** Input and output token of a swap, in trade order, from a v3 path or a v2 `address[]` path. */
function swapEndpoints(path: DecodedValue | undefined): { tokenIn?: string; tokenOut?: string } {
  if (path?.kind === 'bytes' && path.v3Path) {
    const t = path.v3Path.tokens.map(x => x.address);
    return path.v3Path.exactOut ? { tokenIn: t[t.length - 1], tokenOut: t[0] } : { tokenIn: t[0], tokenOut: t[t.length - 1] };
  }
  if (path?.kind === 'array') {
    const first = path.elements[0];
    const last = path.elements[path.elements.length - 1];
    return {
      tokenIn: first?.kind === 'address' ? first.checksummed : undefined,
      tokenOut: last?.kind === 'address' ? last.checksummed : undefined,
    };
  }
  return {};
}

function swapParts(f: Map<string, DecodedParam>, chainId: number): SummaryPart[] | null {
  const path = get(f, 'path');
  const { tokenIn, tokenOut } = swapEndpoints(path);
  const amountIn = get(f, 'amountIn');
  const minOut = get(f, 'amountOutMin', 'amountOutMinimum', 'minReturnAmount', 'minAmountOut');
  const amountOut = get(f, 'amountOut');
  const maxIn = get(f, 'amountInMax', 'amountInMaximum');
  let parts: SummaryPart[];
  if (amountIn && minOut) {
    parts = [
      text('Swap '),
      ...amountParts(amountIn, chainId, tokenIn),
      text(' for '),
      ...(isZero(minOut) ? [text('any amount (no minimum)')] : [text('at least '), ...amountParts(minOut, chainId, tokenOut)]),
    ];
  } else if (amountOut && maxIn) {
    parts = [text('Swap up to '), ...amountParts(maxIn, chainId, tokenIn), text(' for '), ...amountParts(amountOut, chainId, tokenOut)];
  } else {
    return null;
  }
  if (path?.kind === 'bytes' && path.v3Path) parts.push(text(' via '), { kind: 'path', path: path.v3Path });
  const recipient = addressPart(get(f, 'recipient'), chainId);
  if (recipient) parts.push(text(' → '), recipient);
  return parts;
}

/** Sentence for a known shape, or null. */
function recipe(call: DecodedCall, chainId: number): SummaryPart[] | null {
  const name = call.signature.name.endsWith(ALLOW_REVERT_SUFFIX)
    ? call.signature.name.slice(0, -ALLOW_REVERT_SUFFIX.length)
    : call.signature.name;
  const p = call.params;
  const f = fieldsOf(call);
  const a = (v: DecodedValue | undefined) => addressPart(v, chainId);
  const amt = (v: DecodedValue | undefined, token?: DecodedValue, unit?: string) => amountParts(v, chainId, token, unit);
  const join = (...xs: (SummaryPart | SummaryPart[] | undefined)[]): SummaryPart[] | null => {
    if (xs.some(x => x === undefined)) return null;
    return xs.flatMap(x => (Array.isArray(x) ? x : [x as SummaryPart]));
  };
  const isAddr = (i: number) => p[i]?.type === 'address';
  const isUint = (i: number) => p[i]?.type.startsWith('uint') === true;

  switch (name) {
    case 'approve':
      if (p.length === 2 && isAddr(0) && isUint(1)) return join(text('Approve '), a(p[0].value), text(' to spend '), amt(p[1].value));
      break;
    case 'increaseAllowance':
      if (p.length === 2 && isAddr(0) && isUint(1)) return join(text('Raise the allowance of '), a(p[0].value), text(' by '), amt(p[1].value));
      break;
    case 'transfer':
      if (p.length === 2 && isAddr(0) && isUint(1)) return join(text('Transfer '), amt(p[1].value), text(' to '), a(p[0].value));
      break;
    case 'transferFrom':
      if (p.length === 3 && isAddr(0) && isAddr(1) && isUint(2)) {
        return join(text('Transfer '), amt(p[2].value), text(' from '), a(p[0].value), text(' to '), a(p[1].value));
      }
      break;
    case 'setApprovalForAll':
      if (p.length === 2 && isAddr(0)) {
        const on = p[1].value.kind === 'primitive' && p[1].value.display === 'true';
        return join(text(on ? 'Let ' : 'Revoke '), a(p[0].value), text(on ? ' move every NFT in this collection' : "'s access to every NFT in this collection"));
      }
      break;
    case 'permit':
    case 'PERMIT2_PERMIT':
    case 'PERMIT2_PERMIT_BATCH': {
      const viaPermit2 = permit2Parts(f, chainId);
      if (viaPermit2) return viaPermit2;
      if (name === 'permit' && f.has('spender') && f.has('value')) {
        return join(text('Permit '), a(get(f, 'spender')), text(' to spend '), amt(get(f, 'value')), text(' of '), a(get(f, 'owner')));
      }
      break;
    }
    case 'PERMIT2_TRANSFER_FROM':
      return join(text('Pull '), amt(get(f, 'amount'), get(f, 'token')), text(' via Permit2 to '), a(get(f, 'recipient')));
    case 'WRAP_ETH':
      return join(text('Wrap '), amt(get(f, 'amountMin'), undefined, 'wei'), text(' of ETH into WETH for '), a(get(f, 'recipient')));
    case 'UNWRAP_WETH':
      return join(text('Unwrap WETH (at least '), amt(get(f, 'amountMin'), undefined, 'wei'), text(') to '), a(get(f, 'recipient')));
    case 'SWEEP':
      if (f.has('amountMin')) {
        return join(text('Send all remaining '), a(get(f, 'token')), text(' to '), a(get(f, 'recipient')), text(' (at least '), amt(get(f, 'amountMin'), get(f, 'token')), text(')'));
      }
      return join(text('Send all remaining '), a(get(f, 'currency')), text(' to '), a(get(f, 'to')));
    case 'TRANSFER':
      return join(text('Transfer '), amt(get(f, 'value'), get(f, 'token')), text(' to '), a(get(f, 'recipient')));
    case 'PAY_PORTION':
    case 'TAKE_PORTION': {
      const bips = get(f, 'bips');
      const pct = bips?.kind === 'primitive' ? `${Number(bips.raw) / 100}%` : '?';
      return join(text(`Pay ${pct} of the `), a(get(f, 'token', 'currency')), text(' balance to '), a(get(f, 'recipient')));
    }
    case 'BALANCE_CHECK_ERC20':
      return join(text('Check that '), a(get(f, 'owner')), text(' holds at least '), amt(get(f, 'minBalance'), get(f, 'token')));
    case 'SETTLE_ALL':
      return join(text('Pay up to '), amt(get(f, 'maxAmount'), get(f, 'currency')));
    case 'SETTLE':
      return join(text('Pay '), amt(get(f, 'amount'), get(f, 'currency')));
    case 'TAKE_ALL': {
      const min = get(f, 'minAmount');
      return isZero(min)
        ? join(text('Receive all '), a(get(f, 'currency')), text(' owed (no minimum)'))
        : join(text('Receive at least '), amt(min, get(f, 'currency')));
    }
    case 'TAKE':
      return join(text('Send '), amt(get(f, 'amount'), get(f, 'currency')), text(' to '), a(get(f, 'recipient')));
    case 'V4_SWAP':
      return [text('Uniswap v4 swap:')];
    case 'EXECUTE_SUB_PLAN':
      return [text('Run a sub-plan:')];
    case 'execTransaction': {
      const to = a(get(f, 'to'));
      const op = get(f, 'operation');
      const delegate = op?.kind === 'primitive' && op.raw === '1';
      if (to) return join(text(delegate ? 'Safe DELEGATECALL into ' : 'Safe transaction to '), to, text(':'));
      break;
    }
    // EIP-712 messages, decoded as a call named after their primary type (see typedData.ts).
    case 'Permit': {
      const allowed = get(f, 'allowed');
      if (allowed?.kind === 'primitive') {
        return allowed.raw === 'true'
          ? join(text('Let '), a(get(f, 'spender')), text(' spend any amount of this token'), until(get(f, 'expiry')))
          : join(text('Remove the allowance of '), a(get(f, 'spender')));
      }
      if (f.has('value')) return join(text('Let '), a(get(f, 'spender')), text(' spend '), amt(get(f, 'value')), until(get(f, 'deadline')));
      break;
    }
    case 'PermitSingle':
    case 'PermitBatch':
      return permit2Parts(f, chainId);
    case 'PermitTransferFrom':
    case 'PermitWitnessTransferFrom':
    case 'PermitBatchTransferFrom':
    case 'PermitBatchWitnessTransferFrom': {
      const permitted = get(f, 'permitted');
      const rows = permitted?.kind === 'array' ? permitted.elements : permitted ? [permitted] : [];
      const amounts = rows.flatMap((row, i) => {
        if (row.kind !== 'tuple') return [];
        const rf = new Map(row.fields.map(x => [x.name, x] as const));
        return [...(i > 0 ? [text(' and ')] : []), ...amountParts(get(rf, 'amount'), chainId, get(rf, 'token'))];
      });
      if (amounts.length === 0) break;
      return join(text('Permit2: let '), a(get(f, 'spender')), text(' take '), amounts, text(' once'), until(get(f, 'deadline')));
    }
    case 'OrderComponents': {
      const offer = seaportItems(get(f, 'offer'), chainId, false);
      const consideration = seaportItems(get(f, 'consideration'), chainId, true);
      if (!offer || !consideration) break;
      return [text('Seaport order: give '), ...offer, text(' for '), ...consideration];
    }
    case 'Order':
      if (f.has('sellToken') && f.has('buyAmount')) {
        const receiver = get(f, 'receiver');
        return join(
          text('CoW order: sell '),
          amt(get(f, 'sellAmount'), get(f, 'sellToken')),
          text(' for at least '),
          amt(get(f, 'buyAmount'), get(f, 'buyToken')),
          ...(receiver && !isZeroAddress(receiver) ? [text(' → '), a(receiver)] : []),
        );
      }
      break;
  }
  if (/swap/i.test(name)) return swapParts(f, chainId);
  return null;
}

/** Function name plus the arguments people check first: addresses and token amounts. */
function genericParts(call: DecodedCall, chainId: number): SummaryPart[] {
  const parts: SummaryPart[] = [text(humanizeFunctionName(call.signature.name.replace(ALLOW_REVERT_SUFFIX, '')))];
  let shown = 0;
  for (const [name, param] of fieldsOf(call)) {
    if (shown >= MAX_GENERIC_FIELDS) break;
    const v = param.value;
    let value: SummaryPart[] | undefined;
    if (v.kind === 'address' || (v.kind === 'primitive' && v.embeddedEvmAddress)) {
      const ap = addressPart(v, chainId);
      if (ap) value = [ap];
    } else if (v.kind === 'primitive' && v.tokenAmount) {
      value = amountParts(v, chainId);
    }
    if (!value) continue;
    parts.push(text(shown === 0 ? ': ' : ' · '), text(`${name} `), ...value);
    shown++;
  }
  return parts;
}

/** Calls that only carry other calls: their steps are listed in their place. */
const PLAIN_CONTAINER = /^(multicall|aggregate3?|aggregate3Value|tryAggregate|tryBlockAndAggregate|blockAndAggregate|multiSend|execute)$/;

export function summarizeTransaction(root: DecodedCall, chainId: number): TxSummary {
  const index = new Map(listDecodedCalls(root).map((c, i) => [c, i]));
  const steps: SummaryStep[] = [];
  let omitted = 0;

  const push = (call: DecodedCall, nesting: number, parts: SummaryPart[]) => {
    if (steps.length >= MAX_SUMMARY_STEPS) {
      omitted++;
      return;
    }
    steps.push({
      callIndex: index.get(call) ?? 0,
      nesting,
      parts,
      ...(call.speculative ? { guessed: true } : {}),
      ...(call.signature.name.endsWith(ALLOW_REVERT_SUFFIX) ? { allowRevert: true } : {}),
    });
  };

  const visit = (call: DecodedCall, nesting: number): void => {
    const kids = childCalls(call);
    const sentence = recipe(call, chainId);
    if (sentence) {
      push(call, nesting, sentence);
      kids.forEach(k => visit(k, nesting + 1));
      return;
    }
    if (kids.length > 0 && (call === root || PLAIN_CONTAINER.test(call.signature.name))) {
      kids.forEach(k => visit(k, nesting));
      return;
    }
    push(call, nesting, genericParts(call, chainId));
    kids.forEach(k => visit(k, nesting + 1));
  };

  visit(root, 0);
  return { steps, omitted };
}
