import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CHAINS } from './chains.ts';

/** The CSP lives in index.html; an RPC missing from connect-src silently fails in production (audit L2). */
const indexHtml = readFileSync(resolve(__dirname, '../../index.html'), 'utf-8');
const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(indexHtml)?.[1] ?? '';
const connectSrc = /connect-src([^;]+);/.exec(policy)?.[1].split(/\s+/).filter(Boolean) ?? [];

describe('Content-Security-Policy', () => {
  it('allows every RPC origin configured in chains.ts', () => {
    const missing: string[] = [];
    for (const chain of Object.values(CHAINS)) {
      for (const rpc of chain.rpcs) {
        const origin = new URL(rpc).origin;
        if (!connectSrc.includes(origin)) missing.push(`${chain.name}: ${origin}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('does not allow images from arbitrary hosts', () => {
    expect(policy).toMatch(/img-src/);
    expect(policy).not.toMatch(/img-src[^;]*https:/);
  });
});
