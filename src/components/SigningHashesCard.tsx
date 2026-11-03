import { useMemo, useState, type ReactNode } from 'react';
import { CHAINS, getKnownEvmChainName } from '../lib/chains.ts';
import { getContractName } from '../lib/abiRegistry.ts';
import { normalizeHash, signingHashRows, type SigningContext } from '../lib/signing.ts';
import { useChainUi } from '../context/ChainContext.ts';
import { ExplorerAddressLink } from './ExplorerAddressLink.tsx';

function chainName(id: number): string {
  return CHAINS[id]?.name ?? getKnownEvmChainName(id) ?? 'Unknown chain';
}

/** 0x1234 abcd … in groups of four, which is how people compare hashes against a device screen. */
function grouped(hash: string): string {
  return `0x ${hash.slice(2).match(/.{1,4}/g)?.join(' ') ?? ''}`;
}

function DomainRows({ ctx }: { ctx: SigningContext }) {
  const { offlineMode, chainId } = useChainUi();
  const rows: [string, ReactNode][] = [];
  if (ctx.kind === 'safe') {
    rows.push(['Safe', <ExplorerAddressLink key="safe" address={ctx.safeAddress} chainId={ctx.chainId} offlineMode={offlineMode} />]);
    rows.push(['Chain', `${chainName(ctx.chainId)} (${ctx.chainId})`]);
    rows.push(['Safe version', ctx.versionLabel]);
    rows.push(['Nonce', ctx.nonce]);
  } else {
    for (const [k, v] of Object.entries(ctx.domain)) {
      if (k === 'verifyingContract' && typeof v === 'string') {
        rows.push([
          'Verifying contract',
          <ExplorerAddressLink
            key="vc"
            address={v}
            chainId={chainId}
            registryLabel={getContractName(v, chainId) ?? undefined}
            offlineMode={offlineMode}
          />,
        ]);
      } else if (k === 'chainId') {
        const n = Number(v);
        rows.push(['Chain', Number.isSafeInteger(n) ? `${chainName(n)} (${n})` : String(v)]);
      } else {
        rows.push([k.charAt(0).toUpperCase() + k.slice(1), String(v)]);
      }
    }
    if (ctx.safeNonce !== undefined) rows.push(['Safe nonce', ctx.safeNonce]);
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-gray-500">{k}</dt>
          <dd className="text-gray-200 min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Hashes of what is being signed, worked out in the browser, with a box to paste the hash a wallet shows. A mismatch
 * means the wallet is being asked to sign something else.
 */
export function SigningHashesCard({ ctx }: { ctx: SigningContext }) {
  const rows = useMemo(() => signingHashRows(ctx), [ctx]);
  const [compare, setCompare] = useState('');
  const wanted = normalizeHash(compare);
  const match = wanted ? rows.find(r => r.value === wanted) : undefined;
  const title =
    ctx.kind === 'safe'
      ? 'Safe transaction hashes'
      : ctx.safeNonce !== undefined
        ? 'Safe transaction signature'
        : `Signature request: ${ctx.primaryType}`;

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 sm:p-6 space-y-4" aria-labelledby="signing-heading">
      <div>
        <h2 id="signing-heading" className="text-sm font-medium text-gray-400">
          {title}
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Worked out in your browser. Before you sign, check that your wallet or hardware device shows the same hashes.
        </p>
      </div>
      <DomainRows ctx={ctx} />
      <dl className="space-y-3">
        {rows.map(r => (
          <div key={r.label}>
            <dt className="text-xs text-gray-500" title={r.hint}>
              {r.label}
            </dt>
            <dd
              className={`font-mono text-sm break-all rounded px-1 -mx-1 ${match?.label === r.label ? 'bg-green-950/60 text-green-200' : 'text-gray-100'}`}
            >
              {grouped(r.value)}
            </dd>
          </div>
        ))}
      </dl>
      <div>
        <label htmlFor="hash-compare" className="block text-xs text-gray-500 mb-1">
          Compare with the hash your wallet shows
        </label>
        <input
          id="hash-compare"
          type="text"
          value={compare}
          onChange={e => setCompare(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-lg bg-gray-900 border border-gray-700 px-3 py-2 text-sm font-mono text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        />
        <p className="mt-1 text-xs min-h-4" role="status" aria-live="polite">
          {compare.trim() === '' ? null : !wanted ? (
            <span className="text-gray-500">A hash is 0x followed by 64 hex characters.</span>
          ) : match ? (
            <span className="text-green-300">Matches the {match.label}.</span>
          ) : (
            <span className="text-red-300 font-medium">Does not match. Do not sign: the wallet is showing a different request.</span>
          )}
        </p>
      </div>
    </section>
  );
}
