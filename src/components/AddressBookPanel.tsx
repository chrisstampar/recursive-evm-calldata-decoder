import { useState, type FormEvent } from 'react';
import { useAddressBook } from '../context/AddressBookContext.tsx';

/** Add, rename, and remove your own addresses. Stored in this browser only; nothing is sent anywhere. */
export function AddressBookPanel({ onClose }: { onClose: () => void }) {
  const { entries, add, remove } = useAddressBook();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    try {
      add(address, label);
      setAddress('');
      setLabel('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that address.');
    }
  };

  const inputClass =
    'rounded-lg bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none';

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 sm:p-6 space-y-4" aria-labelledby="address-book-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="address-book-heading" className="text-sm font-medium text-gray-300">
            Address book
          </h2>
          <p className="mt-1 text-xs text-gray-500 max-w-2xl">
            Save your own wallets and the addresses you send to. Decoded addresses that start and end like one of them but
            are different get a warning, which is how address-poisoning scams are caught. Saved in this browser only.
          </p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 text-sm text-gray-500 hover:text-gray-300">
          Close
        </button>
      </div>

      <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2">
        <label className="sr-only" htmlFor="ab-address">
          Address
        </label>
        <input
          id="ab-address"
          value={address}
          onChange={e => {
            setAddress(e.target.value);
            setError(null);
          }}
          placeholder="0x… address"
          spellCheck={false}
          autoComplete="off"
          className={`${inputClass} font-mono min-w-0 flex-[2]`}
        />
        <label className="sr-only" htmlFor="ab-label">
          Name
        </label>
        <input
          id="ab-label"
          value={label}
          onChange={e => {
            setLabel(e.target.value);
            setError(null);
          }}
          placeholder="Name, e.g. Ledger"
          maxLength={60}
          autoComplete="off"
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button
          type="submit"
          className="shrink-0 px-4 py-2 rounded-lg bg-blue-600 text-gray-50 text-sm font-medium hover:bg-blue-500 transition-colors"
        >
          Save
        </button>
      </form>
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}

      {entries.length === 0 ? (
        <p className="text-xs text-gray-500">No saved addresses yet.</p>
      ) : (
        <ul className="divide-y divide-gray-800">
          {entries.map(e => (
            <li key={e.address} className="flex items-center gap-3 py-2 min-w-0">
              <span className="text-sm text-gray-200 shrink-0 max-w-[40%] truncate" title={e.label}>
                {e.label}
              </span>
              <span className="font-mono text-xs text-gray-400 min-w-0 flex-1 break-all">{e.address}</span>
              <button
                type="button"
                onClick={() => remove(e.address)}
                className="shrink-0 text-xs text-gray-500 hover:text-red-300"
                aria-label={`Remove ${e.label} from the address book`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
