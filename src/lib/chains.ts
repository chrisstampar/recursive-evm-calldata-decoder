/** @see https://chainid.network/chains_mini.json — regenerate `chainlistChainNames.json` from that snapshot. */
import chainlistChainNamesJson from './chainlistChainNames.json' with { type: 'json' };
import { sanitizeTrustedUiLabel } from './sanitize.ts';

/** Typed view: JSON import is a concrete key union; we index by dynamic `String(chainId)`. */
const chainlistChainNames = chainlistChainNamesJson as Readonly<Record<string, string>>;

const MAX_CHAIN_NAME_DISPLAY_CHARS = 96;

const MAX_SAFE_CHAIN_ID_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function sanitizeChainRegistryLabel(label: string): string {
  return sanitizeTrustedUiLabel(label, MAX_CHAIN_NAME_DISPLAY_CHARS);
}

/** Only own keys — avoids prototype pollution if bundled JSON were ever malformed. */
function readSanitizedChainlistName(chainId: number): string | undefined {
  const key = String(chainId);
  if (!Object.hasOwn(chainlistChainNames, key)) return undefined;
  const v = chainlistChainNames[key];
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const s = sanitizeChainRegistryLabel(v);
  return s.length > 0 ? s : undefined;
}

export interface ChainConfig {
  id: number;
  name: string;
  nativeCurrency: string;
  /**
   * Block explorer **origin** only (no path). Callers append `/tx/${hash}` or `/address/${address}` —
   * keep that convention consistent wherever links are built.
   */
  explorerUrl: string;
  rpcs: string[];
  /** Per-request JSON-RPC timeout in ms (default used when omitted). */
  rpcTimeoutMs?: number;
  /**
   * Delay before starting each RPC after the previous index (`index * rpcStaggerMs`, capped globally).
   * Lower reduces bias toward first RPC; higher spreads load.
   */
  rpcStaggerMs?: number;
  /**
   * When false, a null `eth_getTransactionByHash` skips `eth_getTransactionReceipt` (fewer RPCs on miss;
   * indexing-lag vs not-found is no longer distinguished on that path). Overridable per fetch via options.
   */
  receiptProbeOnNullTx?: boolean;
}

export const CHAINS: Record<number, ChainConfig> = {
  1: {
    id: 1,
    name: 'Ethereum',
    nativeCurrency: 'ETH',
    explorerUrl: 'https://etherscan.io',
    rpcs: [
      'https://eth.llamarpc.com',
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://1rpc.io/eth',
    ],
  },
  42161: {
    id: 42161,
    name: 'Arbitrum',
    nativeCurrency: 'ETH',
    explorerUrl: 'https://arbiscan.io',
    rpcTimeoutMs: 15_000,
    rpcs: [
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.drpc.org',
      'https://1rpc.io/arb',
    ],
  },
  8453: {
    id: 8453,
    name: 'Base',
    nativeCurrency: 'ETH',
    explorerUrl: 'https://basescan.org',
    rpcTimeoutMs: 15_000,
    rpcs: [
      'https://base-rpc.publicnode.com',
      'https://base.drpc.org',
      'https://1rpc.io/base',
    ],
  },
  137: {
    id: 137,
    name: 'Polygon',
    /** Polygon PoS gas token is POL (post-migration); not legacy MATIC. */
    nativeCurrency: 'POL',
    explorerUrl: 'https://polygonscan.com',
    rpcTimeoutMs: 15_000,
    rpcs: [
      'https://polygon-rpc.com',
      'https://polygon.drpc.org',
      'https://1rpc.io/matic',
    ],
  },
  10: {
    id: 10,
    name: 'Optimism',
    nativeCurrency: 'ETH',
    explorerUrl: 'https://optimistic.etherscan.io',
    rpcTimeoutMs: 15_000,
    rpcs: [
      'https://mainnet.optimism.io',
      'https://optimism.drpc.org',
      'https://1rpc.io/op',
    ],
  },
  999: {
    id: 999,
    name: 'HyperEVM',
    nativeCurrency: 'HYPE',
    explorerUrl: 'https://hypurrscan.io',
    rpcTimeoutMs: 15_000,
    rpcs: [
      'https://rpc.hyperliquid.xyz/evm',
      'https://rpc.hypurrscan.io',
      'https://hyperliquid.drpc.org',
    ],
  },
};

export const DEFAULT_CHAIN_ID = 1;

/**
 * Bridge-oriented labels that win over chainlist when an ID is **not** in {@link CHAINS}.
 * Required for **999**: chainlist still lists Wanchain Testnet, but Hyperliquid HyperEVM / bridge UIs use **999** —
 * without this override, `destinationChainId` copy would show the wrong network name.
 */
const BRIDGE_EVM_CHAIN_NAME_OVERRIDES: Readonly<Record<number, string>> = {
  999: 'HyperEVM',
};

/** Resolver label — {@link CHAINS} first, then bridge overrides, then chainlist (~2.5k networks). All names sanitized. */
export function getKnownEvmChainName(chainId: number): string | undefined {
  const configured = CHAINS[chainId]?.name;
  if (configured) return sanitizeChainRegistryLabel(configured);
  const bridge = BRIDGE_EVM_CHAIN_NAME_OVERRIDES[chainId];
  if (bridge) return sanitizeChainRegistryLabel(bridge);
  return readSanitizedChainlistName(chainId);
}

/** Count of `chainId` entries bundled from chainlist (for tests / diagnostics). */
export function getBundledChainlistNameCount(): number {
  return Object.keys(chainlistChainNames).length;
}

export interface DecodedChainIdParts {
  /** Canonical decimal string from ABI-decoded uint (matches `BigInt(raw.trim()).toString()`). */
  decimalLabel: string;
  /** Safe for `CHAINS` / chainlist lookup; equals `Number(BigInt)` when in range. */
  lookup: number;
}

/**
 * Parse ABI-decoded uint string as a chain ID. The numeric text shown in UI must come from
 * `decimalLabel`, not from a separate formatting path, so it cannot diverge from calldata.
 */
export function parseDecodedChainId(raw: string): DecodedChainIdParts | undefined {
  try {
    const b = BigInt(raw.trim());
    if (b < 0n || b > MAX_SAFE_CHAIN_ID_BIGINT) return undefined;
    return { decimalLabel: b.toString(), lookup: Number(b) };
  } catch {
    return undefined;
  }
}

/**
 * Parse a decoded uint calldata string as a chain ID for lookups. Rejects values above
 * `Number.MAX_SAFE_INTEGER` so labels are never matched with rounded floats.
 */
export function parseChainIdFromDecodedUint(raw: string): number | undefined {
  return parseDecodedChainId(raw)?.lookup;
}

/** Decoded uint + optional app registry name (never from calldata). */
export function describeDecodedChainIdForUi(raw: string): {
  decimalLabel: string;
  friendlyName?: string;
} | undefined {
  const p = parseDecodedChainId(raw);
  if (!p) return undefined;
  const friendlyName = getKnownEvmChainName(p.lookup);
  return { decimalLabel: p.decimalLabel, friendlyName };
}

/** Interpretation line for `destinationChainId`-style params; ID substring always from {@link parseDecodedChainId}. */
export function formatDestinationChainInterpretation(raw: string): string | undefined {
  const d = describeDecodedChainIdForUi(raw);
  if (!d) return undefined;
  if (d.friendlyName) return `${d.friendlyName} (chain ID ${d.decimalLabel})`;
  return `chain ID ${d.decimalLabel}`;
}

export const CHAIN_LIST = Object.values(CHAINS).sort((a, b) => {
  if (a.id === 1) return -1;
  if (b.id === 1) return 1;
  return a.name.localeCompare(b.name);
});

export function getChain(chainId: number): ChainConfig {
  return CHAINS[chainId] ?? CHAINS[DEFAULT_CHAIN_ID];
}

/** Explorer origin for `chainId`; append `/tx/…` or `/address/…` (see {@link ChainConfig.explorerUrl}). */
export function getExplorerUrl(chainId: number): string {
  return getChain(chainId).explorerUrl;
}
