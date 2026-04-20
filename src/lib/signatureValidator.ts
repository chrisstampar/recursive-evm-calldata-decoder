/** Solidity shorthand in signatures; canonical forms are used for validation. */
const TYPE_ALIASES: Record<string, string> = {
  uint: 'uint256',
  int: 'int256',
  byte: 'bytes1',
};

function normalizeSolidityBaseType(base: string): string {
  return TYPE_ALIASES[base] ?? base;
}

const SOLIDITY_TYPES = new Set([
  'address', 'bool', 'string', 'bytes',
  'bytes1', 'bytes2', 'bytes3', 'bytes4', 'bytes5', 'bytes6', 'bytes7', 'bytes8',
  'bytes9', 'bytes10', 'bytes11', 'bytes12', 'bytes13', 'bytes14', 'bytes15', 'bytes16',
  'bytes17', 'bytes18', 'bytes19', 'bytes20', 'bytes21', 'bytes22', 'bytes23', 'bytes24',
  'bytes25', 'bytes26', 'bytes27', 'bytes28', 'bytes29', 'bytes30', 'bytes31', 'bytes32',
  'uint8', 'uint16', 'uint24', 'uint32', 'uint40', 'uint48', 'uint56', 'uint64',
  'uint72', 'uint80', 'uint88', 'uint96', 'uint104', 'uint112', 'uint120', 'uint128',
  'uint136', 'uint144', 'uint152', 'uint160', 'uint168', 'uint176', 'uint184', 'uint192',
  'uint200', 'uint208', 'uint216', 'uint224', 'uint232', 'uint240', 'uint248', 'uint256',
  'int8', 'int16', 'int24', 'int32', 'int40', 'int48', 'int56', 'int64',
  'int72', 'int80', 'int88', 'int96', 'int104', 'int112', 'int120', 'int128',
  'int136', 'int144', 'int152', 'int160', 'int168', 'int176', 'int184', 'int192',
  'int200', 'int208', 'int216', 'int224', 'int232', 'int240', 'int248', 'int256',
]);

/** M values for `fixedMxN` / `ufixedMxN` (multiple of 8, 8…256). */
const FIXED_M_BITS = [
  8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128,
  136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224, 232, 240, 248, 256,
] as const;

const FIXED_M_SET = new Set<number>(FIXED_M_BITS);

/**
 * Solidity identifier: ASCII `$` / letters / `_` / digits, or Unicode (Solidity 0.8+).
 * Used for function names, user-defined type names, and optional parameter / tuple field names.
 * Parsed separately from the parameter list via {@link splitTextSignatureParts}.
 */
export const SIGNATURE_IDENTIFIER_REGEX =
  /^(?:[a-zA-Z_$][a-zA-Z0-9_$]*|\p{ID_Start}\p{ID_Continue}*)$/u;

/** @deprecated Use {@link SIGNATURE_IDENTIFIER_REGEX}; kept for call-site clarity where “function name” is meant. */
export const SIGNATURE_FUNCTION_NAME_REGEX = SIGNATURE_IDENTIFIER_REGEX;

const MAX_TUPLE_DEPTH = 5;

/** Rejects pathological inputs before the main regex (dotall `(.*)` hardening). */
export const MAX_TEXT_SIGNATURE_LENGTH = 10000;

/** Max comma-separated parameters at one tuple / top level (DoS hardening). */
export const MAX_SIGNATURE_PARAMETERS_PER_LEVEL = 100;

/** Max fixed-array dimension length (Solidity requires > 0; cap avoids absurd sizes in downstream ABI paths). */
export const MAX_FIXED_ARRAY_SIZE = 2 ** 16;

/**
 * LRU-ish cap for parsed / validated signature caches.
 * Hot paths (e.g. repeated ERC-20 selectors) are covered by this cache; a separate allowlist fast path is optional.
 */
export const SIGNATURE_CACHE_MAX_ENTRIES = 512;

export type ValidationError =
  | { type: 'invalid_syntax'; message: string }
  /** `position` is the 0-based index among **top-level** comma-separated parameters; nested tuple fields reuse the enclosing argument’s index. */
  | { type: 'unknown_type'; typeName: string; position: number }
  | { type: 'excessive_tuple_depth'; maxDepth: number }
  | { type: 'invalid_array_size'; size: number }
  | { type: 'too_many_parameters'; count: number; max: number };

export type SignatureValidationResult =
  | { valid: true }
  | { valid: false; error: ValidationError };

export type ParsedTextSignature = { name: string; paramTypes: string[] };

/** Human-readable message for UI / logs. */
export function formatValidationError(error: ValidationError): string {
  switch (error.type) {
    case 'invalid_syntax':
      return error.message;
    case 'unknown_type':
      return `Unknown type "${error.typeName}" in parameter index ${error.position} (0-based top-level).`;
    case 'excessive_tuple_depth':
      return `Tuple nesting exceeds maximum depth (${error.maxDepth}).`;
    case 'invalid_array_size':
      return `Invalid fixed array size ${error.size}: must be between 1 and ${MAX_FIXED_ARRAY_SIZE} inclusive.`;
    case 'too_many_parameters':
      return `Too many parameters at one level (${error.count}); maximum is ${error.max}.`;
    default: {
      const _x: never = error;
      return String(_x);
    }
  }
}

/** Join multiple validation messages (e.g. {@link validateTextSignatureCollectErrors}). */
export function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors.map(formatValidationError).join('\n');
}

/**
 * Collapse whitespace around delimiters and between the function name and `(`.
 * Tuple bodies may still contain spaces before optional field names (e.g. `(uint256 amount, address to)`);
 * user-defined type names with interior spaces are not supported.
 */
export function normalizeSignatureWhitespace(sig: string): string {
  let s = sig.trim();
  s = s.replace(/\s*([(),])\s*/g, '$1');
  s = s.replace(/\s*(\[|\])\s*/g, '$1');
  s = s.replace(/^([^\s(]+)\s+\(/, '$1(');
  return s;
}

/**
 * Split `name(params)` using the outermost matching `(`…`)` pair.
 * Avoids dotall `(.*)` and supports Unicode or `$` in `name`.
 */
export function splitTextSignatureParts(textSignature: string): { name: string; paramsStr: string } | null {
  const s = textSignature.trim();
  const firstOpen = s.indexOf('(');
  if (firstOpen <= 0) return null;

  const name = s.slice(0, firstOpen).trim();
  if (!name) return null;

  let depth = 0;
  for (let i = firstOpen; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        const paramsStr = s.slice(firstOpen + 1, i);
        const tail = s.slice(i + 1).trim();
        if (tail !== '') return null;
        return { name, paramsStr };
      }
    }
  }
  return null;
}

function rejectIfSignatureTooLong(textSignature: string): { error: ValidationError } | null {
  if (textSignature.length > MAX_TEXT_SIGNATURE_LENGTH) {
    return {
      error: {
        type: 'invalid_syntax',
        message: `Text signature exceeds maximum length (${MAX_TEXT_SIGNATURE_LENGTH} characters).`,
      },
    };
  }
  return null;
}

function prepareTextSignature(raw: string): { normalized: string } | { invalid: { error: ValidationError } } {
  const a = rejectIfSignatureTooLong(raw);
  if (a) return { invalid: a };
  const normalized = normalizeSignatureWhitespace(raw);
  const b = rejectIfSignatureTooLong(normalized);
  if (b) return { invalid: b };
  return { normalized };
}

function touchLru<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

const validateCache = new Map<string, SignatureValidationResult>();
const parseCache = new Map<string, ParsedTextSignature | null>();
/** Parsed form for valid signatures, or `null` when invalid — avoids storing canonical strings twice. */
const canonicalParsedCache = new Map<string, ParsedTextSignature | null>();
const collectErrorsCache = new Map<string, ValidationError[]>();

/** Clears memoization maps (e.g. tests). */
export function clearSignatureValidatorCaches(): void {
  validateCache.clear();
  parseCache.clear();
  canonicalParsedCache.clear();
  collectErrorsCache.clear();
}

export function validateTextSignature(textSignature: string): SignatureValidationResult {
  const prep = prepareTextSignature(textSignature);
  if ('invalid' in prep) return { valid: false, error: prep.invalid.error };

  const { normalized } = prep;
  const hit = validateCache.get(normalized);
  if (hit !== undefined) return hit;

  const result = validateTextSignatureUncached(normalized);
  touchLru(validateCache, normalized, result, SIGNATURE_CACHE_MAX_ENTRIES);
  return result;
}

/**
 * Collect every validation issue (linter-style). Empty array means {@link validateTextSignature} would succeed.
 * Shares the same normalization and LRU cache as {@link validateTextSignature}.
 */
export function validateTextSignatureCollectErrors(textSignature: string): ValidationError[] {
  const prep = prepareTextSignature(textSignature);
  if ('invalid' in prep) return [prep.invalid.error];

  const { normalized } = prep;
  const hit = collectErrorsCache.get(normalized);
  if (hit !== undefined) return [...hit];

  const errors = validateTextSignatureCollectErrorsUncached(normalized);
  touchLru(collectErrorsCache, normalized, errors, SIGNATURE_CACHE_MAX_ENTRIES);
  return [...errors];
}

function validateTextSignatureUncached(textSignature: string): SignatureValidationResult {
  const hit = collectErrorsCache.get(textSignature);
  if (hit !== undefined) {
    return hit.length === 0 ? { valid: true } : { valid: false, error: hit[0]! };
  }
  const errors = validateTextSignatureCollectErrorsUncached(textSignature);
  touchLru(collectErrorsCache, textSignature, errors, SIGNATURE_CACHE_MAX_ENTRIES);
  return errors.length === 0 ? { valid: true } : { valid: false, error: errors[0]! };
}

function validateTextSignatureCollectErrorsUncached(textSignature: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const parts = splitTextSignatureParts(textSignature);
  if (!parts) {
    errors.push({
      type: 'invalid_syntax',
      message:
        'Expected text signature like name(type1,type2) with balanced outer parentheses and a non-empty function name.',
    });
    return errors;
  }

  const { name: fnName, paramsStr } = parts;
  if (!SIGNATURE_IDENTIFIER_REGEX.test(fnName)) {
    errors.push({ type: 'invalid_syntax', message: `Invalid function name "${fnName}".` });
    return errors;
  }
  if (paramsStr.trim() === '') return errors;

  const top = splitTopLevelParams(paramsStr);
  if (top.length > MAX_SIGNATURE_PARAMETERS_PER_LEVEL) {
    errors.push({ type: 'too_many_parameters', count: top.length, max: MAX_SIGNATURE_PARAMETERS_PER_LEVEL });
    return errors;
  }
  for (let i = 0; i < top.length; i++) {
    const t = stripTrailingSolidityParameterName(top[i].trim());
    if (t === '') {
      errors.push({ type: 'invalid_syntax', message: 'Empty parameter in list (e.g. double comma).' });
      continue;
    }
    collectSingleTypeErrors(t, 0, i, errors);
  }
  return errors;
}

type ValidateCtx = { rootParamIndex: number };

function validateParamTypes(paramsStr: string, depth: number, ctx: ValidateCtx): SignatureValidationResult {
  if (depth > MAX_TUPLE_DEPTH) {
    return { valid: false, error: { type: 'excessive_tuple_depth', maxDepth: MAX_TUPLE_DEPTH } };
  }

  const types = splitTopLevelParams(paramsStr);
  if (types.length > MAX_SIGNATURE_PARAMETERS_PER_LEVEL) {
    return {
      valid: false,
      error: { type: 'too_many_parameters', count: types.length, max: MAX_SIGNATURE_PARAMETERS_PER_LEVEL },
    };
  }
  for (let i = 0; i < types.length; i++) {
    const t = types[i].trim();
    if (t === '') {
      return { valid: false, error: { type: 'invalid_syntax', message: 'Empty tuple field (e.g. double comma).' } };
    }
    const r = validateSingleType(t, depth, ctx);
    if (!r.valid) return r;
  }
  return { valid: true };
}

function collectParamTypesErrors(
  paramsStr: string,
  depth: number,
  rootParamIndex: number,
  errors: ValidationError[],
): void {
  if (depth > MAX_TUPLE_DEPTH) {
    errors.push({ type: 'excessive_tuple_depth', maxDepth: MAX_TUPLE_DEPTH });
    return;
  }

  const types = splitTopLevelParams(paramsStr);
  if (types.length > MAX_SIGNATURE_PARAMETERS_PER_LEVEL) {
    errors.push({ type: 'too_many_parameters', count: types.length, max: MAX_SIGNATURE_PARAMETERS_PER_LEVEL });
    return;
  }
  for (let i = 0; i < types.length; i++) {
    const t = stripTrailingSolidityParameterName(types[i].trim());
    if (t === '') {
      errors.push({ type: 'invalid_syntax', message: 'Empty tuple field (e.g. double comma).' });
      continue;
    }
    collectSingleTypeErrors(t, depth, rootParamIndex, errors);
  }
}

function collectSingleTypeErrors(
  typeStr: string,
  depth: number,
  rootParamIndex: number,
  errors: ValidationError[],
): void {
  let base = stripTrailingSolidityParameterName(typeStr.trim());

  while (base.endsWith('[]')) {
    base = base.slice(0, -2).trimEnd();
  }

  const fixedArrayMatch = base.match(/^(.+)\[(\d+)\]$/);
  if (fixedArrayMatch) {
    const digits = fixedArrayMatch[2];
    const sizeParsed = parseFixedArrayDimension(digits);
    if (sizeParsed === null) {
      errors.push({ type: 'invalid_array_size', size: Number.parseInt(digits, 10) || 0 });
      return;
    }
    collectSingleTypeErrors(fixedArrayMatch[1], depth, rootParamIndex, errors);
    return;
  }

  const fnPtr = trySplitFunctionPointerType(base);
  if (fnPtr) {
    collectParamTypesErrors(fnPtr.paramsStr, depth, rootParamIndex, errors);
    return;
  }

  if (base.startsWith('(') && base.endsWith(')')) {
    collectParamTypesErrors(base.slice(1, -1), depth + 1, rootParamIndex, errors);
    return;
  }

  if (isValidFixedMxN(base)) return;

  const lower = base.toLowerCase();
  if ((/^uint\d+$/.test(lower) || /^int\d+$/.test(lower)) && !SOLIDITY_TYPES.has(lower)) {
    errors.push({ type: 'unknown_type', typeName: base, position: rootParamIndex });
    return;
  }

  if (/^u?fixed/i.test(base)) {
    errors.push({ type: 'unknown_type', typeName: base, position: rootParamIndex });
    return;
  }

  const canon = normalizeSolidityBaseType(base);
  if (SOLIDITY_TYPES.has(canon)) return;

  if (SIGNATURE_IDENTIFIER_REGEX.test(base)) return;

  errors.push({ type: 'unknown_type', typeName: base, position: rootParamIndex });
}

/** After `function(...)`, allow any non-empty sequence of Solidity visibility/state mutability keywords (order not enforced—this is calldata validation, not a compiler). */
const FUNCTION_POINTER_TAIL = /^(?:\s+(?:external|internal|view|pure|payable))+$/i;

/**
 * Trailing tokens that look like identifiers but are Solidity keywords / data locations — do not strip as a “parameter name”
 * (e.g. `function(uint256) external` must keep `external`).
 */
const NON_PARAM_NAME_TAIL = /^(external|internal|view|pure|payable|memory|storage|calldata)$/i;

/**
 * Strip one trailing Solidity-style parameter / tuple field name (`type name`) when `name` matches {@link SIGNATURE_IDENTIFIER_REGEX}
 * and is not a reserved tail keyword. No-op if the string has no trailing identifier token.
 */
export function stripTrailingSolidityParameterName(typeStr: string): string {
  const s = typeStr.trim();
  const m = s.match(/^(.*\S)\s+(\S+)$/u);
  if (!m) return s;
  const candidateName = m[2];
  if (NON_PARAM_NAME_TAIL.test(candidateName)) return s;
  if (!SIGNATURE_IDENTIFIER_REGEX.test(candidateName)) return s;
  return m[1].trimEnd();
}

/** `function (t1,t2) external` / `function() internal` style external function types. */
function trySplitFunctionPointerType(base: string): { paramsStr: string; tail: string } | null {
  const trimmed = base.trim();
  const kw = trimmed.match(/^function\s*\(/i);
  if (!kw) return null;

  const fromOpen = trimmed.slice(kw[0].length - 1);
  let depth = 0;
  let closeIdx = -1;
  for (let i = 0; i < fromOpen.length; i++) {
    const c = fromOpen[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) return null;

  const paramsStr = fromOpen.slice(1, closeIdx);
  const tail = fromOpen.slice(closeIdx + 1).trim();
  if (tail !== '' && !FUNCTION_POINTER_TAIL.test(' ' + tail)) return null;

  return { paramsStr, tail };
}

function isValidFixedMxN(base: string): boolean {
  const m = base.match(/^(u?)fixed(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)x(\d+)$/i);
  if (!m) return false;
  const M = Number.parseInt(m[2], 10);
  const N = Number.parseInt(m[3], 10);
  if (!FIXED_M_SET.has(M) || !Number.isSafeInteger(N) || N < 0 || N > M) return false;
  return true;
}

function validateSingleType(typeStr: string, depth: number, ctx: ValidateCtx): SignatureValidationResult {
  let base = stripTrailingSolidityParameterName(typeStr.trim());

  while (base.endsWith('[]')) {
    base = base.slice(0, -2).trimEnd();
  }

  const fixedArrayMatch = base.match(/^(.+)\[(\d+)\]$/);
  if (fixedArrayMatch) {
    const digits = fixedArrayMatch[2];
    const sizeParsed = parseFixedArrayDimension(digits);
    if (sizeParsed === null) {
      return {
        valid: false,
        error: {
          type: 'invalid_array_size',
          size: Number.parseInt(digits, 10) || 0,
        },
      };
    }
    return validateSingleType(fixedArrayMatch[1], depth, ctx);
  }

  const fnPtr = trySplitFunctionPointerType(base);
  if (fnPtr) {
    return validateParamTypes(fnPtr.paramsStr, depth, ctx);
  }

  if (base.startsWith('(') && base.endsWith(')')) {
    return validateParamTypes(base.slice(1, -1), depth + 1, ctx);
  }

  if (isValidFixedMxN(base)) {
    return { valid: true };
  }

  const lower = base.toLowerCase();
  if ((/^uint\d+$/.test(lower) || /^int\d+$/.test(lower)) && !SOLIDITY_TYPES.has(lower)) {
    return {
      valid: false,
      error: { type: 'unknown_type', typeName: base, position: ctx.rootParamIndex },
    };
  }

  if (/^u?fixed/i.test(base)) {
    return {
      valid: false,
      error: { type: 'unknown_type', typeName: base, position: ctx.rootParamIndex },
    };
  }

  const canon = normalizeSolidityBaseType(base);
  if (SOLIDITY_TYPES.has(canon)) {
    return { valid: true };
  }

  if (SIGNATURE_IDENTIFIER_REGEX.test(base)) {
    return { valid: true };
  }

  return {
    valid: false,
    error: { type: 'unknown_type', typeName: base, position: ctx.rootParamIndex },
  };
}

/** Returns numeric size if digits are a valid fixed dimension, else null. */
function parseFixedArrayDimension(digits: string): number | null {
  if (!/^\d+$/.test(digits) || digits.length > 20) return null;
  const n = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_FIXED_ARRAY_SIZE) return null;
  return n;
}

function splitTopLevelParams(paramsStr: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of paramsStr) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}

/**
 * Expand Solidity type aliases (`uint`→`uint256`, etc.) throughout a parameter type,
 * including nested tuples and array suffixes. Matches validation stripping order.
 * Only call on signatures that already passed {@link validateTextSignature}, or on trusted inputs.
 */
export function normalizeSignatureParamType(typeStr: string): string {
  let s = stripTrailingSolidityParameterName(typeStr.trim());
  const dynamicSuffixes: string[] = [];
  while (s.endsWith('[]')) {
    dynamicSuffixes.push('[]');
    s = s.slice(0, -2).trimEnd();
  }
  const fixedArrayMatch = s.match(/^(.+)\[(\d+)\]$/);
  if (fixedArrayMatch) {
    const inner = normalizeSignatureParamType(fixedArrayMatch[1]);
    return `${inner}[${fixedArrayMatch[2]}]${dynamicSuffixes.join('')}`;
  }

  const fnPtr = trySplitFunctionPointerType(s);
  if (fnPtr) {
    const innerNorm = splitTopLevelParams(fnPtr.paramsStr)
      .map(p => normalizeSignatureParamType(stripTrailingSolidityParameterName(p.trim())))
      .join(',');
    const tail = fnPtr.tail.trim();
    const fnPart = `function(${innerNorm})${tail ? ` ${tail}` : ''}`;
    return `${fnPart}${dynamicSuffixes.join('')}`;
  }

  if (s.startsWith('(') && s.endsWith(')')) {
    const inner = s.slice(1, -1);
    if (inner.trim() === '') {
      return `()${dynamicSuffixes.join('')}`;
    }
    const parts = splitTopLevelParams(inner);
    const norm = `(${parts.map(p => normalizeSignatureParamType(stripTrailingSolidityParameterName(p.trim()))).join(',')})`;
    return `${norm}${dynamicSuffixes.join('')}`;
  }
  return `${normalizeSolidityBaseType(s)}${dynamicSuffixes.join('')}`;
}

function parseTextSignatureUncached(normalized: string): ParsedTextSignature | null {
  const parts = splitTextSignatureParts(normalized);
  if (!parts) return null;

  const { name, paramsStr } = parts;
  if (paramsStr.trim() === '') return { name, paramTypes: [] };

  const slots = splitTopLevelParams(paramsStr);
  if (slots.length > MAX_SIGNATURE_PARAMETERS_PER_LEVEL) return null;

  const paramTypes = slots.map(t => normalizeSignatureParamType(t.trim()));
  return { name, paramTypes };
}

function formatCanonicalFromParsed(parsed: ParsedTextSignature): string {
  return parsed.paramTypes.length === 0 ? `${parsed.name}()` : `${parsed.name}(${parsed.paramTypes.join(',')})`;
}

/** Rebuild signature with canonical types so keccak matches Solidity / on-chain selectors. */
export function canonicalizeTextSignature(textSignature: string): string | null {
  const prep = prepareTextSignature(textSignature);
  if ('invalid' in prep) return null;
  const { normalized } = prep;

  const shared = canonicalParsedCache.get(normalized);
  if (shared !== undefined) {
    return shared === null ? null : formatCanonicalFromParsed(shared);
  }

  const parseHit = parseCache.get(normalized);
  if (parseHit !== undefined) {
    touchLru(canonicalParsedCache, normalized, parseHit, SIGNATURE_CACHE_MAX_ENTRIES);
    return parseHit === null ? null : formatCanonicalFromParsed(parseHit);
  }

  if (validateTextSignatureCollectErrorsUncached(normalized).length > 0) {
    touchLru(canonicalParsedCache, normalized, null, SIGNATURE_CACHE_MAX_ENTRIES);
    touchLru(parseCache, normalized, null, SIGNATURE_CACHE_MAX_ENTRIES);
    return null;
  }

  const fresh = parseTextSignatureUncached(normalized);
  touchLru(canonicalParsedCache, normalized, fresh, SIGNATURE_CACHE_MAX_ENTRIES);
  touchLru(parseCache, normalized, fresh, SIGNATURE_CACHE_MAX_ENTRIES);
  return fresh === null ? null : formatCanonicalFromParsed(fresh);
}

export function parseTextSignature(textSignature: string): ParsedTextSignature | null {
  const prep = prepareTextSignature(textSignature);
  if ('invalid' in prep) return null;
  const { normalized } = prep;

  const hit = parseCache.get(normalized);
  if (hit !== undefined) {
    return hit === null ? null : { name: hit.name, paramTypes: [...hit.paramTypes] };
  }

  const shared = canonicalParsedCache.get(normalized);
  if (shared !== undefined) {
    touchLru(parseCache, normalized, shared, SIGNATURE_CACHE_MAX_ENTRIES);
    return shared === null ? null : { name: shared.name, paramTypes: [...shared.paramTypes] };
  }

  if (validateTextSignatureCollectErrorsUncached(normalized).length > 0) {
    touchLru(parseCache, normalized, null, SIGNATURE_CACHE_MAX_ENTRIES);
    touchLru(canonicalParsedCache, normalized, null, SIGNATURE_CACHE_MAX_ENTRIES);
    return null;
  }

  const fresh = parseTextSignatureUncached(normalized);
  touchLru(parseCache, normalized, fresh, SIGNATURE_CACHE_MAX_ENTRIES);
  touchLru(canonicalParsedCache, normalized, fresh, SIGNATURE_CACHE_MAX_ENTRIES);
  return fresh === null ? null : { name: fresh.name, paramTypes: [...fresh.paramTypes] };
}
