import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { formatEther } from 'ethers';
import {
  SAFE_VERSION_RANGES,
  fetchSafeState,
  safeVersionRange,
  type SafeTxFields,
  type SafeVersionRange,
} from '../lib/safeHash.ts';

export interface SafeFormState {
  safeAddress: string;
  version: SafeVersionRange;
  tx: SafeTxFields;
}

const inputClass =
  'w-full rounded-lg bg-gray-900 border border-gray-700 px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none';

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-gray-300 mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function weiHint(value: string, nativeCurrency: string): string {
  try {
    const t = value.trim();
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) return 'In wei (1 ETH = 10^18 wei).';
    return `= ${formatEther(BigInt(t))} ${nativeCurrency}`;
  } catch {
    return 'In wei.';
  }
}

/**
 * The fields of a Safe transaction as the Safe app lists them. Their hashes are worked out locally so a signer can
 * check what their hardware wallet shows.
 */
export function SafeTxForm({
  value,
  onChange,
  chainId,
  nativeCurrency,
  offlineMode,
  onEnter,
}: {
  value: SafeFormState;
  onChange: (next: SafeFormState) => void;
  chainId: number;
  nativeCurrency: string;
  offlineMode: boolean;
  onEnter: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [readState, setReadState] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; message?: string }>({
    status: 'idle',
  });
  const abortRef = useRef<AbortController | null>(null);
  const setTx = (patch: Partial<SafeTxFields>) => onChange({ ...value, tx: { ...value.tx, ...patch } });

  const readFromChain = async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setReadState({ status: 'loading' });
    try {
      const state = await fetchSafeState(chainId, value.safeAddress, ac.signal);
      if (ac.signal.aborted) return;
      onChange({ ...value, version: safeVersionRange(state.version), tx: { ...value.tx, nonce: state.nonce } });
      setReadState({
        status: 'done',
        message: `Safe ${state.version}, next nonce ${state.nonce}. A transaction already queued in the Safe app may use a later nonce.`,
      });
    } catch (e) {
      if (ac.signal.aborted) return;
      setReadState({ status: 'error', message: e instanceof Error ? e.message : 'Could not read the Safe.' });
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field id="safe-address" label="Safe address">
          <input
            id="safe-address"
            value={value.safeAddress}
            onChange={e => onChange({ ...value, safeAddress: e.target.value })}
            onKeyDown={onEnter}
            placeholder="0x… your Safe"
            spellCheck={false}
            autoComplete="off"
            className={inputClass}
          />
        </Field>
        <Field id="safe-version" label="Safe version">
          <select
            id="safe-version"
            value={value.version}
            onChange={e => onChange({ ...value, version: e.target.value as SafeVersionRange })}
            className="w-full rounded-lg bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            {SAFE_VERSION_RANGES.map(v => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => void readFromChain()}
          disabled={offlineMode || readState.status === 'loading' || value.safeAddress.trim() === ''}
          className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 text-sm hover:border-gray-500 disabled:opacity-40 disabled:cursor-not-allowed"
          title={offlineMode ? 'Turn off Offline mode to read the Safe from a public RPC' : undefined}
        >
          {readState.status === 'loading' ? 'Reading…' : 'Read nonce and version from chain'}
        </button>
        {readState.message && (
          <span className={`text-xs ${readState.status === 'error' ? 'text-red-400' : 'text-gray-500'}`} role="status">
            {readState.message}
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="safe-to" label="To">
          <input
            id="safe-to"
            value={value.tx.to}
            onChange={e => setTx({ to: e.target.value })}
            onKeyDown={onEnter}
            placeholder="0x… contract or recipient"
            spellCheck={false}
            autoComplete="off"
            className={inputClass}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="safe-value" label="Value (wei)" hint={weiHint(value.tx.value, nativeCurrency)}>
            <input
              id="safe-value"
              value={value.tx.value}
              onChange={e => setTx({ value: e.target.value })}
              onKeyDown={onEnter}
              inputMode="numeric"
              spellCheck={false}
              autoComplete="off"
              className={inputClass}
            />
          </Field>
          <Field id="safe-nonce" label="Nonce">
            <input
              id="safe-nonce"
              value={value.tx.nonce}
              onChange={e => setTx({ nonce: e.target.value })}
              onKeyDown={onEnter}
              inputMode="numeric"
              placeholder="e.g. 42"
              spellCheck={false}
              autoComplete="off"
              className={inputClass}
            />
          </Field>
        </div>
      </div>

      <Field id="safe-data" label="Data">
        <textarea
          id="safe-data"
          value={value.tx.data}
          onChange={e => setTx({ data: e.target.value })}
          placeholder="0x (empty for a plain transfer)"
          spellCheck={false}
          autoComplete="off"
          className={`${inputClass} h-24 resize-y`}
        />
      </Field>

      <fieldset>
        <legend className="block text-sm font-medium text-gray-300 mb-1.5">Operation</legend>
        <div className="flex gap-4 text-sm text-gray-300">
          {[
            { op: 0, label: 'Call (0)' },
            { op: 1, label: 'Delegatecall (1)' },
          ].map(o => (
            <label key={o.op} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="safe-operation"
                checked={value.tx.operation === o.op}
                onChange={() => setTx({ operation: o.op })}
                className="h-4 w-4 border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
              />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        onClick={() => setShowAdvanced(s => !s)}
        aria-expanded={showAdvanced}
        className="text-xs text-gray-500 hover:text-gray-300"
      >
        {showAdvanced ? 'Hide' : 'Show'} gas and refund fields (usually 0)
      </button>
      {showAdvanced && (
        <div className="grid gap-3 sm:grid-cols-3">
          {(['safeTxGas', 'baseGas', 'gasPrice'] as const).map(k => (
            <Field key={k} id={`safe-${k}`} label={k}>
              <input
                id={`safe-${k}`}
                value={value.tx[k]}
                onChange={e => setTx({ [k]: e.target.value })}
                onKeyDown={onEnter}
                inputMode="numeric"
                spellCheck={false}
                autoComplete="off"
                className={inputClass}
              />
            </Field>
          ))}
          {(['gasToken', 'refundReceiver'] as const).map(k => (
            <Field key={k} id={`safe-${k}`} label={k}>
              <input
                id={`safe-${k}`}
                value={value.tx[k]}
                onChange={e => setTx({ [k]: e.target.value })}
                onKeyDown={onEnter}
                spellCheck={false}
                autoComplete="off"
                className={inputClass}
              />
            </Field>
          ))}
        </div>
      )}
    </div>
  );
}
