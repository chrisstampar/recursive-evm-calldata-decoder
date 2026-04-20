#!/usr/bin/env node
/**
 * Regenerate src/lib/chainlistChainNames.json from https://chainid.network/chains_mini.json
 * Run: node scripts/regen-chainlist-names.mjs
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const url = 'https://chainid.network/chains_mini.json';
const res = await fetch(url);
if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
const data = await res.json();
if (!Array.isArray(data)) throw new Error('Expected JSON array');

const out = {};
for (const c of data) {
  const id = c?.chainId;
  const name = c?.name;
  if (typeof id !== 'number' || id < 0 || id > Number.MAX_SAFE_INTEGER) continue;
  if (typeof name !== 'string' || name.length === 0) continue;
  out[String(id)] = name;
}

const dest = resolve(import.meta.dirname, '../src/lib/chainlistChainNames.json');
writeFileSync(dest, JSON.stringify(out));
console.log(`Wrote ${Object.keys(out).length} chain names to ${dest}`);
