import { createContext, useContext } from 'react';
import { DEFAULT_CHAIN_ID } from '../lib/chains.ts';

/**
 * UI-facing chain settings: explorer/registry `chainId`, offline mode, ENS toggle.
 *
 * - **Naming:** `ChainUi…` / `useChainUi` scope this to presentation + decode options, not a future heavy “chain data” layer.
 * - **State:** `useState` lives in `App`; `ChainProvider` only receives the value object (definition vs ownership split).
 * - **`chainId`:** read-only here; switching chains is **`App` → `CalldataInput` `onChainChange`** so the decode session can reset coherently.
 * - **Tests:** `defaultValue` uses no-op setters so shallow renders work; real tests should still wrap `ChainProvider` with mocks.
 */
export interface ChainUiContextValue {
  chainId: number;
  offlineMode: boolean;
  setOfflineMode: (offline: boolean) => void;
  /** When true, skip Ethereum reverse-ENS for faster decode and fewer RPCs (ignored when `offlineMode`). */
  skipEns: boolean;
  setSkipEns: (skip: boolean) => void;
}

const defaultValue: ChainUiContextValue = {
  chainId: DEFAULT_CHAIN_ID,
  offlineMode: false,
  setOfflineMode: () => {
    /* no provider (e.g. tests) */
  },
  skipEns: false,
  setSkipEns: () => {
    /* no provider (e.g. tests) */
  },
};

const ChainContext = createContext<ChainUiContextValue>(defaultValue);

export const ChainProvider = ChainContext.Provider;

export function useChainUi(): ChainUiContextValue {
  return useContext(ChainContext);
}

export function useChainId(): number {
  return useContext(ChainContext).chainId;
}

export function useOfflineMode(): boolean {
  return useContext(ChainContext).offlineMode;
}
