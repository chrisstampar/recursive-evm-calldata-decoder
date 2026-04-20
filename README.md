# Recursive Calldata Decoder

A **client-side** web tool that recursively decodes Ethereum transaction calldata into a human-readable tree. Unlike decoders that only show the top-level call, this expands **multicalls**, **batched transactions**, and **nested ABI-encoded `bytes`** until each layer is decoded—entirely in the browser.

## Features

- **Recursive decoding** -- Multicalls, `aggregate`, `multiSend`, and nested `bytes` fields are expanded automatically into a navigable tree
- **Transaction hash lookup** -- Paste a tx hash instead of raw calldata; the tool fetches calldata from public Ethereum RPCs
- **3-tier signature resolution** -- Bundled ABIs (instant) -> [openchain.xyz](https://openchain.xyz) -> [4byte.directory](https://www.4byte.directory) as fallback
- **Token-aware formatting** -- `uint256` values adjacent to known token addresses (USDC, WETH, DAI, etc.) are formatted with correct decimals and symbol
- **Smart value interpretation** -- EIP-55 checksummed addresses with Etherscan links, known contract labels, timestamp detection, max-uint256 detection, zero address labeling
- **Confidence scoring** -- When multiple signatures match a selector, candidates are scored and the best match is shown with alternatives available
- **Offline mode** -- Toggle to use only bundled ABIs with zero network requests
- **Custom ABI support** -- Paste a contract ABI JSON for guaranteed-correct decoding with named parameters
- **URL sharing** -- Decoded calldata is stored in the URL hash for easy sharing
- **JSON export** -- Switch between tree view and raw JSON, with one-click copy
- **Pure client-side** -- No backend, no data leaves your browser

## Supported Protocols

Bundled function signatures for instant, offline decoding:

- Multicall2 / Multicall3 (`aggregate`, `tryAggregate`, `aggregate3`)
- Uniswap V2 Router, V3 SwapRouter, SwapRouter02, Universal Router
- ERC-20 / ERC-721 / ERC-1155 standard functions
- WETH `deposit` / `withdraw`
- Gnosis Safe `execTransaction` / `multiSend`
- Aave V3 Pool (`supply`, `withdraw`, `borrow`, `repay`)
- Permit2

Known token addresses with decimal metadata: WETH, DAI, USDC, USDT, WBTC, LINK, UNI, AAVE, MATIC, PEPE, SHIB.

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

**Node:** use **v22** (see `.nvmrc`) to match CI. **Repository:** [github.com/chrisstampar/recursive-evm-calldata-decoder](https://github.com/chrisstampar/recursive-evm-calldata-decoder).

## Deploying

The output is **static files** under `dist/` after `npm run build`. Host on any static file host (GitHub Pages, Cloudflare Pages, Netlify, S3 + CloudFront, nginx, etc.). Set the server **root** to `dist/` and ensure **SPA fallback** to `index.html` for client-side routes if you use path-based hosting.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs lint, typecheck, unit tests, and a full production build.

## Tech Stack

- [Vite](https://vitejs.dev/) -- Build tool and dev server
- [React 19](https://react.dev/) -- UI framework
- [TypeScript](https://www.typescriptlang.org/) -- Strict mode enabled
- [Tailwind CSS v4](https://tailwindcss.com/) -- Styling
- [ethers.js v6](https://docs.ethers.org/v6/) -- ABI encoding/decoding, address checksumming

## Project Structure

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

## Error boundary usage

[`ErrorBoundary`](src/components/ErrorBoundary.tsx) supports `fallback`, `onError`, and `onReset`. Use **`onError`** for logging or services like Sentry (it runs in dev and prod). **`onReset`** runs only when the **built-in** “Try again” path is used—if you pass a custom `fallback`, wire recovery (and any cache clear) inside that UI yourself.

**Larger surfaces (routes, layout shells)** — custom fallback plus monitoring:

```tsx
<ErrorBoundary
  fallback={<RouteErrorFallback />}
  onError={logToSentry}
>
  <RouterProvider router={router} />
</ErrorBoundary>
```

**Isolated widgets** — refresh data on reset; surface failures to the user:

```tsx
<ErrorBoundary
  onReset={refreshData}
  onError={() => toast.error('Widget failed')}
>
  <ComplexChart />
</ErrorBoundary>
```

`RouteErrorFallback`, `logToSentry`, `refreshData`, and `toast` are placeholders for your app’s components and helpers.

## Security

- **No backend** -- All decoding happens client-side; calldata never leaves your browser
- **Content Security Policy** -- Strict CSP via meta tag restricting scripts, styles, and network connections to known endpoints
- **Input validation** -- Strict hex format validation with size limits before any processing
- **Output sanitization** -- Decoded string values are sanitized to prevent XSS
- **Signature validation** -- External API responses are validated against strict format rules before use
- **API timeouts** -- All external lookups have timeouts to prevent hanging
- **Recursion depth cap** -- Configurable max depth (default 10) prevents stack overflow on adversarial input
- **Small runtime footprint** -- Core runtime: `react`, `react-dom`, `ethers`, `zod`, and `lru-cache` (see `package.json`)

## How It Works

1. Extract the 4-byte function selector from calldata
2. Look up matching function signatures (bundled ABIs -> openchain.xyz -> 4byte.directory)
3. Attempt ABI decoding with each candidate; score results for plausibility
4. For each decoded `bytes` or `bytes[]` parameter, check if it contains further calldata (via known multicall patterns or opportunistic detection)
5. Recursively decode nested calldata until all layers are expanded
6. Post-process decoded values: enrich `uint256` fields with token context from sibling address parameters, format addresses with labels and Etherscan links

## License

[MIT](LICENSE)
