import type { DecodedCall, DecodedValue } from '../types/index.ts';

/**
 * Nested calls directly under `call` (decoded `bytes` anywhere in its arguments), in argument order. Calls nested
 * inside those are not included.
 */
export function childCalls(call: DecodedCall): DecodedCall[] {
  const out: DecodedCall[] = [];
  const visit = (v: DecodedValue): void => {
    if (v.kind === 'bytes') {
      if (v.decoded) out.push(v.decoded);
    } else if (v.kind === 'array') {
      v.elements.forEach(visit);
    } else if (v.kind === 'tuple') {
      v.fields.forEach(f => visit(f.value));
    }
  };
  call.params.forEach(p => visit(p.value));
  return out;
}

/**
 * Every call in the tree, depth-first in argument order (the order the tree renders them). A call's position in
 * this list is its `callIndex`, which warnings and the summary use to point at a tree node.
 */
export function listDecodedCalls(root: DecodedCall): DecodedCall[] {
  const out: DecodedCall[] = [];
  const walk = (c: DecodedCall): void => {
    out.push(c);
    childCalls(c).forEach(walk);
  };
  walk(root);
  return out;
}

/** DOM id of a call node in the decode tree. */
export function callNodeDomId(callIndex: number): string {
  return `call-node-${callIndex}`;
}

/**
 * The calls and values from `root` down to `target` (both included), or `[]` when `target` is not in the tree. The
 * tree opens exactly these nodes to bring `target` into view.
 */
export function pathToCall(root: DecodedCall, target: DecodedCall): object[] {
  const path: object[] = [];
  const inValue = (v: DecodedValue): boolean => {
    path.push(v);
    let found = false;
    if (v.kind === 'bytes') found = v.decoded != null && inCall(v.decoded);
    else if (v.kind === 'array') found = v.elements.some(inValue);
    else if (v.kind === 'tuple') found = v.fields.some(f => inValue(f.value));
    if (!found) path.pop();
    return found;
  };
  const inCall = (c: DecodedCall): boolean => {
    path.push(c);
    if (c === target || c.params.some(p => inValue(p.value))) return true;
    path.pop();
    return false;
  };
  return inCall(root) ? path : [];
}
