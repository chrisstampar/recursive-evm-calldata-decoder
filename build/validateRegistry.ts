/**
 * Build-time check: every bundled registry signature validates and its selector
 * matches keccak256(canonicalizeTextSignature(...)) (same rule as abiRegistry load).
 */
import { keccak256, toUtf8Bytes } from 'ethers';

import { getBundledSignaturesForTests } from '../src/lib/abiRegistry.ts';
import '../src/lib/knownPatterns.ts';
import {
  canonicalizeTextSignature,
  formatValidationError,
  validateTextSignature,
} from '../src/lib/signatureValidator.ts';

function computeSelectorFromCanonical(canonical: string): string {
  return keccak256(toUtf8Bytes(canonical)).slice(0, 10).toLowerCase();
}

function main(): void {
  const sigs = getBundledSignaturesForTests();
  let failed = false;

  for (const sig of sigs) {
    const vr = validateTextSignature(sig.textSignature);
    if (!vr.valid) {
      console.error(`Invalid signature in registry: ${sig.name}`, formatValidationError(vr.error));
      failed = true;
      continue;
    }

    const canonical = canonicalizeTextSignature(sig.textSignature);
    if (!canonical) {
      console.error(`Canonicalize failed for registry entry: ${sig.name}`);
      failed = true;
      continue;
    }

    const expected = computeSelectorFromCanonical(canonical);
    const got = sig.selector.toLowerCase();
    if (expected !== got) {
      console.error(
        `Selector mismatch for ${sig.name}: expected ${expected}, got ${got} (canonical: ${canonical})`,
      );
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log(`validate-registry: OK (${sigs.length} bundled signatures)`);
}

main();
