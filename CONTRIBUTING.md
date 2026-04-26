# Contributing

Thanks for helping improve the Recursive Calldata Decoder.

## Prerequisites

- **Node.js** ≥ **20.19** and **npm** ≥ **10** (see `package.json` `engines`).

## Setup

```bash
git clone https://github.com/chrisstampar/recursive-evm-calldata-decoder.git
cd recursive-evm-calldata-decoder
npm ci
```

If `npm run build` fails with an **esbuild wrong platform** error (for example after copying `node_modules` from another CPU or mixing Rosetta and native Node), delete `node_modules` and run **`npm ci`** again on the machine you develop on.

## Checks before a PR

```bash
npm run lint
npm run type-check
npm test
npm run build
```

ESLint and Vitest configs live under **`config/`** (see `package.json` scripts).

If you change **`public/favicon.svg`**, regenerate PNGs with **`npm run gen:icons`** (updates `favicon-32x32.png`, **`icon-192.png`**, **`icon-512.png`** for manifest / OG / Apple touch).

`npm run build` runs the bundled-signature registry validator and a production Vite build; it must pass for changes that touch `src/lib/abiRegistry.ts` or bundled signatures.

## Live-RPC integration tests (optional)

```bash
npm run test:integration
```

These hit public networks and may be slower or flaky on poor connectivity; they are **not** required for every doc-only change.

## Style

- Match existing **TypeScript strict** patterns and file layout under `src/`.
- Prefer **focused PRs** (one concern per branch) with a clear description of user-visible behavior or risk.

## License

By contributing, you agree your contributions are licensed under the **MIT License** (`LICENSE`).
