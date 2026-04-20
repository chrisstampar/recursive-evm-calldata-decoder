/**
 * Curated deployments that must stay reflected in {@link KNOWN_CONTRACTS_RAW} with at least the listed
 * sensitivity tier. Used for regression tests—not a live vulnerability feed (no hot-patch: still ships with the app).
 *
 * **Multi-chain:** Rows are per `(chainId, address)`; canonical Permit2 / Safe use the same address on many
 * EVM chains—each chain still needs an explicit registry row where the app should warn.
 *
 * **Versioning:** Bump {@link SECURITY_WATCHLIST_SCHEMA_VERSION} when you change entry shape; contract upgrades
 * (Aave V4, Permit3, …) need new addresses and/or new rows here + in `abiRegistry.ts`.
 */

import type { ContractRiskLevel } from './abiRegistry.ts';

/** Bump when adding/removing fields on {@link RegistrySecurityWatchlistEntry}. */
export const SECURITY_WATCHLIST_SCHEMA_VERSION = 1;

export type SecurityWatchlistRiskLevel = 'critical' | 'high' | 'medium';

export type SecurityWatchlistCategory =
  | 'lending'
  | 'allowance_manager'
  | 'router'
  | 'multisig'
  | 'other';

export interface RegistrySecurityWatchlistEntry {
  chainId: number;
  /** Prefer EIP-55 checksummed literals; tests normalize with `getAddress`. */
  address: string;
  /** Minimum sensitivity tier the static registry must satisfy for this deployment. */
  riskLevel: SecurityWatchlistRiskLevel;
  category: SecurityWatchlistCategory;
  note: string;
  /** Optional: deployment block for historical tooling (not enforced by the decoder yet). */
  effectiveFromBlock?: number;
  /** Optional: last block where this deployment was authoritative (superseded upgrades). */
  deprecatedAtBlock?: number;
  /** Docs / explorer / source (human review). */
  referenceUrl?: string;
  /** Audits, postmortems, or incident write-ups. */
  incidentReferenceUrl?: string;
}

const RANK_REGISTRY: Record<ContractRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const RANK_WATCHLIST_MIN: Record<SecurityWatchlistRiskLevel, number> = {
  medium: 1,
  high: 2,
  critical: 3,
};

/** True when `registryRisk` is at least as strong as the watchlist row requires. */
export function registryMeetsWatchlistRisk(
  registryRisk: ContractRiskLevel | undefined,
  watchlistMinimum: SecurityWatchlistRiskLevel,
): boolean {
  if (registryRisk === undefined) return false;
  return RANK_REGISTRY[registryRisk] >= RANK_WATCHLIST_MIN[watchlistMinimum];
}

const CHAIN_ETHEREUM = 1;
const CHAIN_POLYGON = 137;
const CHAIN_ARBITRUM = 42161;
const CHAIN_OPTIMISM = 10;
const CHAIN_BASE = 8453;

const ADDR_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ADDR_GNOSIS_SAFE = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552';

/** Aave V3 Pool proxy — Polygon / Arbitrum / Optimism (shared address). Base uses a different deployment. */
const ADDR_AAVE_V3_POOL_L2_SHARED = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
/** Aave V3 Pool proxy on Base — bgd-labs `aave-address-book` `AaveV3Base`. */
const ADDR_AAVE_V3_POOL_BASE = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

function l2HighSensitivityBlock(
  chainId: typeof CHAIN_POLYGON | typeof CHAIN_ARBITRUM | typeof CHAIN_OPTIMISM,
  aaveV3Pool: typeof ADDR_AAVE_V3_POOL_L2_SHARED,
): readonly RegistrySecurityWatchlistEntry[] {
  return [
    {
      chainId,
      address: aaveV3Pool,
      riskLevel: 'critical',
      category: 'lending',
      note: 'Aave V3 Pool — pooled assets / proxy surface',
      referenceUrl: 'https://aave.com/docs/aave-v3/smart-contracts/pool',
    },
    {
      chainId,
      address: ADDR_PERMIT2,
      riskLevel: 'critical',
      category: 'allowance_manager',
      note: 'Permit2 — broad allowance semantics',
      referenceUrl: 'https://github.com/Uniswap/permit2',
    },
    {
      chainId,
      address: ADDR_GNOSIS_SAFE,
      riskLevel: 'high',
      category: 'multisig',
      note: 'Gnosis Safe — delegated execution',
      referenceUrl: 'https://docs.safe.global/smart-contracts/safe',
    },
  ];
}

function baseHighSensitivityBlock(): readonly RegistrySecurityWatchlistEntry[] {
  return [
    {
      chainId: CHAIN_BASE,
      address: ADDR_AAVE_V3_POOL_BASE,
      riskLevel: 'critical',
      category: 'lending',
      note: 'Aave V3 Pool — pooled assets / proxy surface (Base)',
      referenceUrl: 'https://aave.com/docs/aave-v3/smart-contracts/pool',
    },
    {
      chainId: CHAIN_BASE,
      address: ADDR_PERMIT2,
      riskLevel: 'critical',
      category: 'allowance_manager',
      note: 'Permit2 — broad allowance semantics',
      referenceUrl: 'https://github.com/Uniswap/permit2',
    },
    {
      chainId: CHAIN_BASE,
      address: ADDR_GNOSIS_SAFE,
      riskLevel: 'high',
      category: 'multisig',
      note: 'Gnosis Safe — delegated execution',
      referenceUrl: 'https://docs.safe.global/smart-contracts/safe',
    },
  ];
}

/**
 * Canonical regression list: every row must resolve in `getContractRegistryEntry` with a tier
 * ≥ {@link registryMeetsWatchlistRisk}.
 */
export const REGISTRY_SECURITY_WATCHLIST: readonly RegistrySecurityWatchlistEntry[] = [
  {
    chainId: CHAIN_ETHEREUM,
    address: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9',
    riskLevel: 'critical',
    category: 'lending',
    note: 'Aave V2 Lending Pool — pooled assets / proxy surface',
    referenceUrl: 'https://aave.com/docs/developers/v/2.0/the-core-protocol/lending-pool',
  },
  {
    chainId: CHAIN_ETHEREUM,
    address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    riskLevel: 'critical',
    category: 'lending',
    note: 'Aave V3 Pool — pooled assets / proxy surface',
    referenceUrl: 'https://aave.com/docs/aave-v3/smart-contracts/pool',
  },
  {
    chainId: CHAIN_ETHEREUM,
    address: ADDR_PERMIT2,
    riskLevel: 'critical',
    category: 'allowance_manager',
    note: 'Permit2 — broad allowance semantics',
    referenceUrl: 'https://github.com/Uniswap/permit2',
  },
  {
    chainId: CHAIN_ETHEREUM,
    address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
    riskLevel: 'high',
    category: 'router',
    note: 'Uniswap Universal Router — arbitrary command execution surface',
    referenceUrl: 'https://docs.uniswap.org/contracts/v3/reference/deployments',
  },
  {
    chainId: CHAIN_ETHEREUM,
    address: ADDR_GNOSIS_SAFE,
    riskLevel: 'high',
    category: 'multisig',
    note: 'Gnosis Safe — delegated execution',
    referenceUrl: 'https://docs.safe.global/smart-contracts/safe',
  },
  ...l2HighSensitivityBlock(CHAIN_POLYGON, ADDR_AAVE_V3_POOL_L2_SHARED),
  ...l2HighSensitivityBlock(CHAIN_ARBITRUM, ADDR_AAVE_V3_POOL_L2_SHARED),
  ...l2HighSensitivityBlock(CHAIN_OPTIMISM, ADDR_AAVE_V3_POOL_L2_SHARED),
  ...baseHighSensitivityBlock(),
];
