import { createContext, useContext } from 'react';
import type { DecodedCall } from '../types/index.ts';

/** Each call's position in `listDecodedCalls(root)`, so tree nodes get stable ids that warnings and the summary link to. */
export const CallIndexContext = createContext<ReadonlyMap<DecodedCall, number> | null>(null);

export function useCallIndex(call: DecodedCall): number | undefined {
  return useContext(CallIndexContext)?.get(call);
}
