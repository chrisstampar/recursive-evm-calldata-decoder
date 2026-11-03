/* eslint-disable react-refresh/only-export-components -- paired Provider + hook module */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  lookalikeOf,
  readAddressBook,
  saveAddressBook,
  savedEntry,
  upsertEntry,
  type AddressBookEntry,
} from '../lib/addressBook.ts';

interface AddressBookValue {
  entries: AddressBookEntry[];
  /** Throws a readable error for a bad address or empty name. */
  add: (address: string, label: string) => void;
  remove: (address: string) => void;
  /** Saved entry for this exact address. */
  saved: (address: string) => AddressBookEntry | undefined;
  /** Saved entry this (different) address imitates. */
  imitates: (address: string) => AddressBookEntry | undefined;
}

const EMPTY: AddressBookValue = {
  entries: [],
  add: () => {
    /* no provider (tests) */
  },
  remove: () => {
    /* no provider (tests) */
  },
  saved: () => undefined,
  imitates: () => undefined,
};

const AddressBookContext = createContext<AddressBookValue>(EMPTY);

/** The viewer's saved addresses (this browser only); see `lib/addressBook.ts`. */
export function AddressBookProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<AddressBookEntry[]>(readAddressBook);

  const add = useCallback(
    (address: string, label: string) => {
      const next = upsertEntry(entries, address, label);
      saveAddressBook(next);
      setEntries(next);
    },
    [entries],
  );

  const remove = useCallback((address: string) => {
    setEntries(prev => {
      const next = prev.filter(e => e.address !== address);
      saveAddressBook(next);
      return next;
    });
  }, []);

  const value = useMemo<AddressBookValue>(
    () => ({
      entries,
      add,
      remove,
      saved: a => savedEntry(a, entries),
      imitates: a => lookalikeOf(a, entries),
    }),
    [entries, add, remove],
  );

  return <AddressBookContext.Provider value={value}>{children}</AddressBookContext.Provider>;
}

export function useAddressBook(): AddressBookValue {
  return useContext(AddressBookContext);
}
