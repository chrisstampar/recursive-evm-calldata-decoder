# Recursive Calldata Decoder

<p align="center">
  <a href="https://recdec.eth.limo" title="Open the live app"
    ><img
      src="https://raw.githubusercontent.com/chrisstampar/recursive-evm-calldata-decoder/main/public/icon-512.png"
      width="120"
      height="120"
      alt="Recursive Calldata Decoder app icon"
  /></a>
</p>

[![CI](https://github.com/chrisstampar/recursive-evm-calldata-decoder/actions/workflows/ci.yml/badge.svg)](https://github.com/chrisstampar/recursive-evm-calldata-decoder/actions/workflows/ci.yml)

A **client-side** web tool that recursively decodes Ethereum transaction calldata into a human-readable tree. Unlike decoders that only show the top-level call, this expands **multicalls**, **batched transactions**, and **nested ABI-encoded `bytes`** until each layer is decoded—entirely in the browser.

**Live app:** [https://recdec.eth.limo](https://recdec.eth.limo) (ENS + IPFS).

**Any calldata:** the tool decodes **arbitrary** `0x` input using standard ABI rules, selector resolution, and nested-`bytes` heuristics. **Bundled protocol names, contract labels, token metadata, and “≈ USD” hints for known stables** are optional enrichments when there is a match—**nothing in the curated lists is required** for the tree to render or for nested calls to expand.

## Features

- **Recursive decoding** -- Multicalls, `aggregate`, `multiSend`, and nested `bytes` fields are expanded automatically into a navigable tree
- **Transaction hash lookup** -- Paste a tx hash instead of raw calldata; the tool fetches calldata from public Ethereum RPCs
- **3-tier signature resolution** -- Bundled ABIs (instant) -> [openchain.xyz](https://openchain.xyz) -> [4byte.directory](https://www.4byte.directory) as fallback
- **Token-aware formatting** -- When sibling parameters include **known token addresses**, adjacent `uint256` amounts use that token’s decimals and symbol (and, for configured stablecoins, an approximate USD peg line where applicable)
- **Smart value interpretation** -- EIP-55 checksummed addresses with explorer links, known contract labels, timestamp detection, max-uint256 detection, zero address labeling
- **Confidence scoring** -- When multiple signatures match a selector, candidates are scored and the best match is shown with alternatives available
- **Offline mode** -- Toggle to use only bundled ABIs with zero network requests
- **Custom ABI support** -- Paste a contract ABI JSON for guaranteed-correct decoding with named parameters
- **URL sharing** -- Decoded calldata is stored in the URL hash for easy sharing
- **JSON export** -- Switch between tree view and raw JSON, with one-click copy
- **Pure client-side** -- No backend; calldata never leaves your browser for decoding logic

## Supported protocols (bundled shortcuts)

Bundled function signatures and contract labels speed up **common** patterns when the `to` selector and shapes match—they do **not** limit what raw calldata you can paste.

- Multicall2 / Multicall3 (`aggregate`, `tryAggregate`, `aggregate3`)
- Uniswap V2 Router, V3 SwapRouter, SwapRouter02, Universal Router
- **Curve** Router (`exchange`, related routing)
- **Pendle** Router V4 and related (`swapTokensToTokens`, limit router / SY paths where bundled)
- ERC-20 / ERC-721 / ERC-1155 standard functions
- WETH `deposit` / `withdraw`
- Gnosis Safe `execTransaction` / `multiSend`
- Aave V3 Pool (`supply`, `withdraw`, `borrow`, `repay`)
- Permit2
- LayerZero-style `send` (e.g. bundled USDT0 OFT), Across SpokePool `deposit`, Enso-style `execute` / `commands[]` shortcuts (see `abiRegistry.ts` / `knownPatterns.ts` for the live set)

**Stablecoins & peg-like assets** (among many ERC‑20 entries; multi-chain where noted in the registry): **USDC**, **USDT**, **DAI**, **fxUSD** / **fxBASE** (save), **GHO**, **crvUSD**, **FRAX**, **LUSD**, **PYUSD**, **RLUSD**, **USDS**, **USDe**, **sUSDe**, **sDAI**, **USDT0** (LayerZero OFT), plus common majors (**WETH**, **WBTC**, **LINK**, **UNI**, **AAVE**, **PENDLE**, …). Full tables live in **`src/lib/abiRegistry.ts`**.

## Getting Started

```bash
git clone https://github.com/chrisstampar/recursive-evm-calldata-decoder.git
cd recursive-evm-calldata-decoder
npm ci

# Development server (http://localhost:5173)
npm run dev

# Production build (writes dist/ — run validate-registry + tsc + vite build)
npm run build

# Preview production build locally
npm run preview
```

**Node:** **≥20.19** (`package.json` `engines`); CI uses **Node 22**. **Repository:** [github.com/chrisstampar/recursive-evm-calldata-decoder](https://github.com/chrisstampar/recursive-evm-calldata-decoder).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs lint, typecheck, unit tests, and a full production build.

**Repository link preview (Twitter, Discord, etc.):** GitHub does not use `favicon` for that. Set **Settings → General → Social preview** and upload **`public/icon-512.png`** (or a 1280×640 image).

## Repository layout

```
config/           # ESLint + Vitest flat configs (keeps repo root smaller)
docs/             # Extra guides (e.g. error boundary patterns)
build/            # validate-registry script (bundled ABI checks)
scripts/          # Maintenance scripts (chain names, etc.)
src/              # Application source
public/           # Static assets, manifest; brand mark `favicon.svg` — run `npm run gen:icons` after editing it
```

## Tech Stack

- [Vite](https://vitejs.dev/) -- Build tool and dev server
- [React 19](https://react.dev/) -- UI framework
- [TypeScript](https://www.typescriptlang.org/) -- Strict mode enabled
- [Tailwind CSS v4](https://tailwindcss.com/) -- Styling
- [ethers.js v6](https://docs.ethers.org/v6/) -- ABI encoding/decoding, address checksumming

## Project structure (`src/`)

```
src/
├── types/index.ts          # Core types (DecodedCall, DecodedValue, DecodeResult)
├── lib/
│   ├── decoder.ts          # Recursive decode engine
│   ├── signatureLookup.ts  # 3-tier selector resolution with LRU cache
│   ├── signatureValidator.ts # Text signature format validation
│   ├── abiRegistry.ts      # Bundled ABIs, known contracts, token decimals
│   ├── knownPatterns.ts    # Multicall pattern definitions
│   ├── valueFormatter.ts   # Human-readable value formatting
│   ├── sanitize.ts         # Input validation, output sanitization
│   └── txFetcher.ts        # Ethereum RPC transaction fetcher
├── components/
│   ├── CalldataInput.tsx   # Input form (calldata + tx hash modes)
│   ├── DecodeTree.tsx      # Result display with tree/JSON toggle
│   ├── TreeNode.tsx        # Recursive tree node rendering
│   └── ErrorBoundary.tsx   # React error boundary
├── App.tsx                 # Root component and decode orchestration
└── main.tsx                # Entry point
```

Using `ErrorBoundary` outside this app shell? See [docs/error-boundary.md](docs/error-boundary.md).

## Security

For **private vulnerability reports**, see [SECURITY.md](SECURITY.md).

- **No backend** -- All decoding happens client-side; calldata never leaves your browser for decode logic
- **Content Security Policy** -- Strict CSP via meta tag restricting scripts, styles, and network connections to known endpoints
- **Input validation** -- Strict hex format validation with size limits before any processing
- **Output sanitization** -- Decoded string values are sanitized to prevent XSS
- **Signature validation** -- External API responses are validated against strict format rules before use
- **API timeouts** -- All external lookups have timeouts to prevent hanging
- **Recursion depth cap** -- Configurable max depth (default 10) prevents stack overflow on adversarial input
- **Small runtime footprint** -- Core runtime: `react`, `react-dom`, `ethers`, `zod`, and `lru-cache` (see `package.json`)

## How it works

1. Extract the 4-byte function selector from calldata
2. Look up matching function signatures (bundled ABIs -> openchain.xyz -> 4byte.directory)
3. Attempt ABI decoding with each candidate; score results for plausibility
4. For each decoded `bytes` or `bytes[]` parameter, check if it contains further calldata (via known multicall patterns or opportunistic detection)
5. Recursively decode nested calldata until all layers are expanded
6. Post-process decoded values: enrich `uint256` fields with token context from sibling address parameters, format addresses with labels and explorer links

## License

[MIT](LICENSE)
