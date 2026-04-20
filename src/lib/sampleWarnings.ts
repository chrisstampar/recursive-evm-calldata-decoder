import type { TxWarning } from '../types/index.ts';

/** Static examples for dev UI preview only — not used in production. */
export const SAMPLE_DEV_WARNINGS: TxWarning[] = [
  {
    severity: 'danger',
    title: 'Unlimited token approval',
    context:
      'Call frame: top level — 0x095ea7b3 · approve(). Why: `approve` with `amount` = max uint256 (unlimited allowance).',
    message:
      'Unlimited spending approval to an unrecognized address. A compromised or malicious spender can drain all tokens of this type from your wallet.',
  },
  {
    severity: 'warning',
    title: 'Large token transfer',
    context:
      'Call frame: top level — 0xa9059cbb · transfer(). Why: `amount` decodes to a large USD-notional estimate (threshold warning only).',
    message: 'Estimated ~$100,000 notional. Double-check recipient and amount before signing.',
  },
  {
    severity: 'info',
    title: 'Ambiguous decode',
    context:
      'Call frame: nested at depth 2 — 0xdeadbeef · mystery(). Why: several public ABIs decode the same inner bytes; one banner per selector+name.',
    message:
      'The UI picked a function name but argument types may be wrong. Paste a verified ABI when available.',
  },
];
