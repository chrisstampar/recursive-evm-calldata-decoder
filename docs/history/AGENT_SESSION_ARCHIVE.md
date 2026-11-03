# rec_dec — session history

Dated entries trimmed out of `AGENT_SESSION_CONTEXT.md` to keep it readable as a catch-up
file. Oldest first. Also in git history, and summarised in SHKG session records.

### 2026-03-25: Initial Build

- Scaffolded project with Vite + React + TypeScript + Tailwind CSS + ethers.js v6
- Built core decode engine with recursive calldata expansion
- Implemented 3-tier signature resolution: bundled ABIs -> openchain.xyz API -> 4byte.directory API
- Bundled ABIs for ~40 common selectors (Multicall2/3, Uniswap V2/V3/Universal Router, ERC20/721/1155, WETH, Aave V3, Gnosis Safe, etc.)
- Known contract address registry with labels (WETH, DAI, USDC, USDT, major DEX routers, etc.)
- Smart value formatting: checksummed addresses with Etherscan links, uint256 as token amounts (18 decimals), Unix timestamps as dates, max uint256 detection
- Security: strict hex validation, CSP meta tag, no dangerouslySetInnerHTML, signature format validation, API timeout, recursion depth cap
- Tree view UI with expand/collapse, color-coded type badges, confidence indicators, copy buttons
- URL hash sharing (calldata stored in URL fragment for sharing)
- JSON export view
- Offline mode toggle (bundled ABIs only, no API calls)
- Optional user ABI paste for guaranteed-correct decoding
- Fixed tuple array handling order bug (tuple arrays must be checked before generic arrays for calldata hint propagation)
- Build output: 286 KB gzipped to 88 KB

### 2026-03-25: Transaction Hash Lookup

- Added tx hash input mode: users can paste an Ethereum transaction hash instead of raw calldata
- The tool fetches calldata via public Ethereum RPC (eth_getTransactionByHash)
- Falls through 4 RPC endpoints: llamarpc, ankr, publicnode, 1rpc
- Shows transaction info bar with From/To addresses (with known contract labels), ETH value, and Etherscan links
- Updated CSP to allow RPC endpoint connections
- Key file: `src/lib/txFetcher.ts`

### 2026-03-26: `valueFormatter` — timestamp / uint256 / bytes32 hardening

- **`formatUint256`**: Unix timestamp hint only when the decimal string is **exactly 10 digits** and **1_000_000_000 ≤ value ≤ 9_999_999_999** (drops 9-digit false positives such as early-2001 seconds vs token-ish magnitudes in the old wide window). Removed the **18-decimal** uint256 interpretation (misleading for USDC/WBTC etc.); use **`formatTokenAmount`** with registry/RPC decimals where context exists.
- **`hexToAscii`**: require **even-length** hex and **`/^[0-9a-fA-F]*$/`** before **`parseInt`**, else empty string (no bogus ASCII from **`gg`** or odd nibbles).
- **`formatBytes32`**: truncate **`display`** only when string length **> 66** (`0x` + 64 nibbles); append **`(N bytes)`** using half the payload nibble count (not **`hex.length/2 - 1`**).
- **`tryFormatUint256(unknown)`**: returns **`null`** if not a string; otherwise **`formatUint256`** result (optional **`interpretation`**), or **`{ display, error }`** on thrown errors.
- **`formatTokenAmount`**: **`decimals === 0`** uses whole-unit interpretation (no **`.123`** bug); **`symbol`** passed through **`sanitizeDecodedString`** (trim, control strip, 32-char cap) with fallback label **`TOKEN`**.
- **Tests**: **`valueFormatter.test.ts`** — `978307200` not a timestamp; `1700000000` is; large int no 18-decimal line; **`formatBytes32`** invalid hex has no **`asString`**; full bytes32 not truncated; longer hex truncated with byte count; **`tryFormatUint256`** / zero-decimals / symbol sanitization; **`0`**, **`0x`**, **`MAX_UINT256`** edge cases; integer display via **`Intl.NumberFormat`** with **`useGrouping: false`** (plain digits).
- **Docs / formatting**: **`formatUint256`** JSDoc (inputs, heuristics, never throws); **`Intl.NumberFormat`** + **`BigInt`** for exact integer formatting without thousands separators.

### 2026-03-26: `knownPatterns` polish (portable test env, multisend cap, grouping, permit docs)

- **Duplicate-pattern `console.warn`**: uses `process.env.NODE_ENV === 'test'` (via `isTestRuntime`) instead of Vite-only `import.meta.env.MODE`.
- **`DEFAULT_MAX_MULTISEND_OPERATIONS`**: **20** for Gnosis `multiSend` (bundled pattern sets `maxOperations`; decoder fallback uses same constant). **`DEFAULT_MAX_PATTERN_ARRAY_EXPAND`** remains **200** for `bytes[]` / tuple batches.
- **`PATTERNS`**: grouped with section comments (Uniswap + Universal Router, Multicall2/3, Gnosis Safe, OZ forwarder, DEX/settlement, Pendle, Contango).
- **File JSDoc**: Permit2 + **EIP-2612 `permit`** — structured approvals, not nested calldata trees.

### 2026-03-26: Docs + decoder tests (`knownPatterns` + `decoder` + `decoder.test`)

- **`CalldataIndex`**: block JSDoc for **0-based** `paramIndex` / `fieldIndex`, examples (`aggregate3`, `multicall`, `multiSend`, `execTransaction`), and note that `decoder.ts` checks Solidity types before expanding.
- **`decodeCalldata`**: JSDoc distinguishes **`depth`** (every nested frame) vs **`patternNestingDepth`** (pattern-driven expansions only).
- **`convertGnosisMultiSend`**: JSDoc table for packed segment layout and misalignment behavior.
- **`direct` calldata hints**: only expand when `isDynamicBytesSolidityType` passes (defense when hints target a non-`bytes` slot).
- **`decoder.test`**: empty `multicall([])`; self-nested multicall vs nest cap; `multiSend` 0 / 1 / max+1 operations; incompatible user ABI → `error` (fail-soft).

### 2026-03-26: Security — pattern risk flags + nested array caps (`knownPatterns` + `decoder` + `warningAnalyzer` + `App`)

- **`MulticallPattern`**: optional **`riskLevel`** (`low` | `medium` | `high`) and **`description`**; high for Gnosis **`multiSend`**, **`execTransaction`**, **`execTransactionFromModule`**; medium for routers / multicalls / forwarder / CoW / Pendle / Contango / 1inch.
- **`analyzeWarnings`**: emits **Sensitive pattern** warnings (severity from risk level), **deduped by selector** across the decoded tree.
- **`CalldataIndex`**: **`array-direct`** supports **`maxArrayLength`**; **`tuple-field`** supports **`maxArrayLength`** (tuple row cap); **`gnosis-multisend`** supports **`maxOperations`**. Defaults use **`DEFAULT_MAX_PATTERN_ARRAY_EXPAND`** (200).
- **`DecodeOptions.decodeWarningSink`**: decoder appends **`TxWarning`** when **`bytes[]`** / **`tuple[]`** (with tuple-field calldata) / **`multiSend`** payloads are truncated; **`App`** merges sink + **`analyzeWarnings`**.
- **Tests**: **`decoder.test.ts`** (bytes[] cap); **`abiRegistry.test.ts`** / **`warningAnalyzer`** pattern + dedupe; **`knownPatterns.test.ts`** risk tags.
- **`tryDecode`**: decode **flat `paramTypes` first**; tuple fallback wraps a single top-level param as **`[inner]`** so `multicall(bytes[])` and large `bytes[]` stay aligned with **`processDecodedParams`** (fixes wrong branch that treated dynamic array elements as top-level params).

### 2026-03-26: Multicall patterns + calldata hint validation (`knownPatterns` + `decoder` + `abiRegistry`)

- **New patterns**: Gnosis **`execTransactionFromModule`** (`0x468721a7`); 1inch **`swap`** (`0x12aa3caf`, two **`bytes`**); OZ ERC2771Forwarder **`execute`** (`0xdf905caf`) and **`executeBatch`** (`0xccf96b4a`, tuple-field on **`bytes`** slots); CoW **`settle`** (`0x13d79a0b`, interaction **`callData`**).
- **`CalldataIndex` / `tuple-field`**: optional **`expectedParentType`** (`tuple[]` | `tuple`) and **`expectedFieldType: 'bytes'`**; **`decoder`** filters hints by parent Solidity type and skips calldata expansion when the resolved field is not dynamic **`bytes`**.
- **Fixed-size ABI arrays** `T[k]` in **`convertValue`** (before tuple-of-dynamic-arrays handling) so **`(address,uint256,bytes)[][3]`** (CoW interactions) decodes and expands nested calls.
- **Duplicate pattern selectors**: **`console.warn`** when a later pattern overwrites (skipped in **`MODE === 'test'`**); last entry still wins.
- **Bundled** CoW **`settle`** signature in **`abiRegistry.ts`**; JSDoc note that **Permit2 `permit`** is intentionally not a multicall pattern.
- **Tests**: **`src/lib/decoder.test.ts`** (settle + forwarder nested decode); **`knownPatterns.test.ts`** extended for new selectors.

### 2026-03-26: `knownPatterns` — Gnosis multiSend docs, selector validation, UI flag

- **`requiresSpecialHandling`** on **`MulticallPattern`**; **`multiSend`** (`0x8d80ff0a`) set true; file JSDoc describes packed segment layout
- Module init: **`isValidFunctionSelector`** on every pattern; map keys + stored **`selector`** lowercased; typos throw
- **`build/validateRegistry.ts`**: side-import **`knownPatterns`** so CI/build fails on invalid pattern selectors
- **`convertGnosisMultiSend`**: **`dataLength`** via **`BigInt`**, capped at **`MAX_INPUT_BYTES`** / **`MAX_SAFE_INTEGER`**; JSDoc on packed format
- **`DecodeTree`**: amber info when **`getKnownPattern(call.selector)?.requiresSpecialHandling`**

### 2026-03-26: Multicall / known-pattern nesting limits (`knownPatterns` + `decoder`)

- **`MulticallPattern`**: optional **`maxRecursionDepth`**, **`allowRecursive`** (default true); **`DEFAULT_MULTICALL_PATTERN_NEST_LIMIT`** = 5
- **`DecodeOptions.multicallNestLimit`** (default **5** in **`DEFAULT_DECODE_OPTIONS`**): caps pattern-driven nested calldata decodes together with **`maxDepth`** and per-pattern **`maxRecursionDepth`**
- **`decodeCalldata(..., patternNestingDepth)`**: increments only for pattern-marked **`bytes`** / Gnosis **`multiSend`** inner calls; **`allowRecursive: false`** skips expanding inner calldata when its selector is another known multicall
- **`knownPatterns.test.ts`**: smoke checks for default limit + multicall selector

### 2026-03-26: `signatureLookup` — selector validation + API cache hardening

- **`isValidFunctionSelector`** in **`sanitize.ts`** (same rule as **`extractSelector`** prefix: `0x` + 8 hex, trim + lower)
- **`MAX_USER_ABI_JSON_CHARS`** (500k): **`lookupSelectorFromUserAbi`** rejects oversized pasted ABI before **`JSON.parse`**
- **`lookupSelector`** / **`lookupSelectorFromUserAbi`**: early **`[]`** if invalid — avoids LRU pollution and bad fetch URLs
- **OpenChain / 4byte**: only keep rows where **`textSigToFunctionSignature`**’s keccak (canonical) equals the requested selector; no longer trust API text under an arbitrary key
- **`lru-cache`**: selector API LRU (**`max: 512`**, **~15m TTL**, **`ttlAutopurge`**, **`updateAgeOnGet`**) for merged remote results
- **API merge**: **`Promise.all`** Sourcify + OpenChain + 4byte, then **`dedupeApiSignaturesByTextSignature`** (Sourcify wins on duplicate text)
- **Zod** (`zod`): **`SignatureDatabaseLookupResponseSchema`** (OpenChain + Sourcify) / **`FourbyteResponseSchema`**; extra row fields (e.g. **`filtered`**) stripped by object parsing
- **Sourcify**: third parallel source **`https://api.4byte.sourcify.dev/signature-database/v1/lookup`** (OpenChain-compatible path, not **`/v1/lookup`**); merge order **Sourcify → OpenChain → 4byte** (dedupe keeps first); **`SignatureSource`** includes **`sourcify`**
- **`warmCache(selectors, options?)`**: prewarms selector LRU; **`lookupSelectorFromUserAbi`**: optional **`onNonCanonicalSelector`**; **`DecodeOptions.onUserAbiNonCanonicalSelector`**
- Dev-only **`console.debug`** on merge dedupe (skipped when **`MODE === 'test'`**); JSDoc note on optional stale-while-revalidate via **`lru-cache`** later
- **`LookupOptions`**: **`offlineMode`** + optional **`onError(source, error)`**; **`DecodeOptions.onSignatureLookupError`** forwarded from **`decodeCalldata`**
- **Selector cache**: versioned keys (**`SIGNATURE_LOOKUP_CACHE_VERSION`** — bump when bundled signatures change); **15m TTL** for merged API results only; **bundled hits are not LRU-cached** (always read live from the registry)
- **User ABI**: **`USER_ABI_INTERFACE_CACHE`** (LRU 32, 1h TTL) keys **`keccak256(abiJson)`**; **`clearSelectorLookupCache`** clears both LRUs
- **`clearSelectorLookupCache`** export for tests; Vitest stubs **`fetch`** for poison + happy-path rows

### 2026-03-26: `lookupSelectorFromUserAbi` — overloaded functions

- **`signatureLookup.ts`**: use **`fnFragment.selector`** instead of **`iface.getFunction(name)?.selector`** (name-only resolution picked the first overload)
- **`signatureLookup.test.ts`**: two `foo` overloads; assert each selector returns a single **`FunctionSignature`** with the correct **`textSignature`**

### 2026-03-26: Build-time registry validation + canonical selector checks

- **`build/validateRegistry.ts`**: `validateTextSignature` + `canonicalizeTextSignature` + `keccak256(toUtf8Bytes(canonical))` vs each bundled `selector`; **`npm run validate-registry`**; **`build`** prepends this step
- **`abiRegistry`**: load-time selector check now uses **canonical** text (same as lookup / OpenChain), not raw `textSignature` bytes
- **`signatureValidator`**: JSDoc on **`unknown_type.position`** (0-based top-level param index); note on LRU vs optional allowlist fast path; regex lint fix in **`normalizeSignatureWhitespace`**
- Dev dependency: **`tsx`**

### 2026-03-26: `signatureValidator` — Unicode names, split parse, bundled validation

- **`splitTextSignatureParts`**: outer paren scan replaces dotall `^…\((.*)\)$` for `name` / `params` (Unicode-safe names, `$` still allowed via **`SIGNATURE_FUNCTION_NAME_REGEX`** = ASCII arm + **`\p{ID_Start}\p{ID_Continue}*`** / `u`)
- **`normalizeSignatureWhitespace`**: `^([^\s(]+)\s+\(` collapse works for non-ASCII names
- **`abiRegistry`**: load loop now **`validateTextSignature`** + **`formatValidationError`** before selector / **`parseTextSignature`** / param-type alignment (build-time guard for manual registry mistakes)
- Tests: `func(uint)`, `func(uint256[0])`, nested tuple, `func()`, >10KiB; Cyrillic name

### 2026-03-26: `signatureValidator` — memoization, whitespace, extended types

- **`normalizeSignatureWhitespace`**: trims; strips spaces around `()`, `[]`, `,`; collapses spaces before the argument `(` after the function name
- **LRU-bounded caches** (`SIGNATURE_CACHE_MAX_ENTRIES` = 512): **`validateTextSignature`**, **`parseTextSignature`**, **`canonicalizeTextSignature`**; **`clearSignatureValidatorCaches()`** for tests
- **Types**: external **`function(T...) external|internal|…`** pointers; **`fixedMxN` / `ufixedMxN`** (M in 8…256 step 8, N ≤ M); **`MyStruct`**-style identifiers (but invalid `uint257` / malformed `fixed…` stay **`unknown_type`**)
- **`normalizeSignatureParamType`**: normalizes function pointer internals + aliases

### 2026-03-26: `signatureValidator` — ReDoS / parameter-bomb limits

- **`MAX_TEXT_SIGNATURE_LENGTH`** (10000): checked before the dotall main regex in **`validateTextSignature`**, **`parseTextSignature`**, **`canonicalizeTextSignature`**
- **`MAX_SIGNATURE_PARAMETERS_PER_LEVEL`** (100): top-level and tuple field lists; **`too_many_parameters`** **`ValidationError`** + **`formatValidationError`**
- Tests: oversized string, 101 top-level params, 101 tuple fields

### 2026-03-26: `signatureValidator` — fixed-array bounds + structured errors

- **`validateTextSignature`** returns **`{ valid: true } | { valid: false; error: ValidationError }`** (`invalid_syntax`, `unknown_type` + 0-based top-level param index, `excessive_tuple_depth`, `invalid_array_size`)
- **`formatValidationError`**, **`MAX_FIXED_ARRAY_SIZE`** (65536): fixed dimensions must be **1…65536**, digit strings capped (reject absurd lengths); **`parseFixedArrayDimension`** uses safe integer checks
- **Recursive fixed-array peeling** so multi-dim types (e.g. `uint256[5][5]`) validate correctly
- **`signatureLookup`**: uses `.valid` on the new result

### 2026-03-26: `signatureValidator` — Solidity type aliases

- **`uint` → `uint256`**, **`int` → `int256`**, **`byte` → `bytes1`** in validation (including nested tuples / arrays)
- **`normalizeSignatureParamType`**, **`canonicalizeTextSignature`**: `parseTextSignature` returns canonical types; **`signatureLookup`** hashes **`canonicalizeTextSignature(textSig)`** so selectors match on-chain when APIs use aliases
- **`src/lib/signatureValidator.test.ts`**: alias validation, parse normalization, selector equality `m(uint)` vs `m(uint256)`

### 2026-03-26: Registry invariant tests + security watchlist

- **`abiRegistry.invariants.test.ts`**: re-validates bundled **selector ↔ keccak(textSignature)**; **no duplicate (selector, textSignature)** rows; **EIP-55** rules on static address literals (mixed-case must be valid checksum); **no duplicate normalized addresses per chain** (contracts / tokens); **implementationSlot** shape for proxies
- **`securityWatchlist.ts`**: **`RegistrySecurityWatchlistEntry`** with **`SecurityWatchlistRiskLevel`**, **`SecurityWatchlistCategory`**, optional **`effectiveFromBlock`** / **`deprecatedAtBlock`** / **`referenceUrl`** / **`incidentReferenceUrl`**; **`SECURITY_WATCHLIST_SCHEMA_VERSION`**; **`registryMeetsWatchlistRisk`**. Rows for **Ethereum + Polygon, Arbitrum, Optimism, Base** (Aave V3, Permit2, Safe). Still **bundle-only** (no remote hot-patch). **`ContractRiskLevel`** adds **`critical`**; lending + Permit2 use it; warnings use **danger** tier.
- **`abiRegistry.ts`**: test hooks **`getBundledSignaturesForTests`**, **`iterateStaticRegistryAddressLiterals`**, **`iterateKnownContractRegistryRows`**; fixed **Convex cvxCRV Wrapper** map key to valid EIP-55

### 2026-03-26: Contract registry `riskLevel` / `verified` + tx `to` warnings

- **`ContractRegistryEntry`**: optional **`riskLevel?: 'low' | 'medium' | 'high'`** (`ContractRiskLevel`), **`verified?: boolean`** (explorer verification when known; static rows usually omit it)
- **`ContractInfo`**: type alias for **`ContractRegistryEntry`**
- Mainnet rows tagged **`riskLevel: 'high'`** (heuristic): Aave V3 Pool, Aave V2 Lending Pool, Permit2, Uniswap Universal Routers, 1inch V5, Gnosis Safe, Curve Router v1.2, Pendle RouterV4
- **`analyzeWarnings`**: when **`txTo`** resolves a registry entry with **`riskLevel`**, adds **info/warning** banner (`High-sensitivity contract` for high); optional explorer note if **`verified`** is set
- Tests: **`abiRegistry.test.ts`** (Aave V2/V3 **`riskLevel`**, high-sensitivity warning)
- Files: **`abiRegistry.ts`**, **`warningAnalyzer.ts`**, **`abiRegistry.test.ts`**

### 2026-03-26: Sanitize tests (Vitest)

- Added **Vitest** (`vitest.config.ts`), scripts `test` / `test:watch`
- `src/lib/sanitize.test.ts`: hex validation edge cases (odd length, invalid chars, 1 MB boundary, selector-only / too-short), `extractSelector`, `isValidAbiJson` ABI shape cases
- Exported `MAX_INPUT_BYTES` from `sanitize.ts` for tests and documentation

### 2026-03-26: Bundled selector integrity (`abiRegistry.ts`)

- On module load, every `BUNDLED_SIGNATURES` row is checked: `keccak256(toUtf8Bytes(canonicalizeTextSignature(textSignature))).slice(0,10)` must equal `selector` (case-insensitive). Mismatch **throws** so typos fail build/tests immediately. **`npm run validate-registry`** repeats the same checks via `tsx`.
- `src/lib/abiRegistry.test.ts` smoke-imports registry + checks `transfer` selector lookup.

### 2026-03-26: Registry EIP-55 map (`abiRegistry.ts`)

- `KNOWN_CONTRACTS_RAW` / `KNOWN_TOKENS_RAW` unchanged (lowercase keys in source); at load, `Map` keys are **`getAddress(key.toLowerCase())`** (EIP-55).
- `getContractName` / `getTokenInfo` use **`getAddress(address.toLowerCase())`** so lookups work for any casing and invalid mixed-case pasted keys don’t throw.
- Fixed truncated Pendle Spark Oracle Factory address (38 → 40 hex digits) per `pendle-core-v2-public` `1-core.json` `sparkLinearDiscountOracleFactory`.

### 2026-03-26: Proxy registry + tx `to` warning

- `ContractRegistryEntry`: optional `isProxy`, `implementationSlot`; exported **`EIP1967_IMPLEMENTATION_SLOT`**, **`getContractRegistryEntry`**
- Marked proxies (examples): Aave V3 Pool, Aave V2 Lending Pool, Pendle Governance Proxy, Fluid Reserve Contract Proxy, Convex voter proxies, Balancer V3 Vault
- **`analyzeWarnings(..., { txTo })`**: info banner when `txTo` matches a marked proxy (tx-hash flow only; raw calldata has no `to`)
- `CalldataInput` passes `info.to` into `onDecode`; `App` forwards to `analyzeWarnings`
- **Calldata mode**: optional **Contract address (To)** field + context bar; validated with `getAddress`, forwarded as `txTo` for proxy warnings / labels when not using tx hash

### 2026-03-26: UX & Readability Improvements

- Updated RPC endpoints to user-preferred list: llamarpc (primary), publicnode, drpc.org, 1rpc
- Fixed horizontal overflow in nested tree view: switched from horizontal flex to vertical stacking for params, added `min-w-0`/`break-all` throughout, reduced indentation per nesting level
- Full checksummed addresses displayed (no more `0x1808...B563` truncation)
- Reduced page padding and widened layout from `max-w-4xl` to `max-w-6xl`
- Token-aware amount formatting: when a `uint256` appears alongside a known token address (USDC, WETH, DAI, etc.), it's formatted with the token's decimals and symbol (e.g., `30,323.594999 USDC`)
- Added `KNOWN_TOKENS` map with decimals to `abiRegistry.ts` (USDC/6, USDT/6, WBTC/8, WETH/18, DAI/18, etc.)
- Post-processing enrichment in `decoder.ts` scans decoded params and tuples for token context
- Fixed timestamp heuristic: narrowed range from 2001-2100 (was allowing year 2600+)
- Zero address labeled as "Null Address" in known contracts
- Key files changed: `abiRegistry.ts`, `valueFormatter.ts`, `decoder.ts`, `TreeNode.tsx`, `CalldataInput.tsx`, `App.tsx`, `txFetcher.ts`, `index.html`

### 2026-03-26: Enriched Registry from User Transactions

- Extracted contracts, tokens, and selectors from 3 user-provided txn hashes (fxUSD/fxBASE/Curve)
- **No user EOA addresses stored** — only external contract/protocol addresses
- New contracts added: Curve Finance Router v1.2 (`0x45312e...`), Curve USDCfxUSD Pool (`0x5018be...`), fxUSD (`0x085780...`), fxBASE/fxUSD Save (`0x65c9a6...`)
- New tokens added: fxUSD (18 decimals), fxBASE (18 decimals)
- New bundled selectors: `exchange(address[11],uint256[5][5],uint256,uint256,address[5])` (Curve Router), `redeem(address,uint256)` (f(x) Protocol)
- Simplified CopyMenu to only "Raw" vs "Decoded" options (removed "Formatted")
- Key file changed: `abiRegistry.ts`

### 2026-03-26: Large Registry Enrichment from 7 User Transactions

- Extracted contracts, tokens, selectors, and multicall patterns from 7 user txn hashes
- **No user EOA addresses stored** — only external protocol/contract addresses
- New protocols added: **Pendle** (RouterV4, PENDLE token), **Equilibria Finance** (Booster, EQB token), **Contango**, **Balancer V3** (Vault), **Fluid** (fWETH)
- New tokens: FXN (18), PENDLE (18), EQB (18), wstETH (18), weETH (18)
- New contracts: f(x) Stability Pool, Pendle RouterV4, Equilibria Finance, Equilibria Pendle Booster, Contango, Balancer V3 Vault, Fluid fWETH
- New bundled selectors: `requestRedeem(uint256)`, `getReward()`, `callAndReflect(address,bytes,bytes,bytes)`, `multicall((bool,bytes)[])`, `withdraw(uint256,uint256)`, `closeOrRemovePositionFlashLoanV2(...)`
- New multicall patterns in `knownPatterns.ts`: Pendle `multicall((bool,bytes)[])` (tuple-field), Pendle `callAndReflect` (3 direct bytes params), Contango `closeOrRemovePositionFlashLoanV2` (trailing bytes param)
- Key files changed: `abiRegistry.ts`, `knownPatterns.ts`

### 2026-03-26: Pendle Protocol Docs Ingestion

- Ingested Pendle's official deployment configs (`1-core.json`, `1-offchain-helper.json`, `10-core.json`) from [pendle-core-v2-public](https://github.com/pendle-finance/pendle-core-v2-public)
- Added 13 new Pendle infrastructure contracts: Reflector, Gauge Controller, sPENDLE, vePENDLE, Limit Router, Treasury, RouterStatic, Oracle, SY Factory, Market Factory V6, Yield Contract Factory V6, Rewards Distributor, Sender Endpoint
- Cross-referenced with user's actual tx history — Reflector, Gauge Controller, and Treasury already appeared in decoded transactions
- Key file changed: `abiRegistry.ts`

### 2026-03-26: Pendle Multi-Chain Deployment Ingestion

- Analyzed deployment configs for 10 additional chains: Unichain (130), Sonic (146), Arbitrum (42161), Avalanche (43114), Mantle (5000), BSC (56), Berachain (80094), Base (8453), Hyperliquid (9745), Zircuit (999)
- Key finding: Pendle uses CREATE2 deterministic deployments — most core contracts share identical addresses across ALL chains
- Added 8 new cross-chain constant addresses: PendleSwap, Proxy Admin, Governance Proxy, Common Deploy, Spark Oracle Factory, vePENDLE Airdrop, Merkle Depositor, Decimals Factory, LP Discount Oracle Factory
- Reorganized `KNOWN_CONTRACTS` Pendle section into "cross-chain constant" (15 addresses) and "Ethereum mainnet only" (9 addresses) for clarity
- **Update (chain-scoped registry):** those entries live under **`chainId` 1** only; selecting Arbitrum/Base/etc. does not apply them until duplicated (or verified) per chain in `KNOWN_*_RAW`
- Key file changed: `abiRegistry.ts`

### 2026-03-26: Aave Protocol Ingestion

- Ingested Aave V3 and V2 Ethereum contract addresses from the official [aave-address-book](https://github.com/aave-dao/aave-address-book) (`AaveV3Ethereum.ts`, `AaveV2Ethereum.ts`)
- Added 20 Aave infrastructure contracts to `KNOWN_CONTRACTS`:
  - **V3** (19): Pool (already existed), Pool Addresses Provider, Pool Configurator, Oracle, ACL Manager, Protocol Data Provider, Incentives Controller, Emission Manager, Collector, WETH Gateway, Debt Swap Adapter, Repay With Collateral Adapter, Swap Collateral Adapter, StataFactory, Config Engine, Risk Steward, Pool Registry, GHO Direct Minter, sDAI Token Wrapper, Withdraw Swap Adapter
  - **V2** (8): Lending Pool, Pool Addresses Provider, Pool Configurator, Oracle, Protocol Data Provider, Incentives Controller, WETH Gateway, Pool Registry
  - **Token**: GHO
- Added 38 tokens to `KNOWN_TOKENS` from Aave V3's full asset list:
  - Liquid staking: stETH, rETH, cbETH, osETH, ETHx, rsETH, ezETH, tETH
  - Stablecoins: GHO, USDe, sUSDe, sDAI, FRAX, LUSD, crvUSD, PYUSD, USDS, RLUSD, EURC
  - Governance: CRV, MKR, LDO, SNX, BAL, ENS, RPL, FXS
  - BTC variants: cbBTC, LBTC, tBTC, eBTC, FBTC
  - Other: XAUt
- Added 13 new Aave function signatures to `BUNDLED_SIGNATURES`:
  - V3 Pool: supplyWithPermit, repayWithPermit, repayWithATokens, flashLoan, flashLoanSimple, liquidationCall, setUserUseReserveAsCollateral
  - V2 Pool: deposit
  - WETH Gateway: depositETH, withdrawETH, borrowETH, repayETH
- Key file changed: `abiRegistry.ts`

### 2026-03-26: f(x) Protocol, Fluid (Instadapp), Convex Finance Ingestion

- Ingested contract addresses from three protocol deployment sources:
  - **f(x) Protocol**: `deployed_addresses.json` from AladdinDAO GitHub repo
  - **Fluid (Instadapp)**: `deployments.md` from fluid-contracts-public GitHub repo
  - **Convex Finance**: Contract addresses from official Convex docs
- Added to `KNOWN_CONTRACTS`:
  - **f(x) Protocol** (5 new): Pool Manager, PegKeeper, Revenue Pool, MultiPathConverter, wstETH Pool
  - **Fluid** (16): Liquidity, Vault Factory, Lending Factory, Dex Factory, Reserve Contract Proxy, fUSDC, fUSDT, fWETH, fwstETH, Dex wstETH-ETH, Dex USDC-USDT, Dex WBTC-cbBTC, Dex GHO-USDC, Dex USDC-ETH, Dex weETH-ETH, Deployer
  - **Convex** (17): Booster, Voter Proxy, CVX, cvxCRV, CRV Depositor, CVX Rewards, cvxCRV Rewards, Locker (vlCVX), MasterChef, cvxCRV Wrapper, Claim Zap v3, Multisig, FXS Booster, FXS Voter Proxy, cvxFXS, FXN Booster (cvxFXN), Prisma Booster (cvxPrisma)
- Added 7 new tokens to `KNOWN_TOKENS`: CVX, cvxCRV, cvxFXS, cvxFXN, cvxPrisma, PRISMA, INST
- Added 10 Convex function signatures to `BUNDLED_SIGNATURES`:
  - Booster: deposit, depositAll, earmarkRewards
  - BaseRewardPool: stake, stakeAll, stakeFor, withdrawAndUnwrap
  - vlCVX Locker: lock, processExpiredLocks
- Key file changed: `abiRegistry.ts`

### 2026-03-26: Superform & Morpho Ingestion

- Added Ethereum mainnet contracts from Superform v2 deployment docs and Morpho contracts from Hyperbeat docs
- Added to `KNOWN_CONTRACTS`:
  - **Superform** (10): SuperBundler, SuperExecutor, SuperValidator, SuperLedger, Nexus, NexusAccountFactory, SuperGovernor, SuperVaultAggregator, SuperBank, SuperOracle
  - **Morpho** (3): MetaMorpho Factory v1.1, Public Allocator, PreLiquidation Factory
- Added 1 token to `KNOWN_TOKENS`: UP (Superform, 18 decimals)
- Note: Hyperbeat and Hyperdrive contracts are HyperEVM-only — deferred until multi-chain support
- Key file changed: `abiRegistry.ts`

### 2026-03-26: Multi-Chain Support

- Added full multi-chain support with 6 chains: Ethereum, Arbitrum, Base, Polygon, Optimism, HyperEVM
- New files:
  - `src/lib/chains.ts`: Chain configuration (id, name, native currency, explorer URL, RPC endpoints)
  - `src/context/ChainContext.tsx`: React context for threading chainId to deep components
- Updated files:
  - `src/lib/txFetcher.ts`: Now accepts `chainId` param, selects RPCs per chain
  - `src/lib/valueFormatter.ts`: `formatAddress()` now accepts `chainId`, returns chain-specific `explorerUrl`
  - `src/components/CalldataInput.tsx`: Added chain selector dropdown, chain-aware tx info bar (explorer links, native currency label)
  - `src/components/TreeNode.tsx`: Uses `useChainId()` context for address explorer links
  - `src/App.tsx`: Manages `chainId` state, wraps tree in `ChainProvider`, passes chain props to input
  - `index.html`: CSP updated with all new RPC domains (Arbitrum, Base, Polygon, Optimism, HyperEVM)
- RPC endpoints per chain:
  - Ethereum: llamarpc, publicnode, drpc, 1rpc
  - Arbitrum: publicnode, drpc, 1rpc
  - Base: publicnode, drpc, 1rpc
  - Polygon: polygon-rpc.com, drpc, 1rpc
  - Optimism: optimism.io, drpc, 1rpc
  - HyperEVM: rpc.hyperliquid.xyz
- Explorer URLs: etherscan.io, arbiscan.io, basescan.org, polygonscan.com, optimistic.etherscan.io, hypurrscan.io

### 2026-03-26: Transaction Warning System

- Added security warning system that analyzes decoded transactions for red flags
- New files:
  - `src/lib/warningAnalyzer.ts`: Post-decode analysis engine that walks the decoded call tree
  - `src/components/WarningBanner.tsx`: Styled warning cards with severity levels (danger/warning/info)
- New types in `src/types/index.ts`: `TxWarning`, `WarningSeverity`; `warnings` field added to `DecodeResult`
- Detection rules:
  - **Danger**: Unlimited token approvals (`approve` with max uint256), NFT `setApprovalForAll(true)`, suspicious phishing function names
  - **Warning**: Large native value transfers (>10 ETH), large token transfers/approvals (est. >$50k via rough price heuristics)
  - **Info**: Ambiguous decode confidence
- Rough USD estimation for threshold checks using hardcoded price approximations (stablecoins=$1, ETH-like=$2000, BTC-like=$85000)
- Warnings display as colored banners above the decoded tree, sorted by severity (danger first)
- `CalldataInput` passes `msg.value` from fetched tx through to the analyzer
- Key files changed: `warningAnalyzer.ts`, `WarningBanner.tsx`, `App.tsx`, `CalldataInput.tsx`, `types/index.ts`

### 2026-03-26: Dev-only sample warning preview

- `src/lib/sampleWarnings.ts`: `SAMPLE_DEV_WARNINGS` (danger / warning / info examples)
- `src/App.tsx`: when `import.meta.env.DEV`, a **Preview sample warnings** toggle under the calldata form shows `WarningBanner` with static copy; cleared on decode. Production builds omit this UI (and Vite tree-shakes the sample strings).

### 2026-03-26: On-chain `decimals()` fallback for unknown tokens

- **`DecodeOptions.fetchTokenDecimalsOnChain`** (default **true** in `DEFAULT_DECODE_OPTIONS`): when an address is not in `KNOWN_TOKENS`, **`fetchOnChainTokenDecimals`** calls **`decimals()`** and **`symbol()`** (string, then bytes32 fallback) via **`CHAINS[chainId].rpcs`** (failover, ~6s timeout per call)
- Returns **`{ symbol, decimals }`** (`symbol` may be on-chain or **`UNKNOWN`**); in-memory cache keyed by **`chainId:address`**
- Skipped when **`offlineMode`** or **`fetchTokenDecimalsOnChain === false`**
- **`getTokenInfo`** remains **sync** = static registry only; enrichment uses **`resolveTokenInfo`** (registry then RPC)
- Key files: **`abiRegistry.ts`**, **`decoder.ts`**, **`types/index.ts`**

### 2026-03-26: Selector ambiguity — `popularity` / `deprecated`

- **`FunctionSignature`**: optional **`popularity`** (number) and **`deprecated`** (boolean)
- **`computeScore`**: adds `popularity`, subtracts a fixed penalty when **`deprecated`**
- **`rankSignatureAlternatives`**: sorts **`call.alternatives`** (non-deprecated first, then popularity, source tier, `textSignature`)
- **OpenChain / 4byte**: **`textSigToFunctionSignature(..., rankIndex)`** sets declining default **`popularity`** by API order; **user ABI** overloads get declining **`popularity`**
- **Bundled**: `multicall` variants and Pendle `multicall` get relative **`popularity`**; Universal Router **`execute(bytes,bytes[])`** marked **`deprecated: true`** with lower **`popularity`** vs **`execute(bytes,bytes[],uint256)`**
- **UI**: alternative signature list shows an orange **`deprecated`** label when set

### 2026-03-26: Bundled signatures — permit, Safe module, 1inch V6, OZ forwarder

- **EIP-2612** `permit(address,address,uint256,uint256,uint8,bytes32,bytes32)` (`0xd505accf`)
- **Gnosis Safe** `execTransactionFromModule(address,uint256,bytes,uint8)` (`0x468721a7`)
- **1inch Aggregation Router V6** `swap(address,(address,address,address,address,uint256,uint256,uint256),bytes,bytes)` (`0x12aa3caf`, text sig from 4byte.directory)
- **OpenZeppelin ERC2771Forwarder** `execute((address,address,uint256,uint256,uint48,bytes,bytes))` (`0xdf905caf`), `executeBatch((address,address,uint256,uint256,uint48,bytes,bytes)[],address)` (`0xccf96b4a`) — Defender / relayer metatx batching; `multicall(bytes[])` was already bundled (`0xac9650d8`)

### 2026-03-26: `FunctionSignature.params` (no parallel arrays)

- **`FunctionSignature`** now uses **`params: SignatureParam[]`** (`{ name, type }`) instead of parallel **`paramTypes` / `paramNames`**; **`HexSelector`** branded type for **`selector`**
- **`BUNDLED_SIGNATURES`** migrated; load-time checks: selector keccak, param count/types vs **`parseTextSignature`**
- **`decoder.ts`**, **`signatureLookup.ts`**, **`decodeWithUserAbi`** updated; **`todo.md`** tracks remaining L2 token address work

### 2026-03-26: L2 token map + `getContractName` token fallback

- **`KNOWN_TOKENS_RAW`** extended for **`42161`**, **`8453`**, **`10`**, **`137`**: majors and Aave-listed underlyings (WETH, USDC / USDC.e, USDT, DAI, WBTC, LINK, AAVE, LST/LRTs, GHO, etc.); addresses taken from [aave-address-book](https://github.com/aave-dao/aave-address-book) `AaveV3*Assets` `*_UNDERLYING`, plus Base USDT/DAI from common deployments
- **`getContractName`**: falls back to **`getTokenInfo(...).symbol`** so token-only entries get address labels without duplicating `KNOWN_CONTRACTS`
- Tests: stETH label on mainnet; Arbitrum native USDC; existing no-false-positive test unchanged

### 2026-03-26: Chain-scoped registry (no cross-chain false positives)

- `KNOWN_CONTRACTS_RAW` / `KNOWN_TOKENS_RAW` are keyed by **`chainId`** (`Record<number, …>`); only **`1`** (Ethereum mainnet) is populated today
- Lookups: **`getTokenInfo`**, **`getContractRegistryEntry`**, **`getContractName`** all require **`chainId`**; other chains return no label until entries exist for that id
- **`DecodeOptions.chainId`** is required (merge with `DEFAULT_DECODE_OPTIONS` in the app); decoder, value formatter, warning analyzer, and calldata/tx UI pass it through
- **`abiRegistry.test.ts`**: regression test that mainnet USDC is labeled on chain `1` but not on `42161` / `8453`

### 2026-03-29: 1inch `desc` tuple — `fieldHint` explanations in tree

- **`DecodedParam.fieldHint`:** optional one-line explanation; **`TreeNode` `ParamRow`** shows it under the name (muted, left border).
- **`decoder.ts`:** **`annotateOneInchSwapDescFieldHints`** for **`0x90411a32`** (10-field) and **`0x12aa3caf`** (7-field) `desc` tuples + summary on the parent **`desc`** param. **`annotateUniswapV3ExactSingleParamsHints`** for **`exactInputSingle`** / **`exactOutputSingle`** **`params`** tuple (**`0x414bf389`**, **`0xdb3e2198`**).
- **Tests:** **`decoder.test.ts`** (1inch V6 + Uniswap input/output single).

### 2026-03-29: Unrealistic USDC / stable USD lines (wrong tuple slot)

- **Cause:** Generic **single-token** tuple enrichment applied **USDC** (or another token) to **every** `uint` in a tuple when only one address resolved — e.g. Uniswap V3 **`deadline`** / **`sqrtPriceLimitX96`**, or 1inch **`desc`** fields **6–7** (after we fixed **4–5** only, the tuple pass still ran first and tagged **6–7**).
- **`decoder.ts`:** **`tryEnrichUniswapV3ExactSingleParamsTuple`** for **`exactInputSingle`** / **`exactOutputSingle`** — map amounts to **tokenIn** / **tokenOut** only; **skip** generic tuple pass for that **`params`** tuple. **1inch** **`desc`** added to **`skipTupleParents`** and enrichment runs **before** the tuple loop. **`applyTokenContextToUintPrimitive`** bails if **`tokenAmountWholePartExceedsPlausibleDisplay`** (integer part &gt; 18 decimal digits).
- **`valueFormatter.ts`:** **`tokenAmountWholePartExceedsPlausibleDisplay`**; **`formatTokenAmount`** returns a **no–USD-peg** message when scale is implausible.
- **Tests:** **`decoder.test.ts`**, **`valueFormatter.test.ts`**.

### 2026-03-29: Enso `leaves` (bytes32[]) — opaque ids vs `commands[]` calldata

- **`decoder.ts`:** Opaque **`bytes32`** (no ASCII / no left-padded address) gets interpretation **`Opaque 32-byte word`**; **`Uint8Array`** from ABI decode is normalized via **`hexlify`**. **`enrichEnsoExecuteShortcutLeavesInterpretation`** appends Enso-specific copy for **`leaves[]`** on **`0x95352c9f` `executeShortcut`** so the UI explains these are route leaf ids, not nested calldata (use **`commands[]`**).
- **Tests:** **`decoder.test.ts`**.

### 2026-03-29: USDC peg line + 1inch `swap` `desc` token amounts

- **`stablecoinUsd.ts`:** **`formatStableUsdPegClause`** caps the **≈ $… USD** amount to **6** fractional digits (via **`capStablePegUsdAmountDisplay`**) so wrong `decimals` or long **`formatUnits`** tails do not flood the UI.
- **`decoder.ts`:** **`tryEnrich1inchAggregationSwapDesc`** for **`0x90411a32`** and **`0x12aa3caf`** — maps **`desc`** fields **4–5** to **`srcToken`** / **`dstToken`** (tuple enrichment previously skipped uints when multiple tokens were present).
- **Tests:** **`stablecoinUsd.test.ts`**.

### 2026-03-29: Enso `routeMulti` + ambiguous warning dedupe

- **Tx `0xe4c28236…`:** Etherscan labels Enso **Router V2** `routeMulti`; 4byte wrong tuple shape caused **ambiguous** decodes on outer + many nested `bytes` frames → repeated **Ambiguous decode** banners.
- **`abiRegistry`:** Bundled **`routeMulti((uint8,bytes)[],bytes)`** (`0xf52e33f5`, high popularity) — root calldata decodes as **exact**. Registry: **Enso: Router V2**, **Stargate: Pool Native**, **Stargate: Token Messaging** (mainnet).
- **`warningAnalyzer`:** Dedupe **Ambiguous decode** by **`selector:functionName`** across the tree; **Enso routeMulti** info at **depth 0** (Stargate / LayerZero context).

### 2026-03-29: Across SpokePool V2 `deposit` — ENS, USD peg, bridge banner

- **Tx example:** `0x651346c9…` → SpokePool **`0x5c7bcd6e…`**; **`bytes32`** params are left-padded 20-byte addresses.
- **`abiRegistry`:** Bundled **`deposit`** signature + names (`depositor`, `inputToken`, …); contract label **Across SpokePool V2 (Ethereum)**.
- **`types`:** primitive optional **`embeddedEvmAddress`** (`checksummed`, **`ensName`**).
- **`decoder`:** matching **`bytes32`** → **`embeddedEvmAddress`**, no duplicate “bytes32-wrapped” line in **`interpretation`**. **`collectEnsTargets`** includes embedded primitives; **`tryEnrichAcrossSpokeDeposit`** maps amounts to **`inputToken`** / **`outputToken`** (USDC → peg clause via **`formatTokenAmount`**). **`enrichDestinationChainIdLabels`**: any **`destinationChainId`** bare **`uint*`** param gets **`interpretation`** like **`HyperEVM (chain ID 999)`** via **`getKnownEvmChainName`** (nested tuples / inner **`bytes`** calls too).
- **`TreeNode`:** second row: explorer + ENS + registry label + copy address.
- **`warningAnalyzer` / `destinationChainId` labels:** **`getKnownEvmChainName`** — configured **`CHAINS`** first, then **`BRIDGE_EVM_CHAIN_NAME_OVERRIDES`**, then **`chainlistChainNames.json`** (via **`Object.hasOwn`** only — no prototype chain). Names pass **`sanitizeTrustedUiLabel`** (controls + BiDi overrides). Decoded **ID text** always from **`BigInt(raw).toString()`** (`parseDecodedChainId` / **`formatDestinationChainInterpretation`**); friendly names are **never** taken from calldata. Across warning text states **decoded** value and **not verified on-chain**. Regenerate chainlist: **`npm run regen:chainlist-names`**.
- **Tests:** `decoder.test.ts`, `valueFormatter.test.ts` (**`extractLeftPaddedAddressFromBytes32`**).

### 2026-03-29: Native transfer / empty `input` tx-hash flow

- **`fetchTxCalldata`**: Empty or **`0x`** **`input`** no longer throws (removed **`NoCalldataError`**); returns **`TxInfo`** with **`calldata: '0x'`** (normalized in **`txInfoFromResult`**).
- **`TxFetchContext`**: **`Pick<TxInfo, 'hash' | 'from' | 'to' | 'value' | 'isPending'>`**; **`CalldataInput`** passes it as a 6th **`onDecode`** arg after hash fetch.
- **`App` `handleDecode`**: If calldata is empty and **`txFetchContext`** is set, sets **`DecodeResult`** **`status: 'native_transfer'`** (info **`warnings`**, **`clearUrlHash`**, no decoder run / no loading spinner).
- **`DecodeTree`**: **`NativeTransferSummary`** (explorer links, value, **`0x`** calldata line); title **Transaction (no calldata)**; JSON toggle label **Summary** for this status.
- **`TxInfoBar`**: Calldata preview **— (none; native transfer)** when **`0x`**.
- **Types**: **`DecodedCalldataOutcome`** = **`Exclude<DecodeResult, native_transfer>`** for **`decodeCalldata`** / **`decodeWithUserAbi`** return types (fixes TS narrowing in **`App`**).
- **Tests**: **`txFetcher.test`** — empty input resolves to **`TxInfo`**; parallel-RPC test now uses **null tx** on first endpoint instead of empty calldata (first success wins, so empty is no longer a “try next” error).

### 2026-03-29: `index.html` — OG/Twitter, preconnect, referrer, manifest

- **`meta referrer`** `strict-origin-when-cross-origin`.
- **Open Graph** + **`twitter:card`** `summary_large_image`; **`og:image`** → **`/favicon-32x32.png`** (comment notes absolute URLs for production).
- **`link rel="preconnect"`** `api.openchain.xyz`, `eth.llamarpc.com` + **`crossorigin`**.
- **`public/manifest.json`** + **`link rel="manifest"`** (install metadata; no service worker / offline yet).
- HTML comment on **`style-src 'unsafe-inline'`** + not putting user content in inline styles.

### 2026-03-29: A11y / Tailwind dark + noscript

- **`src/index.css`**: Tailwind v4 **`@custom-variant dark (&:where(.dark, .dark *))`** — class-based dark (same idea as v3 **`darkMode: 'class'`**); **`html class="dark"`** already matches.
- **`index.html`**: **`<noscript>`** fallback (inline styles; no Tailwind scan on static HTML) with **`#030712`** / **`#f3f4f6`** text.
- **`vite.config.ts`**: comment that CSP lives in **`index.html`** meta; nonces would need server/plugin work.

### 2026-03-29: `index.html` SEO / PWA hints + PNG favicon

- **`meta`**: **`description`**, **`theme-color`** `#030712` (matches **`bg-gray-950`**), **`color-scheme`** `dark`.
- **`public/favicon-32x32.png`**: solid `#1a1a2e` (matches SVG card) for Safari & clients without SVG favicons; **`link rel="icon"`** PNG after SVG.

### 2026-03-29: `index.html` CSP hardening

- Added **`img-src 'self' data: https:`** (future token logos / blockies / HTTPS images), **`font-src 'self'`**, **`frame-ancestors 'none'`**, **`base-uri 'self'`**, **`form-action 'none'`**, **`upgrade-insecure-requests`**. Existing **`connect-src`** allowlist unchanged; policy formatted across lines for readability.

### 2026-03-29: `main.tsx` — root guard, unhandled rejections, dev log

- **`#root`**: no non-null assertion; throws **`Root element #root not found`** if missing (widget/embed safety).
- **`unhandledrejection`**: **`console.error('Unhandled promise rejection:', reason)`** for async errors outside React error boundaries.
- **DEV**: **`console.log('Dev mode — React StrictMode enabled')`**.

### 2026-03-29: App follow-ups — expand reactivity, hash+search, docs

- **`?expand=`**: `popstate` + wrapped **`history.pushState` / `replaceState`** re-read search and **`setAutoExpandMaxDepth`** (cleanup restores native methods). Success **`replaceState`** now uses **`pathname + search + #calldata`** so **`expand`** is not dropped when setting the fragment.
- **Hash bootstrap effect**: block comment documents URL-as-truth and “cleared textarea + hash still present + chain change” behavior.
- **`DecodeOptions.signal`** / **`throwIfDecodeAborted`**: JSDoc clarifies cooperative checks after **`await`s**, no preemption of tight sync work, signal not passed into signature/RPC **`fetch`** today.

### 2026-03-29: App UX — hash timing, hash+chain effect, `expand`, a11y

- **URL hash**: set **`#${calldata}`** only after **success** or **partial** decode; **`clearUrlHash()`** on decoder **error** result or thrown error (preserves **`?search`**). Aborted decodes do not change the hash.
- **Hash bootstrap `useEffect`**: deps **`[chainId, handleDecode]`** so shared-link loads and **chain switches** re-decode with the current chain when the fragment still holds hex.
- **Tree depth**: query **`?expand=N`** (1–20, default **`DEFAULT_AUTO_EXPAND_DEPTH`**) read once at mount → **`DecodeTree`** **`autoExpandMaxDepth`**.
- **Loading**: **`role="status"`**, **`aria-live="polite"`**, **`aria-busy="true"`** on the decoding spinner block.
- **Footer**: external links get descriptive **`aria-label`**s (new tab).

### 2026-03-29: Decode `AbortSignal` — App + decoder + `CalldataInput`

- **`DecodeOptions.signal`**: cooperative abort; **`decodeCalldata`** throws **`DOMException` `AbortError`** at **`throwIfDecodeAborted`** checkpoints (after **`await`s**, loops, nested frames). **`scoreAndDecode`** rethrows **`AbortError`** (not swallowed as failed candidate).
- **`App.tsx`**: **`decodeAbortRef`**, new decode aborts prior **`AbortController`**; passes **`signal`** into **`decodeCalldata`**; **`finally`** only updates loading/time when **`decodeAbortRef.current === ac`** (avoids superseded runs clearing loading). Unmount + **`chainId`** change abort in-flight decode. Hash bootstrap **`useEffect`** moved **after** **`handleDecode`** (TDZ-safe).
- **`CalldataInput`**: optional **`onAbortInFlightDecode`**; invoked with tx-fetch abort when **`chainId`** or **`inputMode`** changes.
- **`decoder.test.ts`**: pre-aborted signal rejects with **`AbortError`**.

### 2026-03-29: Minor polish — copy width, abort signal docs, `initialCalldata` null, ABI copy

- **`TxInfoBar` Copy**: **`min-w-[4rem]`** + **`text-center`** so **Copy / Copied / Failed** does not shift layout.
- **`fetchTxCalldata` `signal`**: JSDoc on **`FetchTxCalldataOptions.signal`** and **`fetchWithTimeout`** — outer abort is merged with timeout; underlying **`fetch`** uses **`controller.signal`** (see **`fetchWithTimeout`**).
- **`initialCalldata === null`**: clears **`calldata`** and **`calldataDraftRef`** (e.g. parent clears URL fragment); **`undefined`** still does not override local state.
- **ABI validation errors**: shorter copy — **`Invalid ABI JSON format. Paste a JSON array of ABI fragment objects.`**
- **Chain `<select>`**: disabled **`title`** when loading was already present — no change.

### 2026-03-29: `CalldataInput` + `txFetcher` — wei display, buttons, abort

- **Tx value**: **`formatEther(parseTxValueWei(txInfo.value))`** — **`parseTxValueWei`** never throws on null/invalid RPC **`value`**.
- **`onDecodeRef`** so **`handleDecode`** deps omit unstable **`onDecode`**; JSDoc asks parent to **`useCallback`**.
- **Mode calldata draft**: **`calldataDraftRef`** snapshot on **Calldata → Tx hash**; restore on **Tx hash → Calldata**; synced on fetch + textarea **`onChange`** + **`initialCalldata`**.
- **Chain `<select>`**: **`disabled`** + **`aria-busy`** while **`currentlyLoading`** (fetch or decode).
- **Optional `to`**: blur validation → green check / amber line + **`aria-invalid`**; **`role="status"`** **`aria-live="polite"`** for invalid hint.
- **A11y**: mode toggles **`aria-pressed`** + **`aria-label`**; form error **`role="alert"`**. **`TxInfoBar`**: **Copy** calldata (clipboard + **`sr-only`** **`aria-live="polite"`** status).
- **`currentChain`**: **`useMemo(() => getChain(chainId), [chainId])`** passed into **`TxInfoBar`** / **`OptionalToContextBar`** (no repeated **`getChain`** in children).
- **`FetchTxCalldataOptions.signal`**, **`type="button"`**, **`formatEther`** display, tests as before.

### 2026-03-29: `DecodeTree.tsx` + `DecodedCallNode` — clipboard, timers, expand depth

- **`DecodeTree`**: **`shareUrlOverride`** (`[shareUrl]`) vs **`shareUrlFromLocation`** (`[result]`); **`resolvedShareUrl`** = override || location. **`sr-only`** **`role="status"`** **`aria-live="polite"`** for clipboard outcomes. Error **Copy calldata** disabled when **`rawHex`** empty. Clipboard timers / **`joinPartialDecodeErrors`** / tree toggle a11y as before.
- **`DecodedCallNode`**: initial **`expanded`** is **`call.depth < autoExpandMaxDepth`** (matches array/tuple auto-expand; root depth 0 stays open when default depth is 3).

### 2026-03-29: `TreeNode.tsx` — architecture comment, prop types, bottom-up order

- File-level **dependency graph** comment; tree section **`ValueDisplay` → `ParamRow` → `DecodedCallNode`** (still `function` declarations for hoist-friendly `ValueDisplay` ↔ `DecodedCallNode` cycle).
- Co-located **`CopyMenuProps`**, **`ValueDisplayProps`**, **`ParamRowProps`**, exported **`DecodedCallNodeProps`**, plus small badge/copy **`*Props`** interfaces.

### 2026-03-29: `TreeNode` / `DecodeTree` — fingerprint cache, hex byte length, auto-expand depth

- **`decodedValueFingerprint`**: **`WeakMap<DecodedValue, string>`** cache (assumes immutable decoder output) to avoid rescanning tuple field lists on repeated renders with stable references.
- **`hexPayloadByteLength`**: **`Math.floor(nibbles / 2)`** so odd-length payloads never report fractional bytes; JSDoc updated.
- **`CopyMenu`**: **`showFormattedRow`** = **`display && display !== raw`**; **`showDecodedRow`** avoids duplicating interpretation when it matches **`display`** (see **2026-03-30** note).
- **`DEFAULT_AUTO_EXPAND_DEPTH`** (exported **3**): optional **`autoExpandMaxDepth`** on **`DecodedCallNode`**, **`ParamRow`**, **`ValueDisplay`**, and **`DecodeTree`**; forwarded through nested **`DecodedCallNode`** / arrays / tuples.

### 2026-03-29: `TreeNode.tsx` — stricter badge maps + stable list keys

- **`TYPE_BADGE_COLOR_MAP`**: `Record<SolidityTypeBadgePrefix, string>` with explicit **`TYPE_BADGE_PREFIX_ORDER`** (same precedence as before: address → bool → string → bytes via `startsWith`).
- **`SOURCE_BADGE_CLASS_MAP`**: `Record<SignatureSource, string>`; **`SourceBadge`** takes **`SignatureSource`** (no fallback class — map is exhaustive for the union).
- **React keys**: **`decodedValueFingerprint`** + helpers **`arrayElementRowKey`**, **`tupleFieldRowKey`**, **`callParamRowKey`**, **`alternativeSignatureRowKey`** replace bare index keys on array rows, tuple **`ParamRow`**s, top-level params, and alternative signature lines so re-decodes don’t reuse the wrong component state by index.

### 2026-03-29: `ErrorBoundary` — logging + remount on reset

- **`componentDidCatch`**: logs **`error`** then **`info.componentStack`** (trimmed); optional **`onError(error, info)`** for analytics.
- **`onReset`**: optional; invoked when default **Try again** runs (before state clear); custom **`fallback`** does not call it unless the parent wires it.
- **`resetKey`**: keyed **`<Fragment>`** remounts children after recovery.
- Default error panel: **`role="alert"`**, **`aria-live="assertive"`**, reset button **`aria-label`**; exported **`ErrorBoundaryProps`** / **`ErrorBoundaryState`**; dev-only stacks (comment + class JSDoc on prod); **50ms** deferred reset + **`clearTimeout`** on unmount; class JSDoc documents boundary limitations.

### 2026-03-29: `txFetcher` — API: indexing vs missing, headers, chain timeout, cache

- **`TxIndexingLagError`**: after **`eth_getTransactionByHash`** → **`null`**, probes **`eth_getTransactionReceipt`**; non-null receipt ⇒ mined but tx body lag. **`TxNotFoundError`**: null tx + no/inconclusive receipt (bad hash, mempool-only, or indexing). **`blockNumber === null`** on a full tx object remains **`isPending: true`** (mempool), not an error.
- **`ChainConfig.rpcTimeoutMs`**: optional; L2 chains use **15s**; default **10s**. **`fetchTxCalldata(txHash, chainId?, options?)`**: **`FetchTxCalldataOptions.skipCache`**. LRU (**`lru-cache`**, 64 entries, 60s TTL) keyed by resolved **`chainId:hash`**; **`clearTxCalldataCache()`** for tests.
- **RPC headers**: **`Content-Type`**, **`User-Agent`**, **`X-Client`** (`RecDec/0.0.0`); browsers may ignore forbidden headers — **`X-Client`** is the reliable etiquette signal.
- **Zod** validates JSON-RPC envelopes + **`eth_getTransactionByHash`** result objects; **`TxInfo.hash`** keeps trimmed input casing, **`rpcHash`** lowercases only for params/cache key; in **`import.meta.env.DEV`**, schema failures append Zod’s message.
- **`__PACKAGE_VERSION__`**: Vite **`define`** from **`package.json`** (**`vite.config.ts`**); Vitest **`mergeConfig`** with same Vite config. **`src/vite-env.d.ts`** declares the global.
- **`receiptProbeOnNull`** (**`FetchTxCalldataOptions`**) / **`receiptProbeOnNullTx`** (**`ChainConfig`**): when false, null tx skips **`eth_getTransactionReceipt`** (fewer RPCs; no **`TxIndexingLagError`** on that path). Stagger: **`rpcStaggerMs`** per chain, cap **`MAX_RPC_STAGGER_OFFSET_MS`**. Retryable HTTP: **408**, **409**, **429**, **502–504**.
- **Parallel / retries / aggregate** behavior unchanged from prior note; tests use URL + JSON-RPC **`method`** routing and **`clearTxCalldataCache`** in **`afterEach`**.

### 2026-03-29: `txFetcher` — parallel RPC, Content-Type, retries, schema

- **`Promise.any`** + **`AbortController`**, Content-Type gate, **`RetryableRpcError`** retries, **`aggregateAllRejected`** (now includes all-**`TxIndexingLagError`**).

### 2026-03-29: `normalizeHex`, `toRawHex(Uint8Array)`, `splitTupleTypes` JSDoc

- **`decoder.ts`**: internal **`normalizeHex`** (lowercase **`0x`**, bare hex gets prefix) used for calldata / bytes / **`getBytes`** / **`decodeWithUserAbi`** / **`toRawHex`** strings.
- **`toRawHex`**: **`Uint8Array`** → **`hexlify`**; test in **`decoder.test.ts`**.
- **`splitTupleTypes`**: JSDoc states **one tuple layer**, outer **`(`…`)`** must already be stripped by callers.

### 2026-03-29: `decodeWithUserAbi` + `getCachedUserAbiInterface`

- **`getCachedUserAbiInterface`** exported from **`signatureLookup.ts`** (same LRU as user-ABI selector lookup, keyed by **`keccak256(abiJson)`**).
- **`decodeWithUserAbi(calldata, abiJson, options?)`**: optional **`DecodeWithUserAbiOptions.iface`** to skip parse/cache in hot loops; otherwise uses cache + **`MAX_USER_ABI_JSON_CHARS`** guard; catch path uses normalized **`calldataHex`** for **`rawHex`**.

### 2026-03-29: `convertValue` bytes — nibble cap before odd-length return

- **`MAX_INPUT_BYTES * 2`** payload nibbles checked **before** `nibbles % 2` so huge odd-length hex cannot skip the limit; oversize returns truncated **`hex`** preview + warning. **`convertGnosisMultiSend`** / **`convertBytesValue`** receive normalized **`cleanHex`**.

### 2026-03-29: `decodeCalldata` — global hex length cap

- Rejects when **`calldataBytes.length > 2 + MAX_INPUT_BYTES * 2`** (`MAX_CALLDATA_HEX_STRING_LENGTH`), with truncated **`rawHex`** preview (first 100 chars + `...`) and selector in the error when parsable.

### 2026-03-29: `decoder` / `valueFormatter` — bool coercion, ABI constants, errors, multicall docs

- **`coerceAbiDecodedBool`** (`valueFormatter.ts`): avoids **`Boolean("false") === true`**; **`convertValue`** `bool` branch uses it with **`formatBool`**.
- **Gnosis `multiSend`**: compare **`dataLenBn`** to **`BigInt(Number.MAX_SAFE_INTEGER)`** before **`BigInt(MAX_INPUT_BYTES)`**, then **`Number(dataLenBn)`**; named layout constants (**`ABI_ADDRESS_BYTE_LENGTH`**, **`ABI_WORD_BYTE_LENGTH`**, hex scoring lengths).
- **Errors**: **`decodeCalldata`** includes **selector** in “no signature” / “all candidates failed”; **`decodeWithUserAbi`** adds selector text + optional **`selector`** field when parse fails.
- **Docs**: block comment on **`processDecodedParams`** describing selector → **`getKnownPattern`** → **`CalldataIndex`** → **`convertValue`** / nesting caps (parallel to multiSend table style).

### 2026-03-29: `decoder.ts` — safety, parsing, token cache, multiSend

- **`toRawHex`** / **`isDynamicBytesSolidityType`** / **`splitTupleTypes`**: prior fixes (0x prefix, tuple/`bytes` detection, **`()` + `[]` depth** splitting); tests vs **`ParamType`** component counts.
- **Single `bytes` / nested expand**: `byteLen > MAX_INPUT_BYTES` (1 MiB) skips nested **`decodeCalldata`** with a warning; **`convertBytesValue`** double-checks the same bound.
- **Gnosis `multiSend`**: **`getBytes` → `Uint8Array`**, **`hexlify(subarray)`** per segment (fewer string **`slice`** allocations).
- **Fixed `T[k]`**: **`parseFixedAbiArraySuffix`** (exported) replaces greedy regex; **4096**-char cap + **`lastIndexOf('[')`** parse.
- **Token RPC dedupe**: **`DecodeOptions.tokenLookupSessionCache`**; depth-0 **`decodeCalldata`** installs a **`Map`** keyed by **`chainId:address`** so tuple + param enrichment share one **`decimals()`** promise per address.
- **Signature lookup**: comment — user ABI wins when it lists the selector; parallel API prefetch would often be wasted (no behavioral change).

### 2026-03-30: Decode tree expansion — policy, bulk actions, collapsed `_swap_params` summary

- **`treeExpandPolicy.ts`**: Central **`computeInitialExpanded`** with ordered **`ExpansionRule`** list (**`DEFAULT_EXPANSION_RULES`**) — structural rules (negative depth, empty arrays) + **`curveExpandRules`**. Optional **`options.rules`** to prepend plugins (e.g. Uniswap). **`treeExpandTypes.ts`** shared input/rule types. **`treeExpandPolicy.test.ts`**.
- **`TreeExpansionContext.tsx`**: **`TreeExpansionProvider`**; **`useTreeExpansion`** throws outside provider (toolbar); **`useTreeExpansionOptional`** for nodes that may omit provider. **`generation`** wraps before **`Number.MAX_SAFE_INTEGER`**; repeated same bulk action still bumps **`generation`** (re-sync by design). Subscribers use `requestAnimationFrame` to avoid sync setState-in-effect lint.
- **`TreeExpandToolbar.tsx`**: **Expand all** / **Collapse all** (tree view only).
- **`DecodeTree.tsx`**: Wraps **`DecodedCallNode`** + toolbar in **`TreeExpansionProvider`** keyed by **`decodeTreeSessionKey`** (selector + calldata fingerprint) so bulk state resets on new decode.
- **`curveRouterSwapParams.ts`**: **`summarizeCurveSwapParamsCollapsed`**, **`isCurveSwapParamsMatrixOuterValue`** (type predicate); italic one-line preview when outer matrix is collapsed.
- **`TreeNode.tsx`**: **`declaringParam`** on **`ParamRow` → `ValueDisplay`**; **`expansionWeight`** (`CURVE_SWAP_PARAMS_HOP_EXPANSION_WEIGHT`) for Curve hop rows; **`useExpandableNodeState`** for calls / arrays / tuples. Outer **`_swap_params`** toggle **`[5 hops]`**; collapsed matrix shows italic **`summarizeCurveSwapParamsCollapsed`** line.

### 2026-03-30: Curve `_swap_params` annotations + fixed `uint256[k][…]` decode

- **`curveRouterSwapParams.ts`**: **`annotateCurveRouterSwapParams`** returns **`{ ok, value, issues? }`** and a **cloned** tree (input unchanged); **`routerVersion`** + **`CURVE_ROUTER_NG_SWAP_PARAMS_LAYOUTS`** in **`curveRouterNgAbi.ts`**; **`DEFAULT_*_LABELS`** maps + optional overrides; hop problems recorded in **`issues`** instead of silent **`continue`**.
- **`decoder.ts`**: **`tryEnrichCurveRouterExchange`** assigns **`swapParamsP.value`** from **`annotateCurveRouterSwapParams`**’s returned tree. **Fixed-array fix:** **`parseFixedAbiArraySuffix`** runs **before** scalar **`uint`/`int`** and dynamic **`bytes`** so **`uint256[5][5]`** decodes as nested **`array`** values.
- **`curveRouterSwapParams.test.ts`**: formatters + immutability + **`invalid_root_shape`** / **`unsupported_router_version`** + partial hop **`issues`** + layout consistency guard.
- **`decoder.test.ts`**: Curve regression also asserts **`_swap_params`** hop 0 (**`exchange_underlying`**, **`stable-ng`**, **`n_coins: 3`**) and unused hop 2.

### 2026-03-30: Curve router `exchange` + fixed `address[k]` token vectors

- **`decoder.ts`**: **`isAddressVectorType`** — treats **`address[]`** and fixed **`address[N]`** like **`address[11]`** / **`address[5]`** for **`collectResolvedTokensFromParams`** and **`enrichTupleWithTokenContext`** (Curve route/pool slots). Uniswap path resolution still requires a dynamic **`address[]`** (or a param explicitly named **`path`** with a vector type).
- **`tryEnrichCurveRouterExchange`** (selector **`0x5c9c18e2`**, bundled Curve router): maps **`_amount`** to the first resolvable token in **`_route`**, **`_min_dy`** to the last; returns **`true`** so the generic “≥2 tokens → skip all uint labeling” path does not leave misleading **`Timestamp:`** lines on router-sized ints.
- **`applyTokenContextToUintPrimitive`**: optional **`fromKnownRouterAmount`** — when **`true`**, replaces a prior **`Timestamp:`** interpretation (10-digit collision on token amounts).
- **`decoder.test.ts`**: regression test with full mainnet calldata from tx **`0x9c693a145bebc84b25cf45835ca6dc9e1285603038d1c0319c2eac0d3809a5bf`** — asserts **`exchange`**, USDC/USDT interpretations, and stable peg disclaimer text.

### 2026-03-30: Stablecoin ≈USD + safer swap token enrichment

- **`stablecoinUsd.ts`**: Curated **`isUsdPeggedStablecoinSymbol`** (USDC, USDT, DAI, GHO, fxUSD, FRAX, etc.); **`formatStableUsdPegClause`** / **`appendStableUsdPegClause`** append `≈ $… USD (assumes $1 peg; not a live quote)` using **`formatUnits`** — only when symbol matches (depeg / non-USD stables excluded).
- **`formatTokenAmount`**: Appends peg clause for stable interpretations (skips max-uint / unparseable paths internally).
- **`decoder` `enrichParamsWithTokenContext`**: **`tryEnrichUniswapV2PathSwaps`** for **`swapExactTokensForTokens`**, **`swapExactTokensForETH`**, **`swapExactETHForTokens`** — **`amountIn` → `path[0]`**, **`amountOutMin` → `path[last]`** token decimals/symbol. **`collectResolvedTokensFromParams`**: if **≥2** distinct resolved tokens at top level, **skip** generic “first address → all uints” (avoids wrong pair labeling). **`enrichTupleWithTokenContext`**: same **≥2** token guard + **`address[]`** scanning in tuples.

### 2026-03-30: Safety — no heuristic ÷1e18 in decode tree

- **Removed** per-parameter **native currency (÷1e18 / `formatEther`)** UI and **`nativeEtherHumanOk`** — calldata cannot prove a `uint256` is wei vs token base units; risk of misleading users was unacceptable.
- **Still shown**: decoded **integer string** (`display` / **`raw`**), **copy menu** (raw / formatted / decoded), **token interpretation** only when the decoder ties a **known token + decimals** to that amount, **Gnosis `value`** line still says **`… wei`** where encoded as such, **tx hash flow** **`msg.value`** from RPC (authoritative for that field). **Param `hex`/`hide hex`** = ABI word only.

### 2026-03-30: Param row — `hex` / `hide hex` (ABI word)

- **Param row**: **`hex`/`hide hex`** toggles the **32-byte ABI-encoded hex** for that argument (not “raw wei” semantics). Tooltip on the revealed line.

### 2026-03-30: `CopyMenu` — formatted vs raw (primitive values)

- **Bug:** `showDisplayRow` used `display !== interpretation`, so when the UI line matched the interpretation string (e.g. token amount), the **Formatted** row was hidden and users often got only a single **Copy** icon with no menu — felt like the formatted/raw picker was removed.
- **Fix:** **`showFormattedRow`** = `display && display !== raw`. **`showDecodedRow`** = interpretation present, not equal to raw, and not a duplicate of the formatted row when both differ from raw.
- **Labels:** **Formatted:** (was **Display:**); menu trigger **`title`** explains raw / formatted / decoded; lone **`CopyButton`** tooltip **Copy raw value**.

### 2026-03-30: Token labels + amount display

- **`fetchOnChainTokenDecimals`**: parallel **`decimals()`** + **`symbol() string`**; if missing, **`symbol() bytes32`** (MKR-style). Sanitized symbol (max 32 chars); still **`UNKNOWN`** if non-standard/reverting.
- **`valueFormatter`**: **`useGrouping: false`** everywhere — uint/token **`display`** / interpretations use plain digits (no `1,234` style).

### 2026-03-30: Vite dev port collision

- **`strictPort: false`** on **`server`** and **`preview`** so when another app (e.g. another repo’s Vite on **5173**) is running, **`npm run dev`** binds to **5174+** and prints the real **Local** URL in the terminal.

### 2026-03-30: `package.json` — scripts, engines, browserslist

- **`lint:fix`**, **`type-check`** (`tsc --noEmit`); no **`format`** script (Prettier not in repo).
- **`engines`**: Node **≥20.19.0**, npm **≥10**.
- **`browserslist`**: `defaults`, `not IE 11`, **`supports es6-module`** (replaces invalid **`supports es2022`** query).
- **`build:fast`**: `tsc --noEmit && vite build`; **`build`**: `validate-registry` + **`build:fast`**.

### 2026-03-30: Vite build/dev options

- **`base`**: `'/'` with comment for GitHub Pages (`'/repo-name/'`) or **`'./'`** for relative assets.
- **`server`**: **`port: 5173`**, **`strictPort: false`** (next free port if 5173 taken); **`preview`**: **`4173`**, **`strictPort: false`**.
- **`build`**: **`target: 'es2022'`**, **`sourcemap: true`**, **`cssCodeSplit: true`**, **`assetsInlineLimit: 4096`**.
- **`manualChunks`**: named **`manualReactVendorChunk`** — **Rolldown** (Vite 8) rejects Rollup’s object map at runtime; function matches **`node_modules/react/`** / **`react-dom/`** (pnpm-friendly paths).

### 2026-03-30: Vite + TS path alias `@` → `src`

- **`vite.config.ts`**: **`resolve.alias`** `{ '@': resolve(__dirname, './src') }` (Vitest inherits via **`mergeConfig`**).
- **`tsconfig.json`**: **`baseUrl`** `.`, **`paths`** **`"@/*": ["./src/*"]`** (single config for app + Vite + `config/` + `build/`).
- **`src/vite-env.d.ts`**: already declares **`__PACKAGE_VERSION__`** (no change).

### 2026-03-31: abiRegistry hardening (review) — cache, providers, timeouts, ERC-4626 signal

- **`abiRegistry.ts`:** On-chain **`decimals`/`symbol`** cache: **5 min TTL** + **512** entry cap (prune expired, then FIFO); **`getCachedJsonRpcProvider`** per **`(chainId, rpcUrl)`**; **`raceWithTimeout`** races RPC with timeout/abort and **clears `setTimeout`** on settle; **`fetchErc4626UnderlyingAsset(..., signal?)`** uses same pattern and propagates **`AbortError`**; comment above bundled-signature validation (**fail-fast on import**); **`clearOnChainDecimalsCacheForTests()`**.
- **`decoder.ts`:** **`fetchErc4626UnderlyingAsset(vault, chainId, options.signal)`**.

### 2026-03-31: Minor review — opaque 4-byte bytes + abortable token RPC

- **`decoder.ts`:** Nested `decodeCalldata` from dynamic `bytes` runs only if **`byteLen > ABI_SELECTOR_BYTE_LENGTH`** when the value is **not** pattern-marked calldata (avoids selector-only false positives); known-multicall `bytes` unchanged. **`resolveTokenInfo`** passes **`options.signal`** into **`fetchOnChainTokenDecimals`** and drops **`tokenLookupSessionCache`** entries on **`AbortError`**. JSDoc on **`collectResolvedTokensFromParams`** notes parallel RPC + signal limits.
- **`abiRegistry.ts`:** **`fetchOnChainTokenDecimals(address, chainId, signal?)`** races **`decimals()`** / **`symbol()`** (and bytes32 symbol path) via **`raceWithTimeout`**; **`AbortError`** propagates (not swallowed as RPC retry).
- **`types/index.ts`:** **`DecodeOptions.signal`** documents token-metadata behavior vs **`lookupSelector`** fetch.
- **`decoder.test.ts`:** Regression for **`probe(bytes)`** with **`0xdeadbeef`** — no **`.decoded`**.

### 2026-03-31: Review follow-up — architecture/testing notes + decoder tests

- **`decoder.test.ts`:** Coverage for review testing list: **`AbiCoder.decode` spy** returning **`Uint8Array`** for `bytes`; **Gnosis `multiSend` CREATE** with **non-empty** inner data; **normalizeHex** via invalid `_` in hex + **empty / short calldata** selector errors; **`aggregate((address,bytes)[])`** (selector **`0x252dba42`**) for **tuple-array + nested bytes** expansion; **AbortSignal** mid-decode via **`initEthers`** stall + **`vi.spyOn(signatureLookup.initEthers)`** (deterministic).
- **Architecture (review):** Strengths noted; **convertValue split**, **enrichment pipeline**, **`Result<T,E>`** left as optional refactors (not implemented).

### 2026-03-31: Decoder review items 9–11 — types, named sizes, error hex previews

- **`decoder.ts`:** `tryDecode` returns **`unknown[]`** via spread (no `as ReadonlyArray<unknown>`); **`readonly unknown[]`** on **`computeScore`** / **`processDecodedParams`**; constants **`ABI_SELECTOR_BYTE_LENGTH`**, **`SELECTOR_HEX_PREFIX_LENGTH`**, **`GNOSIS_MULTISEND_OPERATION_BYTE_LENGTH`**; Enso / swap-compact / Gnosis / **`convertBytesValue`** use **`ABI_WORD_BYTE_LENGTH`** / selector constants instead of bare **`32`/`4`/`10`**; **`truncateHexForErrorPreview`** (exported) + **`ERROR_HEX_PREVIEW_*`** for all **`DecodedCalldataOutcome`** / **`decodeWithUserAbi`** error **`rawHex`** paths and oversized **`bytes`** warning return value.
- **`App.tsx`:** Unexpected decode catch uses **`truncateHexForErrorPreview(calldata)`** for **`rawHex`**.

### 2026-03-31: Decoder review items 6–8 — tuple split, abort throttling, token cache keys

- **`decoder.ts`:** **`stripMatchingOuterTupleParens`** (bounded unwrap) + **`splitTupleTypes`** preserves **empty** tuple components (e.g. `uint256,,bytes`); **`throwIfDecodeAbortedEvery`** / **`ABORT_CHECK_INTERVAL`** (32) in hot indexed loops; **`tokenLookupCacheKeyPart`** so **`resolveTokenInfo`** cache keys never use **`undefined:`** for bad **`chainId`** (uses **`__chain__`** fallback).
- **`types/index.ts`:** JSDoc for **`signal`** documents throttled abort checks.
- **`decoder.test.ts`:** Tests for outer-paren unwrap and empty tuple components.

### 2026-03-31: `review.md` — post-Venice re-review queue

- Replaced the old “all checked” Venice checklist with a **Post-Venice re-review queue** (tables + unchecked checklist) listing files that changed since that review: **`decoder.ts`**, **`abiRegistry.ts`**, **`knownPatterns.ts`**, formatting/warnings (`**valueFormatter**`, **`stablecoinUsd**`, **`warningAnalyzer**`, **`chains**`), UI (**`TreeNode`**, **`DecodeTree`**, **`CalldataInput`**, **`ExplorerAddressLink`**, **`WarningBanner`**, **`ChainContext`**, **`App`**), **`types/index.ts`**, and key tests.

### 2026-03-31: `swapCompact` / `0x83bd37f9` — non-standard packed tail

- **Cause:** OpenChain / 4byte list **`swapCompact()`** (zero ABI args). Calldata after the selector is a **packed blob**, not standard ABI encoding, so **`tryDecode`** rejected it → errors or no structure.
- **`decoder.ts`:** **`tryDecodeSwapCompactOpaque`** — if lookup is empty or **all candidates fail**, treat everything after the 4-byte selector as **`compactPayload` `bytes`** (hex string into **`convertValue`**). **`fieldHint`** explains the mismatch. **`knownPatterns`:** **`direct`** on param 0 + **`requiresSpecialHandling`** + description.
- **`decoder.test.ts`:** regression with user-style hex. Minor TS narrow on Uniswap V3 **`params`** tuple (**`p.value.kind !== 'tuple'`** guard).

### 2026-03-31: ERC-4626 `withdraw(uint256,address,address)` (`0xb460af94`) — USDC amount context

- **Issue:** Calldata matches **`withdraw(uint256,address,address)`** (4byte / ERC-4626). The first argument is **underlying asset** amount, but **`receiver` / `owner` are not the ERC-20** — generic uint enrichment had no token, so amounts did not show as USDC.
- **`abiRegistry.ts`:** Bundled signature **`withdraw(uint256,address,address)`** with param names **`assets`**, **`receiver`**, **`owner`**. **`fetchErc4626UnderlyingAsset(vault, chainId, signal?)`** — RPC **`asset()`** on the vault (same timeout/abort pattern as `decimals()`).
- **`decoder.ts`:** **`tryEnrichErc4626Withdraw`** (depth 0): uses **`callTarget`** as vault, fetches underlying, **`resolveTokenInfo`** + **`applyTokenContextToUintPrimitive`** on **`assets`**; **`fieldHint`** explains ERC-4626 semantics and **To** field.
- **`decoder.test.ts`:** Mock **`fetchErc4626UnderlyingAsset`** → Arbitrum native USDC; user sample hex.

### 2026-03-31: `swapCompact` — zero-arg DB signature ate the tail

- **Issue:** OpenChain / 4byte return **`swapCompact()`** with **no parameters**. **`AbiCoder.decode([], tail)`** succeeds and **ignores** trailing bytes, so **`tryDecodeSwapCompactOpaque`** never ran and the UI showed only **`swapCompact()`**.
- **`decoder.ts`:** Before **`scoreAndDecode`**, if selector is **`0x83bd37f9`**, calldata length past the selector is non-empty, and **no candidate has `params.length > 0`**, call **`tryDecodeSwapCompactOpaque`** first (user ABI with a real multi-arg match still wins).
- **`decoder.swapCompact.apiConflict.test.ts`:** Vitest **`vi.mock('./signatureLookup.ts')`** forces a zero-arg candidate; expects **`compactPayload`** + nested decode.

### 2026-03-31: `swapCompact` — heuristic inner calldata scan

- **Issue:** Packed tails rarely start with a valid 4-byte function selector at offset 0, so nested **`decodeCalldata(cleanHex)`** failed and the UI showed only opaque **`bytes`**.
- **`decoder.ts`:** **`pickBestSwapCompactInnerCalldata`** + **`swapCompactInnerDecodeOffsets`** — when **`outerPattern.selector`** is **`0x83bd37f9`**, try **`decodeCalldata`** from up to **200** start offsets in the first **~1.5KB** (byte 1–127 plus 4-byte-aligned), skip all-zero selectors, rank by confidence / param count / success. If none match, return raw **`bytes`** (offset-0 already covered in the scan). **`fieldHint`** text mentions the scan.
- **`decoder.test.ts`:** **`approve`** nested after a 4-byte prologue (**`deadbeef`**).

### 2026-03-31: Copy calldata (success/partial) + Skip ENS

- **`DecodeTree`:** **Copy calldata** on the results toolbar for **success** and **partial** decodes (same control as error path); copies `call.rawCalldata`.
- **`ChainContext` / `App`:** **`skipEns`** + **`setSkipEns`**; decode options use **`resolveEns: !offlineMode && !skipEns`**. Hash bootstrap **`useEffect`** re-decodes when **`skipEns`** changes.
- **`CalldataInput`:** **Skip ENS** checkbox when not offline; status hint **ENS lookups disabled** when set.
- **`ExplorerAddressLink`**, **`TreeNode` `ValueDisplay`:** Respect **`skipEns`** so explorer/header links don’t fire ENS RPC when skipped.
- **Lint:** no synchronous **`setEnsName(null)`** in **`ExplorerAddressLink`** effect (stale name hidden via **`showEns`**).

### 2026-03-31: Multicall tuple field names + f(x)/Convex reward pool labels

- **`decoder.ts`:** **`semanticTupleFieldNames`** — `(address,bytes)` → **`target`**, **`callData`**; Multicall3 **`(address,bool,bytes)`** and **`aggregate3Value`** row shape **`(address,bool,uint256,bytes)`** get matching names (**`allowFailure`**, **`value`**).
- **`abiRegistry.ts`:** Mainnet **`KNOWN_CONTRACTS`** — three user-supplied addresses (Convex/f(x) reward-style pools, vault-specific names not verified) labeled **`f(x) / Convex ecosystem: reward pool`**.
- **`knownPatterns.ts`:** **`aggregate`** (`0x252dba42`) comment + description note **Multicall2 / Multicall3**.
- **Tests:** **`npm run validate-registry`** + **`npm test`** pass.

### 2026-03-31: Pendle `swapTokensToTokens` — nested step `bytes` expansion

- **Issue:** Swap rows use a single `(uint8,address,bytes,bool)` step tuple (field 3). The tuple-field hint targeted that field, but `isDynamicBytesSolidityType` on the **whole tuple** produced a useless `direct` hint (only raw `bytes` params expand), so inner router payloads stayed as raw hex.
- **`decoder.ts`:** For `tuple-field` + `expectedFieldType: 'bytes'`, if the field is a **non-array tuple** containing `bytes`, push nested **`tuple-field`** to the top-level **`bytes` slot** (`expectedParentType: 'tuple'`) so `convertBytesValue` runs nested `decodeCalldata`.
- **`abiRegistry.ts`:** Bundled **`executeCurve(bytes,uint256)`** (`0xd90ce491`) for Curve legs inside step bytes. **Not added:** OpenChain `swap((…))` (`0xe21fd0e9`) — `AbiCoder.decode` can succeed but **`processDecodedParams`** hits ethers overflow while expanding huge nested arrays in real Pendle payloads.
- **`knownPatterns.ts`:** Description updated (single step tuple vs array). **`decoder.test.ts`:** Encode/decode path uses one step tuple; expect nested **`transfer`** on inner bytes.

### 2026-03-31: Warning clarity — `TxWarning.context`

- **`TxWarning`**: optional **`context`** — where in the decode tree / tx the rule fired and **why** (selector, function name, depth, tx `to` label).
- **`WarningBanner`**: shows **`context`** in smaller mono under the title, then **`message`** (user-facing explanation).
- **`warningAnalyzer`**: most rules set **`context`** (e.g. Across SpokePool shape lives in **`context`**; token/chain hints stay in **`message`**). **`decoder`** decode-cap warnings include **`context`** where relevant.
- **Tests:** assertions that referenced **“Across SpokePool V2”** in **`message`** now check **`context`** (+ selector).

### 2026-03-31: Enso `routeData` → `executeShortcut` + `commands[]` nesting

- **Tx `0xe4c28236…`:** On-chain **`msg.value`** ≈ **0.000087 ETH**; large swap/bridge notionals sit in **`routeData`** as **`executeShortcut` → `commands[]`**, previously shown as undecoded hex.
- **`abiRegistry`:** Bundled **`executeShortcut(bytes32,bytes32,bytes32[],bytes[])`** (`0x95352c9f`); **1inch** **`swap(…)`** variant **`0x90411a32`** (OpenChain shape) for inner aggregator calls.
- **`knownPatterns`:** **`ENSO_EXECUTE_SHORTCUT_SELECTOR`** export; **`routeMulti`** — **`direct`** on **`routeData`**; **`executeShortcut`** — **`array-direct`** on **`commands`**.
- **`decoder.ts`:** **`tryExpandEnsoShortcutCommandBytes`** — Enso **`commands[]`** cells are often **`abi.encode(uint256 length, bytes payload)`**; scans **32-byte-aligned** starts inside **`payload`** (up to 96 words) to find nested calldata (e.g. nested **`executeShortcut`** at word 3).
- **`warningAnalyzer`:** **`Enso executeShortcut`** info; **`Enso routeMulti`** text distinguishes **`msg.value`** from amounts inside inner calls.
- **Tests:** `decoder.test.ts` (length-prefixed command + full **`routeMulti`** chain), `knownPatterns.test.ts`. **`ensoE4c28236.integration.test.ts`** — live mainnet RPC (multi-endpoint retry); **`npm run test:integration`**; default **`vitest.config.ts`** excludes **`*.integration.test.ts`**.

### 2026-03-31: Padded addresses inside dynamic `bytes`

- **`DecodedValue` `bytes`:** optional **`wordAlignedAddresses`** (**`WordAlignedAddressHit`**: 32-byte word index, checksummed, registry label, ENS).
- **`decoder`:** post-decode tree walk + **`scanHexForWordAlignedPaddedAddresses`**; **`collectEnsTargets`** batches ENS for those hits.
- **`TreeNode`:** **“Padded addresses (32-byte ABI words…)”** with **`ExplorerAddressLink`** (above nested decode when **`decoded`** exists).
- **Tests:** `valueFormatter.test.ts`.

### 2026-03-31: ENS reverse resolution + explorer links for all addresses

- **`ensLookup.ts`**: `reverseResolveEns` via Ethereum **mainnet** `lookupAddress` (CHAINS[1] RPCs, timeout, deduped promise cache). Explorer URLs still use the **selected chain** (`getExplorerUrl(chainId)`).
- **`DecodeOptions.resolveEns`** (default true): decoder walks decoded trees and sets `ensName` on `address` values; skipped when `offlineMode` or `resolveEns === false`.
- **`ChainContext`**: `{ chainId, offlineMode, setOfflineMode }` — `useChainId`, `useOfflineMode`, `useChainUi`; offline hides ENS in tree even if prior decode cached names.
- **UI**: `ExplorerAddressLink` (tx info bar, optional To, native-transfer summary) — ENS primary, short hex hint, registry label, copy checksummed, explorer link. **`TreeNode`** address rows: same pattern + existing copy button copies **checksummed** address only.
- **Tests**: `ensLookup.test.ts` (zero/offline/invalid, cache + retry + detailed mocks).

### 2026-03-31: LayerZero OFT `send` (USDT0) — `callTarget`, registry, bridge hint

- **Why:** Tx `0xf12e8c…` calls USDT0 OFT `send` (`0xc7c7f5b3`); token amounts are in the first tuple (`amountLD` / `minAmountLD`) but the **token is the contract at `to`**, not a calldata address—generic enrichment never attached decimals/symbol.
- **`DecodeOptions.callTarget`:** Set from tx `to` / optional “To” field in `App.tsx`. Stripped on nested `decodeCalldata` (`depth > 0`) so inner frames do not reuse the outer target.
- **`decoder.ts`:** `tryEnrichLayerZeroOftSend` after tuple pre-pass; maps tuple fields 2–3 to `resolveTokenInfo(callTarget)` when selector and tuple shape match.
- **`abiRegistry.ts`:** Bundled `send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),…)`; mainnet `0x6c96de32…` as **USDT0** token (6) + contract label **USDT0 (LayerZero OFT)**.
- **`warningAnalyzer.ts`:** Info banner for LayerZero OFT bridge pattern.
- **`stablecoinUsd.ts`:** `USDT0` in USD-peg display set. Tests: `decoder.test.ts` (mainnet calldata + `callTarget`), `stablecoinUsd.test.ts`.

### 2026-04-01: `formatUint256` timestamp heuristic vs ERC-20 `approve` amounts

- **Issue:** Any 10-digit uint in `[1e9, 9999999999]` was shown as **Timestamp:** — false positive for values like **`5000148499`** (typical raw 6-decimal stable **approve** amount).
- **`valueFormatter.ts`:** Cap Unix-second heuristic at **`2_147_483_647`** (32-bit `time_t` max, ~Jan 2038) so larger 10-digit amounts are not labeled as dates.
- **Tests:** **`valueFormatter.test.ts`** — approve-style amount has no timestamp line.

### 2026-04-04: Single `tsconfig.json` (fewer root JSON files)

- Removed **`tsconfig.app.json`** and **`tsconfig.node.json`**; one **`tsconfig.json`** covers **`src`**, **`vite.config.ts`**, **`config/**/*.ts`**, **`build/**/*.ts`** with **`types`**: **`vite/client`**, **`node`** and app **`lib`**.
- **`package.json`**: **`build:fast`** / **`type-check`** use **`tsc --noEmit`** (no project references).

### 2026-04-04: `abiRegistry` — module doc + bundled selector collision ordering

- **`abiRegistry.ts`:** Module-level JSDoc (security: proxies, risk tiers, `getAddress` normalization; ops: bundle size / remote refresh as future work, per-`chainId` maps vs CREATE2 dedupe, selector collision note). **`compareBundledSignaturesByRank`** (`deprecated` last, then `popularity` desc, then `textSignature`); **`selectorMap`** buckets with length > 1 sorted once at load.
- **`abiRegistry.test.ts`:** Tests for **`compareBundledSignaturesByRank`**.

### 2026-04-04: `CalldataInput` — session calldata draft (tab-scoped)

- **`CalldataInput.tsx`:** **`sessionStorage`** key **`rec_dec_calldata_draft_v1`** (max **512k** chars); debounced **400ms** persist on textarea change, tx-fetch calldata, and switching back to Calldata mode. One-time hydrate when URL **#** has no valid hex. **`initialCalldata === null`**: first mount does **not** clear the field; after a non-empty URL-driven calldata was applied, **`null`** clears field + storage (for future parent `setInitialCalldata(null)`). Hint line under calldata field.
- **Items not changed:** ABI validation timing (still intentional), chain-abort effect, mobile layout.

### 2026-04-04: Decode tree — horizontal scroll + TreeNode bundle note

- **`DecodeTree.tsx`:** Tree view wrapped in **`min-w-0 overflow-x-auto`** so deep indentation scrolls on narrow screens.
- **`TreeNode.tsx`:** File header documents static imports vs tree-shaking for **`curveRouterSwapParams`** / **`treeExpandPolicy`**.

### 2026-04-04: `chains.ts` — HyperEVM RPC fallbacks + explorer JSDoc

- **`chains.ts`:** HyperEVM (**999**) **`rpcs`**: official + **`rpc.hypurrscan.io`** + **`hyperliquid.drpc.org`** (verified HTTP 200 to `eth_chainId`). **`ChainConfig.explorerUrl`** / **`getExplorerUrl`** JSDoc: base URL only; callers append **`/tx/`** / **`/address/`**. **`BRIDGE_EVM_CHAIN_NAME_OVERRIDES`** comment clarifies **999** vs Wanchain chainlist collision. Polygon **`POL`** inline note (post-MATIC migration).
- **`chains.test.ts`:** HyperEVM multi-RPC assertion.

### 2026-04-04: `warningAnalyzer` — review follow-up (heuristics + docs)

- **`warningAnalyzer.ts`:** **`HEURISTIC_ETH_USD_PER_UNIT`** / **`HEURISTIC_BTC_USD_PER_UNIT`** (same numeric anchors as before; JSDoc to revisit periodically). **Suspicious function name** skipped when name is **`multicall`** (case-insensitive) and **`isKnownMulticallSelector`** (avoids duplicate noise vs curated batch patterns). **`setApprovalForAll`** copy notes **ERC-721 + ERC-1155**. **`findParamByNameOrType`** JSDoc on type-fallback risk.

### 2026-04-04: `valueFormatter` — word-aligned address scan cache + idempotent enrichment

- **`valueFormatter.ts`:** **`scanHexForWordAlignedPaddedAddresses`** uses **LRU** (256 entries, 15m TTL) keyed by **`chainId` + normalized hex**; returns shallow copies from cache; **`clearWordAlignedAddressScanCacheForTests()`**.
- **`decoder.ts`:** Bytes enrichment sets **`wordAlignedAddresses`** once (**`[]`** when no hits) so rescans are skipped if enrichment ever runs twice on the same node.
- **`types/index.ts`:** JSDoc on **`bytes.wordAlignedAddresses`**.

### 2026-04-04: `signatureLookup` — retries, conditional 4byte, warmCache chunking

- **`signatureLookup.ts`:** **`fetchWithTimeoutAndRetries`** (3 attempts, exponential backoff from **400ms**; **0ms** in Vitest); retries on throw and HTTP **408/429/502/503/504**. **Sourcify + OpenChain** run first; **4byte.directory** runs only if deduped prior count **< `SIGNATURE_LOOKUP_FOURBYTE_SKIP_MIN_PRIOR` (5)**; **`shouldFetchFourbyteAfterPriorMerge`** exported for tests. **`warmCache`** processes selectors in **8**-wide chunks. **`initEthers`** unchanged (decoder hook).
- **`signatureLookup.test.ts`:** Threshold helper tests; Sourcify **503** retry test.

### 2026-04-04: Tree expand policy — pluggable rules, expansion weight, edge cases

- **`treeExpandTypes.ts`**: **`ComputeInitialExpandedInput`**, **`ExpansionRule`**, **`ExpandableNodeKind`**.
- **`curveRouterNgAbi.ts`**: Single source for router-ng **`CURVE_ROUTER_NG_SWAP_PARAMS_*`** strings / matrix dimensions + **`CURVE_ROUTER_NG_SWAP_PARAMS_PARAM_ALIASES`** (forks add names here); used by **`curveExpandRules`** and **`curveRouterSwapParams`**.
- **`curveExpandRules.ts`**: Curve swap-params / hop rules + **`isCurveSwapParamsOuterMatrix`**; module doc explains why the matrix defaults collapsed.
- **`treeExpandPolicy.ts`**: **`DEFAULT_EXPANSION_RULES`**, negative-depth + empty-array rules, **`computeInitialExpanded(input, { rules? })`** fallback `depth = max(0, depth)`.
- **`TreeNode.tsx`**: Replaced **`insideCurveSwapParamsHop`** with **`expansionWeight`** (thresholded in rules).

### 2026-04-04: ENS lookup — settled LRU, retries, provider reuse, detailed status

- **`ensLookup.ts`**: **5 min** settled **LRU** (plus **~45s** TTL for all-RPC-fail); **per-RPC exponential backoff** retries; **reused** `JsonRpcProvider` per URL (`staticNetwork: true`); **`isValidName`** on resolver strings → **`invalid_reverse_record`** vs **`no_reverse_record`** vs **`rpc_unavailable`**. **`reverseResolveEnsDetailed`** + **`clearEnsLookupCaches`** (tests). **`reverseResolveEns`** unchanged for callers (`string | null`).

### 2026-04-04: `txFetcher.ts` — circuit breaker, batch prefetch, WS note

- **Per-RPC circuit breaker**: after **3** failed attempts on one endpoint (same exponential backoff as before), that URL is skipped for **30s** (`endpointCircuitOpenUntil`); success clears the trip. **`RpcEndpointCircuitOpenError`** when open; **`aggregateAllRejected`** surfaces an “temporarily unavailable” message when every endpoint is open.
- **`prefetchTxCalldata(hashes, chainId, options?)`**: dedupes valid hashes, skips cache hits, sends **one JSON-RPC batch** (`eth_getTransactionByHash`, max **32** per request) on the first non-open RPC, then **`Promise.allSettled`** of **`fetchTxCalldata`** for misses (errors ignored — cache warming only).
- **Test hooks**: **`setTxFetcherCircuitOpenMsForTests`**, **`resetTxFetcherCircuitConfigForTests`**, **`clearTxFetcherEndpointCircuits`** (Vitest resets circuit duration + map in **`afterEach`**).
- **WebSocket**: module comment documents intentional **HTTP-only** transport (no `eth_subscribe` in this layer).

### 2026-04-04: `signatureValidator.ts` — Unicode IDs, tuple names, multi-error collect, parse cache

- **`SIGNATURE_IDENTIFIER_REGEX`**: same Unicode / ASCII rules as function names; user-defined types use it (replaces ASCII-only user-type check). **`SIGNATURE_FUNCTION_NAME_REGEX`** remains an alias.
- **Named params / tuple fields**: **`stripTrailingSolidityParameterName`** strips `type name` when the name is an identifier and not a keyword tail (`external`, `memory`, …); **`normalizeSignatureParamType`** / validation use it so canonical text matches selector hashing.
- **Linter-style API**: **`validateTextSignatureCollectErrors`**, **`formatValidationErrors`**; shared LRU with **`validateTextSignature`** via **`collectErrorsCache`**.
- **Canonical cache**: **`canonicalParsedCache`** stores **`ParsedTextSignature | null`** instead of pre-built strings; **`canonicalizeTextSignature`** / **`parseTextSignature`** stay in sync on the same parsed entries.

### 2026-04-04: `decoder.test.ts` — fixtures, parameterized multiSend, snapshot, perf

- **`src/fixtures/decoderCalldataHex.ts`**: mainnet calldata (`CURVE`, `ACROSS`, `LAYERZERO` groups + flat aliases); comments include **block numbers** + tx hashes. **`src/fixtures/mainnetAddresses.ts`**: e.g. **`USDT0_OFT_MAINNET`** for send tests. Curve blob synced to canonical **`input`** from tx `0x9c693a14…` via RPC (prior inline copy had a corrupted middle segment and broke decode).
- **multiSend**: `it.each` over CALL / DELEGATECALL / CREATE for single empty-inner packed ops; **`src/lib/__snapshots__/decoder.test.ts.snap`**: structural snapshot for Curve decode (signature, selector, confidence, param names/types).
- **Performance**: `multicall(bytes[])` with **`DEFAULT_MAX_PATTERN_ARRAY_EXPAND`** (200) empty segments must finish within 3s (known pattern cap is 200, not 1000).

### 2026-04-26: Docs cleanup — root README canonical

- Removed **`docs/ROADMAP.md`** and **`docs/README.md`** (docs index). **`docs/error-boundary.md`** remains.
- **`README.md`**: dropped Contributing link to ROADMAP. Pushed to **`origin/main`** (GitHub) and **`rad`** (Radicle); Radicle tree: `e00ba8a`.

### 2026-06-12: Clear Signing (ERC-7730) — fit assessment

- Cursor chat on https://clearsigning.org/ (ERC-7730 descriptors): judged a strong fit for rec_dec as a
  **rehearsal / inspection UI** (show what a wallet's clear-signing view would display for decoded calldata),
  not as a signing wallet. No code written.

### 2026-08-22: Live site check

- recdec.eth.limo loads: HTML, JS and CSS served, React UI mounts. IPFS root at the time:
  `bafybeia653mbdpkfly5nsyzvsw2ppswx7d2vnzmxbugvcn7fo72bhbtnhi`.

_2026-11-02: about 36 checkpoint entries from unrelated Cursor chats run in this folder (3D printing,
Instar, hardware) were removed from here; a full copy of the earlier file is in the gitignored_
_`_archive/AGENT_SESSION_ARCHIVE.2026-11-02.md`._

### 2026-11-02 — Claude Code onboarding + context cleanup

- Claude Code took over as lead dev. Installed deps, verified lint / types / tests / build.
- Rewrote this file: it had filled with SHKG checkpoint entries from unrelated Cursor chats run in
  this folder (3D printing, Instar, M5 order). Old copy kept at
  `_archive/AGENT_SESSION_CONTEXT.2026-11-02.md` (gitignored).
- Also removed the 36 off-topic entries from the tracked `docs/history/AGENT_SESSION_ARCHIVE.md`
  (kept the Clear Signing and live-site entries, rewritten cleanly). Full prior copy:
  `_archive/AGENT_SESSION_ARCHIVE.2026-11-02.md`.
- Commits `b0a6e2f` (history cleanup) and `d3160c6` (CI: checkout + setup-node v4 → v7, clears the
  Node 20 deprecation warning) pushed to `rad` and `origin`; CI green. GitHub mirror is caught up.
- If off-topic entries come back, the source is Cursor's handoff hook
  (`selfhosted/scripts/cursor-memory/handoff.ts`), which writes every chat into the open workspace's file.
