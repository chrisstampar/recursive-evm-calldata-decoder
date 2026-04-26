# Roadmap & future upgrades

Batch feedback and planned work here, then ship a **single release** (code + IPFS re-pin + ENS `contenthash` update when the UI changes).

## IPFS / hosting

- [ ] Re-pin production build so **recdec.eth.limo** serves the latest `dist/` (pending on IPFS: in-app **GitHub** link, **new icons** — `favicon.svg` / `icon-192.png` / `icon-512.png`, updated **`og:image`** + manifest — all merged to GitHub but the live ENS site still needs **`npm run build:ipfs`** → Pinata → ENS `contenthash` update).
- [ ] Optional: document Pinata upload steps in README or `docs/` once the flow is stable.
- [ ] Optional: **IPNS** (or similar) to reduce how often ENS `contenthash` must change.

## UI / UX (feedback-driven)

_Add items as they come in from users or your own notes._

- _(example)_ Keyboard shortcuts for decode / clear.
- _(example)_ Persist chain selection in `localStorage`.

## Features

- _(example)_ Export decoded tree as downloadable file.
- _(example)_ Deep-link or share presets beyond URL hash calldata.

## Quality / engineering

- _(example)_ Chunk-size / lazy-route follow-up if the main bundle grows.
- _(example)_ Integration test coverage for new protocols in `abiRegistry`.

## Docs / repo

- _(example)_ CHANGELOG for tagged releases.
- _(example)_ Issue templates when triage volume justifies it.

---

**How to use this file:** append bullets under the right section (or add a section). When you’re ready to ship, turn checked ideas into PRs/commits, run `npm run build:ipfs`, pin, update ENS if needed, and tick items here in the same PR or follow-up.
