import type { ReactNode } from 'react';
import { formatEther, formatUnits } from 'ethers';
import { CHAINS, getKnownEvmChainName } from '../lib/chains.ts';
import { getContractName } from '../lib/abiRegistry.ts';
import type { ParsedSignedTx } from '../lib/rawTx.ts';
import { useChainUi } from '../context/ChainContext.ts';
import { ExplorerAddressLink } from './ExplorerAddressLink.tsx';

function gwei(wei: string): string {
  return `${Number(formatUnits(BigInt(wei), 'gwei')).toLocaleString('en-US', { maximumFractionDigits: 4 })} gwei`;
}

/** Every field of a pasted transaction that decides what it does or costs. */
export function SignedTxInfo({ tx, chainId }: { tx: ParsedSignedTx; chainId: number }) {
  const { offlineMode } = useChainUi();
  const native = CHAINS[chainId]?.nativeCurrency ?? 'ETH';
  const value = BigInt(tx.value);
  const chainLabel =
    tx.chainId == null ? 'Any (no chain id)' : `${CHAINS[tx.chainId]?.name ?? getKnownEvmChainName(tx.chainId) ?? 'Unknown chain'} (${tx.chainId})`;
  const link = (address: string) => (
    <ExplorerAddressLink
      key={address}
      address={address}
      chainId={chainId}
      registryLabel={getContractName(address, chainId) ?? undefined}
      offlineMode={offlineMode}
    />
  );

  const rows: [string, ReactNode][] = [
    ['Type', tx.typeName],
    ['Chain', chainLabel],
    ['From', tx.from ? link(tx.from) : 'Unsigned (no sender yet)'],
    ['To', tx.to ? link(tx.to) : 'None: deploys a contract'],
    ['Value', `${formatEther(value)} ${native}`],
    ['Nonce', String(tx.nonce)],
    ['Gas limit', BigInt(tx.gasLimit).toLocaleString('en-US')],
  ];
  if (tx.maxFeePerGas) rows.push(['Max fee', `${gwei(tx.maxFeePerGas)} (tip ${gwei(tx.maxPriorityFeePerGas ?? '0')})`]);
  else if (tx.gasPrice) rows.push(['Gas price', gwei(tx.gasPrice)]);
  if (tx.blobCount > 0) rows.push(['Blobs', String(tx.blobCount)]);
  if (tx.accessListEntries > 0) rows.push(['Access list', `${tx.accessListEntries} contract${tx.accessListEntries === 1 ? '' : 's'}`]);
  tx.authorizations.forEach((a, i) => {
    rows.push([
      `Delegation ${tx.authorizations.length > 1 ? i + 1 : ''}`.trim(),
      <span key={`auth-${i}`} className="inline-flex flex-wrap items-center gap-x-1.5">
        {a.signer ? link(a.signer) : 'unknown account'} <span className="text-gray-500">runs code at</span> {link(a.address)}
        <span className="text-gray-500">
          (chain {a.chainId === '0' ? 'any' : a.chainId}, nonce {a.nonce})
        </span>
      </span>,
    ]);
  });
  if (tx.hash) rows.push(['Hash', <span key="hash" className="font-mono break-all">{tx.hash}</span>]);

  return (
    <dl className="rounded-lg border border-gray-700/50 bg-gray-800/30 px-3 py-2 text-xs grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-gray-500">{k}</dt>
          <dd className="text-gray-300 min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
