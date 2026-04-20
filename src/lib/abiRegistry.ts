/**
 * Static ABI and address registry (bundled signatures, known contracts/tokens, on-chain decimals helpers).
 *
 * ## Security model
 * - **Proxies:** {@link ContractRegistryEntry.isProxy} + {@link ContractRegistryEntry.implementationSlot} flag
 *   upgradeable contracts (e.g. Aave Pool, Balancer V3 Vault) for UI warnings and future implementation lookup.
 * - **Risk tiers:** {@link ContractRiskLevel} drives registry-based warnings (`critical` > `high` > `medium` > `low`);
 *   see `securityWatchlist.ts` for curated deployments that must keep matching tiers.
 * - **Address normalization:** {@link getContractRegistryEntry} / {@link getTokenInfo} normalize via `getAddress`;
 *   invalid hex returns `undefined` (no throw on lookup paths).
 *
 * ## Operational notes
 * - **Bundle size:** Maps are plain in-memory objects (no JSON parse). Future: code-split per chain if the registry
 *   outgrows initial load budgets.
 * - **Updates:** New tokens/contracts ship with the app; remote refresh / user overrides are not wired here.
 * - **Cross-chain:** Lookup is **per `chainId`** only. CREATE2-identical addresses (e.g. some Pendle / OFT rows)
 *   are duplicated per chain in the maps by design; a shared resolver would need explicit allowlisting to avoid
 *   wrong-network false positives.
 * - **Selector collisions:** Multiple bundled rows sharing one selector (rare) are sorted at load by
 *   {@link compareBundledSignaturesByRank} (`deprecated` last, then `popularity` desc, then `textSignature`).
 *   Deeper disambiguation (calldata length, `tx.to` registry match) belongs in the decoder / lookup layer.
 */

import { Contract, getAddress, JsonRpcProvider, keccak256, toUtf8Bytes } from 'ethers';
import type { FunctionSignature } from '../types/index.ts';
import { CHAINS } from './chains.ts';
import { sanitizeDecodedString } from './sanitize.ts';
import {
  canonicalizeTextSignature,
  formatValidationError,
  parseTextSignature,
  validateTextSignature,
} from './signatureValidator.ts';

/** EIP-1967: `bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)` */
export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export type ContractRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Registry row for a known contract (labels + security hints). */
export interface ContractRegistryEntry {
  name: string;
  /**
   * Same-chain alternate deployments (e.g. proxy vs implementation when both should show this label).
   * Indexed at load into `KNOWN_CONTRACTS` so {@link getContractRegistryEntry} resolves them like the primary map key.
   */
  addresses?: string[];
  /** Transparent / UUPS-style proxy; live implementation may differ from registry ABIs */
  isProxy?: boolean;
  /** Storage slot holding implementation address when `isProxy`; defaults to EIP-1967 in docs/warnings */
  implementationSlot?: string;
  /**
   * Heuristic sensitivity of interacting with this deployment (approvals, pooled assets, arbitrary execution).
   * Drives in-app warnings when the transaction `to` matches.
   */
  riskLevel?: ContractRiskLevel;
  /**
   * Source-code verified on a block explorer when known. Static registry usually omits this; future explorer APIs could set it.
   */
  verified?: boolean;
}

/** Alias for docs / external naming (same shape as `ContractRegistryEntry`). */
export type ContractInfo = ContractRegistryEntry;

/** Per-chain contract labels. Only chains listed here are consulted (no cross-chain fallback). */
const KNOWN_CONTRACTS_RAW: Record<number, Record<string, ContractRegistryEntry>> = {
  1: {
  '0x0000000000000000000000000000000000000000': { name: 'Null Address' },
  '0xca11bde05977b3631167028862be2a173976ca11': { name: 'Multicall3' },
  '0x5ba1e12693dc8f9c48aad8770482f4739beed696': { name: 'Multicall2' },
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { name: 'WETH' },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { name: 'DAI' },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { name: 'USDC' },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { name: 'USDT' },
  /** Curve crvUSD (Ethereum mainnet). */
  '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e': { name: 'crvUSD' },
  '0x6c96de32cea08842dcc4058c14d3aaad7fa41dee': { name: 'USDT0 (LayerZero OFT)' },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { name: 'WBTC' },
  '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': { name: 'MATIC' },
  '0x514910771af9ca656af840dff83e8264ecf986ca': { name: 'LINK' },
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { name: 'UNI' },
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { name: 'AAVE' },
  '0x6982508145454ce325ddbe47a25d4ec3d2311933': { name: 'PEPE' },
  '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': { name: 'SHIB' },
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': { name: 'Uniswap V2 Router' },
  '0xe592427a0aece92de3edee1f18e0157c05861564': { name: 'Uniswap V3 SwapRouter' },
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': { name: 'Uniswap SwapRouter02' },
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': { name: 'Uniswap Universal Router', riskLevel: 'high' },
  '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': { name: 'Uniswap Universal Router V1', riskLevel: 'high' },
  '0x1111111254eeb25477b68fb85ed929f73a960582': { name: '1inch AggregationRouter V5', riskLevel: 'high' },
  '0xf75584ef6673ad213a685a1b58cc0330b8ea22cf': { name: 'Enso: Router V2', riskLevel: 'high' },
  '0x77b2043768d28e9c9ab44e1abfc95944bce57931': { name: 'Stargate: Pool Native' },
  '0x6d6620efa72948c5f68a3c8646d58c00d3f4a980': { name: 'Stargate: Token Messaging' },
  '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5': { name: 'Across SpokePool V2 (Ethereum)' },
  // Aave V3 Ethereum
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': {
    name: 'Aave V3 Pool',
    isProxy: true,
    implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
    riskLevel: 'critical',
  },
  '0x2f39d218133afab8f2b819b1066c7e434ad94e9e': { name: 'Aave V3 Pool Addresses Provider' },
  '0x64b761d848206f447fe2dd461b0c635ec39ebb27': { name: 'Aave V3 Pool Configurator' },
  '0x54586be62e3c3580375ae3723c145253060ca0c2': { name: 'Aave V3 Oracle' },
  '0xc2aacf6553d20d1e9d78e365aaba8032af9c85b0': { name: 'Aave V3 ACL Manager' },
  '0x0a16f2fcc0d44fae41cc54e079281d84a363becd': { name: 'Aave V3 Protocol Data Provider' },
  '0x8164cc65827dcfe994ab23944cbc90e0aa80bfcb': { name: 'Aave V3 Incentives Controller' },
  '0x223d844fc4b006d67c0cdbd39371a9f73f69d974': { name: 'Aave V3 Emission Manager' },
  '0x464c71f6c2f760dda6093dcb91c24c39e5d6e18c': { name: 'Aave Collector (Treasury)' },
  '0xd01607c3c5ecaba394d8be377a08590149325722': { name: 'Aave V3 WETH Gateway' },
  '0xd7852e139a7097e119623de0751ae53a61efb442': { name: 'Aave V3 Debt Swap Adapter' },
  '0x35bb522b102326ea3f1141661df4626c87000e3e': { name: 'Aave V3 Repay With Collateral Adapter' },
  '0xadc0a53095a0af87f3aa29fe0715b5c28016364e': { name: 'Aave V3 Swap Collateral Adapter' },
  '0xcb0b5ca20b6c5c02a9a3b2ce433650768ed2974f': { name: 'Aave V3 StataFactory' },
  '0x19a109d0dcb1268729341732ac146d4a74c7034f': { name: 'Aave V3 Config Engine' },
  '0xfce597866ffaf617efdca1c1ad50ebcb16b5171e': { name: 'Aave V3 Risk Steward' },
  '0xbaa999ac55eace41ccae355c77809e68bb345170': { name: 'Aave V3 Pool Registry' },
  '0x5513224daaeabca31af5280727878d52097afa05': { name: 'Aave V3 GHO Direct Minter' },
  '0xe28e2c8d240dd5ebd0adcab86fbd79df7a052034': { name: 'Aave V3 sDAI Token Wrapper' },
  '0x78f8bd884c3d738b74b420540659c82f392820e0': { name: 'Aave V3 Withdraw Swap Adapter' },
  // Aave V2 Ethereum (legacy, still active)
  '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9': {
    name: 'Aave V2 Lending Pool',
    isProxy: true,
    implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
    riskLevel: 'critical',
  },
  '0xb53c1a33016b2dc2ff3653530bff1848a515c8c5': { name: 'Aave V2 Pool Addresses Provider' },
  '0x311bb771e4f8952e6da169b425e7e92d6ac45756': { name: 'Aave V2 Pool Configurator' },
  '0xa50ba011c48153de246e5192c8f9258a2ba79ca9': { name: 'Aave V2 Oracle' },
  '0x057835ad21a177dbdd3090bb1cae03eacf78fc6d': { name: 'Aave V2 Protocol Data Provider' },
  '0xd784927ff2f95ba542bfc824c8a8a98f3495f6b5': { name: 'Aave V2 Incentives Controller' },
  '0xa0d9c1e9e48ca30c8d8c3b5d69ff5dc1f6dffc24': { name: 'Aave V2 WETH Gateway' },
  '0x52d306e36e3b6b02c153d0266ff0f85d18bcd413': { name: 'Aave V2 Pool Registry' },
  // Aave token
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': { name: 'GHO' },

  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc': { name: 'OpenSea Seaport 1.5' },
  '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': { name: 'Gnosis Safe', riskLevel: 'high' },
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', riskLevel: 'critical' },

  // Curve Finance
  '0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e': { name: 'Curve Finance Router v1.2', riskLevel: 'high' },
  '0x5018be882dcce5e3f2f3b0913ae2096b9b3fb61f': { name: 'Curve USDCfxUSD Pool' },

  // f(x) Protocol
  '0x085780639cc2cacd35e474e71f4d000e2405d8f6': { name: 'fxUSD' },
  '0x65c9a641afceb9c0e6034e558a319488fa0fa3be': { name: 'fxBASE (fxUSD Save)' },
  '0x365accfca291e7d3914637abf1f7635db165bb09': { name: 'FXN' },
  '0x4ec8f6c9f6d79b11c1a189f4dc62371cc0a08a03': { name: 'f(x) Stability Pool' },

  // Pendle — cross-chain constant addresses (CREATE2, same on all EVM chains)
  '0x888888888889758f76e7103c6cbf23abbf58f946': { name: 'Pendle RouterV4', riskLevel: 'high' },
  '0x808507121b80c02388fad14726482e061b8da827': { name: 'PENDLE' },
  '0x30544e00cf296b34a9ee59e5540ae2f9cccd55dd': { name: 'Pendle Reflector' },
  '0x000000000000c9b3e2c3ec88b1b4c0cd853f4321': { name: 'Pendle Limit Router' },
  '0x5542be50420e88dd7d5b4a3d488fa6ed82f6dac2': { name: 'Pendle Oracle' },
  '0x466ced3b33045ea986b2f306c8d0aa8067961cf8': { name: 'Pendle SY Factory' },
  '0xd4f480965d2347d421f1bec7f545682e5ec2151d': { name: 'PendleSwap' },
  '0xa28c08f165116587d4f3e708743b4dee155c5e64': { name: 'Pendle Proxy Admin' },
  '0x2ad631f72fb16d91c4953a7f4260a97c2fe2f31e': {
    name: 'Pendle Governance Proxy',
    isProxy: true,
    implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
  },
  '0x2ed473f528e5b320f850d17adfe0e558f0298aa9': { name: 'Pendle Common Deploy' },
  '0x34c91651a070664279866e5f3d6b4d5f65cbbffb': { name: 'Pendle Spark Oracle Factory' },
  '0x3942f7b55094250644cffda7160226caa349a38e': { name: 'Pendle vePENDLE Airdrop' },
  '0x3dae3d1734ca3c7b3089d4dd03c9876e0a0102b4': { name: 'Pendle Merkle Depositor' },
  '0x992ec6a490a4b7f256bd59e63746951d98b29be9': { name: 'Pendle Decimals Factory' },
  '0x44fb16d078e9c39b65d6c15e78ede9736a9f2df5': { name: 'Pendle LP Discount Oracle Factory' },
  // Pendle — Ethereum mainnet only
  '0x47d74516b33ed5d70dde7119a40839f6fcc24e57': { name: 'Pendle Gauge Controller' },
  '0x999999999991e178d52cd95afd4b00d066664144': { name: 'sPENDLE' },
  '0x4f30a9d41b80ecc5b94306ab4364951ae3170210': { name: 'Pendle vePENDLE' },
  '0x8270400d528c34e1596ef367eedec99080a1b592': { name: 'Pendle Treasury' },
  '0x263833d47ea3fa4a30f269323aba6a107f9eb14c': { name: 'Pendle RouterStatic' },
  '0x6d247b1c044fa1e22e6b04fa9f71baf99eb29a9f': { name: 'Pendle Market Factory V6' },
  '0x3e6eba46abc5ab18ed95f6667d8b2fd4020e4637': { name: 'Pendle Yield Contract Factory V6' },
  '0x33305665f69b4642d1275f4ce81c23651674d21c': { name: 'Pendle Rewards Distributor' },
  '0x07b1014c88f14c9e910092526db57a20052e989f': { name: 'Pendle Sender Endpoint' },

  // Equilibria Finance
  '0x4f1cdf43f5e407abd569878976960d4d0a3d3452': { name: 'Equilibria Finance' },
  '0x4d32c8ff2facc771ec7efc70d6a8468bc30c26bf': { name: 'Equilibria Pendle Booster' },
  '0xfe80d611c6403f70e5b1b9b722d2b3510b740b2b': { name: 'EQB' },

  // Contango
  '0x33636d49fbefbe798e15e7f356e8dbef543cc708': { name: 'Contango' },

  // Liquid Staking
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': { name: 'wstETH' },
  '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee': { name: 'weETH' },

  // Balancer / Fluid
  '0xba1333333333a1ba1108e8412f11850a5c319ba9': {
    name: 'Balancer V3 Vault',
    isProxy: true,
    implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
  },
  '0x90551c1795392094fe6d29b758eccd233cfaa260': { name: 'Fluid fWETH' },

  // f(x) Protocol — additional contracts
  '0x250893ca4ba5d05626c785e8da758026928fcd24': { name: 'f(x) Protocol: Pool Manager' },
  '0x50562fe7e870420f5aae480b7f94eb4ace2fcd70': { name: 'f(x) Protocol: PegKeeper' },
  '0x361f88157073b8522def857761484ca7b1d5c8be': { name: 'f(x) Protocol: Revenue Pool' },
  '0x12af4529129303d7fbd2563e242c4a2890525912': { name: 'f(x) Protocol: MultiPathConverter' },
  '0x6ecfa38fee8a5277b91efda204c235814f0122e8': { name: 'f(x) Protocol: wstETH Pool' },
  // Convex-style / f(x) reward pools (generic labels — vault-specific names not verified)
  '0x258a21fa56962d430e9a11e5c48fc00ce09d2028': {
    name: 'f(x) / Convex ecosystem: reward pool',
  },
  '0x572cccfad655dba513271df9f41248eafd4bca33': {
    name: 'f(x) / Convex ecosystem: reward pool',
  },
  '0x83bddc646956c31a081b8b67cb035046fc5f24bb': {
    name: 'f(x) / Convex ecosystem: reward pool',
  },

  // Fluid (Instadapp) — core infrastructure (Ethereum mainnet)
  '0x52aa899454998be5b000ad077a46bbe360f4e497': { name: 'Fluid Liquidity' },
  '0x324c5dc1fc42c7a4d43d92df1eba58a54d13bf2d': { name: 'Fluid Vault Factory' },
  '0x54b91a0d94cb471f37f949c60f7fa7935b551d03': { name: 'Fluid Lending Factory' },
  '0x91716c4eda1fb55e84bf8b4c7085f84285c19085': { name: 'Fluid Dex Factory' },
  '0x264786ef916af64a1db19f513f24a3681734ce92': {
    name: 'Fluid Reserve Contract Proxy',
    isProxy: true,
    implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
  },
  '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33': { name: 'Fluid fUSDC' },
  '0x5c20b550819128074fd538edf79791733ccedd18': { name: 'Fluid fUSDT' },
  '0x2411802d8bea09be0af8fd8d08314a63e706b29c': { name: 'Fluid fwstETH' },
  '0x0b1a513ee24972daef112bc777a5610d4325c9e7': { name: 'Fluid Dex wstETH-ETH' },
  '0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b': { name: 'Fluid Dex USDC-USDT' },
  '0x3c0441b42195f4ad6aa9a0978e06096ea616cda7': { name: 'Fluid Dex WBTC-cbBTC' },
  '0xde632c3a214d5f14c1d8ddf0b92f8bcd188fee45': { name: 'Fluid Dex GHO-USDC' },
  '0x836951eb21f3df98273517b7249dceff270d34bf': { name: 'Fluid Dex USDC-ETH' },
  '0x86f874212335af27c41cdb855c2255543d1499ce': { name: 'Fluid Dex weETH-ETH' },
  '0x4ec7b668baf70d4a4b0fc7941a7708a07b6d45be': { name: 'Fluid Deployer' },

  // Convex Finance
  '0xf403c135812408bfbe8713b5a23a04b3d48aae31': { name: 'Convex Booster' },
  '0x989aeb4d175e16225e39e87d0d97a3360524ad80': {
    name: 'Convex Voter Proxy',
    isProxy: true,
    implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
  },
  '0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b': { name: 'CVX' },
  '0x62b9c7356a2dc64a1969e19c23e4f579f9810aa7': { name: 'cvxCRV' },
  '0x8014595f2ab54cd7c604b00e9fb932176fdc86ae': { name: 'Convex CRV Depositor' },
  '0xcf50b810e57ac33b91dcf525c6ddd9881b139332': { name: 'Convex CVX Rewards' },
  '0x3fe65692bfcd0e6cf84cb1e7d24108e434a7587e': { name: 'Convex cvxCRV Rewards' },
  '0x72a19342e8f1838460ebfccef09f6585e32db86e': { name: 'Convex Locker (vlCVX)' },
  '0x5f465e9fcffc217c5849906216581a657cd60605': { name: 'Convex MasterChef' },
  '0xaa0C3f5F7DFD688C6E646F66CD2a6B66ACdbE434': { name: 'Convex cvxCRV Wrapper' },
  '0x3f29cb4111cbda8081642da1f75b3c12decf2516': { name: 'Convex Claim Zap v3' },
  '0xa3c5a1e09150b75ff251c1a7815a07182c3de2fb': { name: 'Convex Multisig' },
  '0xa2cf21b157b2f203e37b616b619f438b5aa86ee5': { name: 'Convex FXS Booster' },
  '0x59cfcd384746ec3035299d90782be065e466800b': {
    name: 'Convex FXS Voter Proxy',
    isProxy: true,
    implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
  },
  '0xfeef77d3f69374f66429c91d732a244f074bdf74': { name: 'cvxFXS' },
  '0xaffe966b27ba3e4ebb8a0ec124c7b7019cc762f8': { name: 'Convex FXN Booster' },
  '0x183395dbd0b5e93323a7286d1973150697fffcb3': { name: 'cvxFXN' },
  '0x79a50f83e7aff970ceab5152a15461a4f1c3799e': { name: 'Convex Prisma Booster' },
  '0x34635280737b5bfe6c7dc2fc3065d60d66e78185': { name: 'cvxPrisma' },

  // Superform v2 — Ethereum mainnet (deterministic across chains)
  '0x1101eec94dd79bee1b5a77b96c15ac24a4691e2e': { name: 'Superform SuperBundler' },
  '0x9cc8edcc41154aafc74d261ad3d87140d21f6281': { name: 'Superform SuperExecutor' },
  '0xb46b4773c5f53ff941533f5dfeffd0a684392c4c': { name: 'Superform SuperValidator' },
  '0x04916bb42564cded96e10f55c059d65e4fcb1be6': { name: 'Superform SuperLedger' },
  '0xa3aa31f8d4da6005aafb0d61e5012a64d15f5b3a': { name: 'Superform Nexus' },
  '0x4153db38136e74a88a77b51a955a88823820c050': { name: 'Superform NexusAccountFactory' },
  '0xb5396ef2bf8ca360ceb4166b77afb2bed20e74d4': { name: 'Superform SuperGovernor' },
  '0x10ac0b33e1c4501cf3ec1cb1ae51ebfdbd2d4698': { name: 'Superform SuperVaultAggregator' },
  '0x6fcc6a6a825fc14e6e56fd14978fc6b97acb5d15': { name: 'Superform SuperBank' },
  '0x8943128dbab4279d561654deed2930bb975aa070': { name: 'Superform SuperOracle' },

  // Morpho — Ethereum mainnet (from Hyperbeat docs)
  '0x1897a8997241c1cd4bd0698647e4eb7213535c24': { name: 'Morpho MetaMorpho Factory v1.1' },
  '0xfd32fa2ca22c76dd6e550706ad913fc6ce91c75d': { name: 'Morpho Public Allocator' },
  '0x6ff33615e792e35ed1026ea7caccf42d9bf83476': { name: 'Morpho PreLiquidation Factory' },
  },

  // Polygon PoS — curated high-sensitivity (same canonical Permit2 / Safe; Aave V3 Pool per aave-address-book)
  137: {
    '0x794a61358d6845594f94dc1db02a252b5b4814ad': {
      name: 'Aave V3 Pool',
      isProxy: true,
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      riskLevel: 'critical',
    },
    '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', riskLevel: 'critical' },
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': { name: 'Gnosis Safe', riskLevel: 'high' },
  },

  // Arbitrum One
  42161: {
    '0x794a61358d6845594f94dc1db02a252b5b4814ad': {
      name: 'Aave V3 Pool',
      isProxy: true,
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      riskLevel: 'critical',
    },
    '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', riskLevel: 'critical' },
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': { name: 'Gnosis Safe', riskLevel: 'high' },
  },

  // Optimism
  10: {
    '0x794a61358d6845594f94dc1db02a252b5b4814ad': {
      name: 'Aave V3 Pool',
      isProxy: true,
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      riskLevel: 'critical',
    },
    '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', riskLevel: 'critical' },
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': { name: 'Gnosis Safe', riskLevel: 'high' },
  },

  // Base (Aave V3 Pool address from bgd-labs aave-address-book `AaveV3Base`)
  8453: {
    '0xa238dd80c259a72e81d7e4664a9801593f98d1c5': {
      name: 'Aave V3 Pool',
      isProxy: true,
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      riskLevel: 'critical',
    },
    '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', riskLevel: 'critical' },
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': { name: 'Gnosis Safe', riskLevel: 'high' },
  },
};

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

/** In-memory `decimals()` / `symbol()` results; bounded by TTL + max size for long-lived tabs / wallets. */
type OnChainDecimalsCacheRow = { info: TokenInfo; ts: number };
const ON_CHAIN_DECIMALS_CACHE = new Map<string, OnChainDecimalsCacheRow>();
/** Drop entries older than this on read and when inserting under pressure. */
const ON_CHAIN_DECIMALS_TTL_MS = 5 * 60 * 1000;
/** Hard cap (FIFO eviction of oldest keys when TTL prune is not enough). */
const ON_CHAIN_DECIMALS_MAX_ENTRIES = 512;
const ON_CHAIN_DECIMALS_RPC_MS = 6000;
const MAX_ON_CHAIN_SYMBOL_CHARS = 32;

/** Reuse providers per `(chainId, rpcUrl)` — avoids constructing a new `JsonRpcProvider` per token lookup. */
const JSON_RPC_PROVIDER_CACHE = new Map<string, JsonRpcProvider>();

/** `decimals()` + `symbol()` string (most ERC-20s). */
const ERC20_DECIMALS_SYMBOL_ABI = [
  'function decimals() view returns (uint256)',
  'function symbol() view returns (string)',
];
/** Legacy MKR-style `symbol() returns (bytes32)`. */
const ERC20_SYMBOL_BYTES32_ABI = ['function symbol() view returns (bytes32)'];

function onChainTokenCacheKey(chainId: number, checksummed: string): string {
  return `${chainId}:${checksummed.toLowerCase()}`;
}

function jsonRpcProviderCacheKey(chainId: number, rpcUrl: string): string {
  return `${chainId}\n${rpcUrl}`;
}

function getCachedJsonRpcProvider(chainId: number, rpcUrl: string): JsonRpcProvider {
  const key = jsonRpcProviderCacheKey(chainId, rpcUrl);
  let p = JSON_RPC_PROVIDER_CACHE.get(key);
  if (!p) {
    p = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
    JSON_RPC_PROVIDER_CACHE.set(key, p);
  }
  return p;
}

function getCachedOnChainDecimals(ck: string, now: number): TokenInfo | undefined {
  const row = ON_CHAIN_DECIMALS_CACHE.get(ck);
  if (!row) return undefined;
  if (now - row.ts > ON_CHAIN_DECIMALS_TTL_MS) {
    ON_CHAIN_DECIMALS_CACHE.delete(ck);
    return undefined;
  }
  return row.info;
}

function setCachedOnChainDecimals(ck: string, info: TokenInfo, now: number): void {
  if (ON_CHAIN_DECIMALS_CACHE.size >= ON_CHAIN_DECIMALS_MAX_ENTRIES) {
    for (const [k, v] of ON_CHAIN_DECIMALS_CACHE) {
      if (now - v.ts > ON_CHAIN_DECIMALS_TTL_MS) {
        ON_CHAIN_DECIMALS_CACHE.delete(k);
      }
    }
    while (ON_CHAIN_DECIMALS_CACHE.size >= ON_CHAIN_DECIMALS_MAX_ENTRIES) {
      const first = ON_CHAIN_DECIMALS_CACHE.keys().next().value;
      if (first === undefined) break;
      ON_CHAIN_DECIMALS_CACHE.delete(first);
    }
  }
  ON_CHAIN_DECIMALS_CACHE.set(ck, { info, ts: now });
}

/** Clears on-chain token metadata cache (Vitest / dev only). */
export function clearOnChainDecimalsCacheForTests(): void {
  ON_CHAIN_DECIMALS_CACHE.clear();
}

/**
 * Race `promise` against timeout and optional `AbortSignal`; clears the timer when the primary settles
 * so pending timeouts do not keep the process alive or accumulate in the browser.
 */
function raceWithTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      action();
    };

    const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), ms);

    const onAbort = () =>
      finish(() => reject(new DOMException('The operation was aborted.', 'AbortError')));
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    promise.then(
      v => finish(() => resolve(v)),
      e => finish(() => reject(e)),
    );
  });
}

/** ASCII from left-padded bytes32 symbol; stops at first `\\0`. */
function symbolFromBytes32Hex(hex: string): string {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) return '';
  let out = '';
  for (let i = 0; i < clean.length; i += 2) {
    const byte = parseInt(clean.slice(i, i + 2), 16);
    if (byte === 0) break;
    if (byte < 32 || byte > 126) break;
    out += String.fromCharCode(byte);
  }
  return sanitizeDecodedString(out, MAX_ON_CHAIN_SYMBOL_CHARS);
}

/** After `symbol() returns (string)` fails or is empty, try MKR-style `bytes32` symbol. */
async function readBytes32Symbol(
  checksummed: string,
  provider: JsonRpcProvider,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const c32 = new Contract(checksummed, ERC20_SYMBOL_BYTES32_ABI, provider);
    const b32: unknown = await raceWithTimeout(c32.symbol(), ON_CHAIN_DECIMALS_RPC_MS, signal);
    if (typeof b32 === 'string' && /^0x[0-9a-fA-F]{64}$/.test(b32)) {
      const decoded = symbolFromBytes32Hex(b32);
      if (decoded.length > 0) return decoded;
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    /* ignore */
  }
  return undefined;
}

/**
 * Read `decimals()` and best-effort `symbol()` from chain when the token is not in `KNOWN_TOKENS`.
 * Caches per `(chainId, address)`. `symbol` may remain **`UNKNOWN`** if calls revert or are non-standard.
 * When `signal` aborts, races against in-flight calls reject with **`AbortError`** (RPC may not hard-cancel).
 */
export async function fetchOnChainTokenDecimals(
  address: string,
  chainId: number,
  signal?: AbortSignal,
): Promise<TokenInfo | undefined> {
  let checksummed: string;
  try {
    checksummed = getAddress(address.toLowerCase());
  } catch {
    return undefined;
  }

  const ck = onChainTokenCacheKey(chainId, checksummed);
  const now0 = Date.now();
  const cached = getCachedOnChainDecimals(ck, now0);
  if (cached) return cached;

  const chain = CHAINS[chainId];
  if (!chain?.rpcs?.length) return undefined;

  for (const rpcUrl of chain.rpcs) {
    try {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const provider = getCachedJsonRpcProvider(chainId, rpcUrl);
      const c = new Contract(checksummed, ERC20_DECIMALS_SYMBOL_ABI, provider);

      const settled = await Promise.allSettled([
        raceWithTimeout(c.decimals(), ON_CHAIN_DECIMALS_RPC_MS, signal),
        raceWithTimeout(c.symbol(), ON_CHAIN_DECIMALS_RPC_MS, signal),
      ]);

      for (const s of settled) {
        if (s.status === 'rejected') {
          const r = s.reason;
          if (r instanceof DOMException && r.name === 'AbortError') throw r;
        }
      }

      if (settled[0].status !== 'fulfilled') continue;

      const raw = settled[0].value as unknown;
      const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 255) continue;

      let symbol = 'UNKNOWN';
      if (settled[1].status === 'fulfilled') {
        const sym = settled[1].value as unknown;
        if (typeof sym === 'string') {
          const cleaned = sanitizeDecodedString(sym.trim(), MAX_ON_CHAIN_SYMBOL_CHARS);
          if (cleaned.length > 0) symbol = cleaned;
        }
      }
      if (symbol === 'UNKNOWN') {
        const b32 = await readBytes32Symbol(checksummed, provider, signal);
        if (b32) symbol = b32;
      }

      const info: TokenInfo = { symbol, decimals: n };
      setCachedOnChainDecimals(ck, info, Date.now());
      return info;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      continue;
    }
  }

  return undefined;
}

const ERC4626_ASSET_ABI = ['function asset() view returns (address)'];

/**
 * Best-effort ERC-4626 `asset()` on `vaultAddress`. Used when calldata is `withdraw(uint256,address,address)`:
 * the first argument is **underlying** amount, not vault shares — the underlying token is not in the calldata.
 * Optional `signal` matches {@link fetchOnChainTokenDecimals} (cooperative cancel; in-flight RPC may still finish).
 */
export async function fetchErc4626UnderlyingAsset(
  vaultAddress: string,
  chainId: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let checksummed: string;
  try {
    checksummed = getAddress(vaultAddress.toLowerCase());
  } catch {
    return undefined;
  }

  const chain = CHAINS[chainId];
  if (!chain?.rpcs?.length) return undefined;

  for (const rpcUrl of chain.rpcs) {
    try {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const provider = getCachedJsonRpcProvider(chainId, rpcUrl);
      const c = new Contract(checksummed, ERC4626_ASSET_ABI, provider);
      const raw: unknown = await raceWithTimeout(c.asset(), ON_CHAIN_DECIMALS_RPC_MS, signal);
      if (typeof raw === 'string') {
        return getAddress(raw);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      /* try next RPC */
    }
  }
  return undefined;
}

/** Per-chain token decimals/symbols. Only chains listed here are consulted. */
const KNOWN_TOKENS_RAW: Record<number, Record<string, TokenInfo>> = {
  1: {
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  /** Tether USDT0 (LayerZero OFT on Ethereum). */
  '0x6c96de32cea08842dcc4058c14d3aaad7fa41dee': { symbol: 'USDT0', decimals: 6 },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8 },
  '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': { symbol: 'MATIC', decimals: 18 },
  '0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', decimals: 18 },
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', decimals: 18 },
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { symbol: 'AAVE', decimals: 18 },
  '0x6982508145454ce325ddbe47a25d4ec3d2311933': { symbol: 'PEPE', decimals: 18 },
  '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': { symbol: 'SHIB', decimals: 18 },

  // f(x) Protocol
  '0x085780639cc2cacd35e474e71f4d000e2405d8f6': { symbol: 'fxUSD', decimals: 18 },
  '0x65c9a641afceb9c0e6034e558a319488fa0fa3be': { symbol: 'fxBASE', decimals: 18 },
  '0x365accfca291e7d3914637abf1f7635db165bb09': { symbol: 'FXN', decimals: 18 },

  // Pendle / Equilibria
  '0x808507121b80c02388fad14726482e061b8da827': { symbol: 'PENDLE', decimals: 18 },
  '0xfe80d611c6403f70e5b1b9b722d2b3510b740b2b': { symbol: 'EQB', decimals: 18 },

  // Liquid Staking / Restaking
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': { symbol: 'wstETH', decimals: 18 },
  '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee': { symbol: 'weETH', decimals: 18 },
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': { symbol: 'stETH', decimals: 18 },
  '0xae78736cd615f374d3085123a210448e74fc6393': { symbol: 'rETH', decimals: 18 },
  '0xbe9895146f7af43049ca1c1ae358b0541ea49704': { symbol: 'cbETH', decimals: 18 },
  '0xf1c9acdc66974dfb6decb12aa385b9cd01190e38': { symbol: 'osETH', decimals: 18 },
  '0xa35b1b31ce002fbf2058d22f30f95d405200a15b': { symbol: 'ETHx', decimals: 18 },
  '0xa1290d69c65a6fe4df752f95823fae25cb99e5a7': { symbol: 'rsETH', decimals: 18 },
  '0xbf5495efe5db9ce00f80364c8b423567e58d2110': { symbol: 'ezETH', decimals: 18 },
  '0xd11c452fc99cf405034ee446803b6f6c1f6d5ed8': { symbol: 'tETH', decimals: 18 },

  // Aave / DeFi Stablecoins
  /** Curve crvUSD (Ethereum mainnet). */
  '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e': { symbol: 'crvUSD', decimals: 18 },
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': { symbol: 'GHO', decimals: 18 },
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': { symbol: 'USDe', decimals: 18 },
  '0x9d39a5de30e57443bff2a8307a4256c8797a3497': { symbol: 'sUSDe', decimals: 18 },
  '0x83f20f44975d03b1b09e64809b757c47f942beea': { symbol: 'sDAI', decimals: 18 },
  '0x853d955acef822db058eb8505911ed77f175b99e': { symbol: 'FRAX', decimals: 18 },
  '0x5f98805a4e8be255a32880fdec7f6728c6568ba0': { symbol: 'LUSD', decimals: 18 },
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': { symbol: 'PYUSD', decimals: 6 },
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f': { symbol: 'USDS', decimals: 18 },
  '0x8292bb45bf1ee4d140127049757c2e0ff06317ed': { symbol: 'RLUSD', decimals: 18 },
  '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c': { symbol: 'EURC', decimals: 6 },

  // DeFi Governance / Utility Tokens
  '0xd533a949740bb3306d119cc777fa900ba034cd52': { symbol: 'CRV', decimals: 18 },
  '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': { symbol: 'MKR', decimals: 18 },
  '0x5a98fcbea516cf06857215779fd812ca3bef1b32': { symbol: 'LDO', decimals: 18 },
  '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f': { symbol: 'SNX', decimals: 18 },
  '0xba100000625a3754423978a60c9317c58a424e3d': { symbol: 'BAL', decimals: 18 },
  '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72': { symbol: 'ENS', decimals: 18 },
  '0xd33526068d116ce69f19a9ee46f0bd304f21a51f': { symbol: 'RPL', decimals: 18 },
  '0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0': { symbol: 'FXS', decimals: 18 },

  // BTC variants
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8 },
  '0x8236a87084f8b84306f72007f36f2618a5634494': { symbol: 'LBTC', decimals: 8 },
  '0x18084fba666a33d37592fa2633fd49a74dd93a88': { symbol: 'tBTC', decimals: 18 },
  '0x657e8c867d8b37dcc18fa4caead9c45eb088c642': { symbol: 'eBTC', decimals: 8 },
  '0xc96de26018a54d51c097160568752c4e3bd6c364': { symbol: 'FBTC', decimals: 8 },

  // Other
  '0x68749665ff8d2d112fa859aa293f07a622782f38': { symbol: 'XAUt', decimals: 6 },

  // Convex
  '0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b': { symbol: 'CVX', decimals: 18 },
  '0x62b9c7356a2dc64a1969e19c23e4f579f9810aa7': { symbol: 'cvxCRV', decimals: 18 },
  '0xfeef77d3f69374f66429c91d732a244f074bdf74': { symbol: 'cvxFXS', decimals: 18 },
  '0x183395dbd0b5e93323a7286d1973150697fffcb3': { symbol: 'cvxFXN', decimals: 18 },
  '0x34635280737b5bfe6c7dc2fc3065d60d66e78185': { symbol: 'cvxPrisma', decimals: 18 },

  // Prisma
  '0xda47862a83dac0c112ba89c6abc2159b95afd71c': { symbol: 'PRISMA', decimals: 18 },

  // Fluid INST token
  '0x6f40d4a6237c257fff2db00fa0510deeecd303eb': { symbol: 'INST', decimals: 18 },

  // Superform
  '0x1d926bbe67425c9f507b9a0e8030eedc7880bf33': { symbol: 'UP', decimals: 18 },
  },

  // Arbitrum One — underlying assets from aave-address-book `AaveV3ArbitrumAssets` (+ common USDC variants)
  42161: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18 },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.e', decimals: 6 },
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'WBTC', decimals: 8 },
    '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': { symbol: 'LINK', decimals: 18 },
    '0xba5ddd1f9d7f570dc94a51479a000e3bce967196': { symbol: 'AAVE', decimals: 18 },
    '0x5979d7b546e38e414f7e9822514be443a4800529': { symbol: 'wstETH', decimals: 18 },
    '0xec70dcb4a1efa46b8f2d97c310c9c4790ba5ffa8': { symbol: 'rETH', decimals: 18 },
    '0x35751007a407ca6feffe80b3cb397736d2cf4dbe': { symbol: 'weETH', decimals: 18 },
    '0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33': { symbol: 'GHO', decimals: 18 },
    '0x2416092f143378750bb29b79ed961ab195cceea5': { symbol: 'ezETH', decimals: 18 },
    '0x4186bfc76e2e237523cbc30fd220fe055156b41f': { symbol: 'rsETH', decimals: 18 },
    '0x17fc002b466eec40dae837fc4be5c67993ddbd6f': { symbol: 'FRAX', decimals: 18 },
    '0x93b346b6bc2548da6a1e7d98e9a421b42541425b': { symbol: 'LUSD', decimals: 18 },
    /** Curve crvUSD (Arbitrum One); Curve deployment docs. */
    '0x498bf2b1e120fed3ad3d42ea2165e9b73f99c1e5': { symbol: 'crvUSD', decimals: 18 },
    '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40': { symbol: 'tBTC', decimals: 18 },
  },

  // Base — `AaveV3BaseAssets` + widely used USDT/DAI (not all listed on Aave Base)
  8453: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT', decimals: 6 },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { symbol: 'cbETH', decimals: 18 },
    '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { symbol: 'wstETH', decimals: 18 },
    '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a': { symbol: 'weETH', decimals: 18 },
    '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8 },
    '0x2416092f143378750bb29b79ed961ab195cceea5': { symbol: 'ezETH', decimals: 18 },
    '0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee': { symbol: 'GHO', decimals: 18 },
    '0x63706e401c06ac8513145b7687a14804d17f814b': { symbol: 'AAVE', decimals: 18 },
    '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': { symbol: 'EURC', decimals: 6 },
    '0x236aa50979d5f3de3bd1eeb40e81137f22ab794b': { symbol: 'tBTC', decimals: 18 },
  },

  // Optimism — `AaveV3OptimismAssets`
  10: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607': { symbol: 'USDC.e', decimals: 6 },
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6 },
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6 },
    '0x68f180fcce6836688e9084f035309e29bf0a2095': { symbol: 'WBTC', decimals: 8 },
    '0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6': { symbol: 'LINK', decimals: 18 },
    '0x76fb31fb4af56892a25e32cfc43de717950c9278': { symbol: 'AAVE', decimals: 18 },
    '0x1f32b1c2345538c0c6f582fcb022739c4a194ebb': { symbol: 'wstETH', decimals: 18 },
    '0x9bcef72be871e61ed4fbbc7630889bee758eb81d': { symbol: 'rETH', decimals: 18 },
  },

  // Polygon PoS — `AaveV3PolygonAssets`
  137: {
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18 },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI', decimals: 18 },
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC.e', decimals: 6 },
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6 },
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6 },
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': { symbol: 'WBTC', decimals: 8 },
    '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39': { symbol: 'LINK', decimals: 18 },
    '0xd6df932a45c0f255f85145f286ea0b292b21c90b': { symbol: 'AAVE', decimals: 18 },
  },
};

/** chainId → (EIP-55 address → info), built from `KNOWN_*_RAW` at load. */
const KNOWN_CONTRACTS = new Map<number, Map<string, ContractRegistryEntry>>();
for (const [cid, entries] of Object.entries(KNOWN_CONTRACTS_RAW)) {
  const inner = new Map<string, ContractRegistryEntry>();
  const chainId = Number(cid);
  for (const [key, info] of Object.entries(entries)) {
    inner.set(getAddress(key.toLowerCase()), info);
  }
  for (const [, info] of Object.entries(entries)) {
    for (const alias of info.addresses ?? []) {
      const a = getAddress(alias.toLowerCase());
      const existing = inner.get(a);
      if (existing !== undefined && existing !== info) {
        throw new Error(
          `KNOWN_CONTRACTS_RAW chain ${chainId}: address alias ${a} maps to multiple distinct registry rows`,
        );
      }
      inner.set(a, info);
    }
  }
  KNOWN_CONTRACTS.set(chainId, inner);
}

const KNOWN_TOKENS = new Map<number, Map<string, TokenInfo>>();
for (const [cid, entries] of Object.entries(KNOWN_TOKENS_RAW)) {
  const inner = new Map<string, TokenInfo>();
  for (const [key, info] of Object.entries(entries)) {
    inner.set(getAddress(key.toLowerCase()), info);
  }
  KNOWN_TOKENS.set(Number(cid), inner);
}

/** Static registry only (sync). For on-chain `decimals()` fallback see `fetchOnChainTokenDecimals`. */
export function getTokenInfo(address: string, chainId: number): TokenInfo | undefined {
  try {
    const m = KNOWN_TOKENS.get(chainId);
    if (!m) return undefined;
    return m.get(getAddress(address.toLowerCase()));
  } catch {
    return undefined;
  }
}

export function getContractRegistryEntry(address: string, chainId: number): ContractRegistryEntry | undefined {
  try {
    const m = KNOWN_CONTRACTS.get(chainId);
    if (!m) return undefined;
    return m.get(getAddress(address.toLowerCase()));
  } catch {
    return undefined;
  }
}

export function getContractName(address: string, chainId: number): string | undefined {
  return getContractRegistryEntry(address, chainId)?.name ?? getTokenInfo(address, chainId)?.symbol;
}

const BUNDLED_SIGNATURES: FunctionSignature[] = [
  // Multicall2
  { selector: '0x252dba42', name: 'aggregate', textSignature: 'aggregate((address,bytes)[])', params: [{ name: 'calls', type: '(address,bytes)[]' }], source: 'bundled' },
  { selector: '0xbce38bd7', name: 'tryAggregate', textSignature: 'tryAggregate(bool,(address,bytes)[])', params: [{ name: 'requireSuccess', type: 'bool' }, { name: 'calls', type: '(address,bytes)[]' }], source: 'bundled' },
  { selector: '0x399542e9', name: 'tryBlockAndAggregate', textSignature: 'tryBlockAndAggregate(bool,(address,bytes)[])', params: [{ name: 'requireSuccess', type: 'bool' }, { name: 'calls', type: '(address,bytes)[]' }], source: 'bundled' },

  // Multicall3
  { selector: '0x82ad56cb', name: 'aggregate3', textSignature: 'aggregate3((address,bool,bytes)[])', params: [{ name: 'calls', type: '(address,bool,bytes)[]' }], source: 'bundled' },
  { selector: '0x174dea71', name: 'aggregate3Value', textSignature: 'aggregate3Value((address,bool,uint256,bytes)[])', params: [{ name: 'calls', type: '(address,bool,uint256,bytes)[]' }], source: 'bundled' },

  // Uniswap-style multicall
  { selector: '0xac9650d8', name: 'multicall', textSignature: 'multicall(bytes[])', params: [{ name: 'data', type: 'bytes[]' }], source: 'bundled', popularity: 100 },
  { selector: '0x5ae401dc', name: 'multicall', textSignature: 'multicall(uint256,bytes[])', params: [{ name: 'deadline', type: 'uint256' }, { name: 'data', type: 'bytes[]' }], source: 'bundled', popularity: 88 },
  { selector: '0x1f0464d1', name: 'multicall', textSignature: 'multicall(bytes32,bytes[])', params: [{ name: 'previousBlockhash', type: 'bytes32' }, { name: 'data', type: 'bytes[]' }], source: 'bundled', popularity: 82 },

  // OpenZeppelin ERC2771Forwarder (Defender relayer / metatx batching)
  { selector: '0xdf905caf', name: 'execute', textSignature: 'execute((address,address,uint256,uint256,uint48,bytes,bytes))', params: [{ name: 'request', type: '(address,address,uint256,uint256,uint48,bytes,bytes)' }], source: 'bundled' },
  { selector: '0xccf96b4a', name: 'executeBatch', textSignature: 'executeBatch((address,address,uint256,uint256,uint48,bytes,bytes)[],address)', params: [{ name: 'requests', type: '(address,address,uint256,uint256,uint48,bytes,bytes)[]' }, { name: 'refundReceiver', type: 'address' }], source: 'bundled' },

  // ERC20
  { selector: '0xa9059cbb', name: 'transfer', textSignature: 'transfer(address,uint256)', params: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], source: 'bundled' },
  { selector: '0x23b872dd', name: 'transferFrom', textSignature: 'transferFrom(address,address,uint256)', params: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], source: 'bundled' },
  { selector: '0x095ea7b3', name: 'approve', textSignature: 'approve(address,uint256)', params: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], source: 'bundled' },
  { selector: '0x70a08231', name: 'balanceOf', textSignature: 'balanceOf(address)', params: [{ name: 'account', type: 'address' }], source: 'bundled' },
  { selector: '0xdd62ed3e', name: 'allowance', textSignature: 'allowance(address,address)', params: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], source: 'bundled' },
  { selector: '0x18160ddd', name: 'totalSupply', textSignature: 'totalSupply()', params: [], source: 'bundled' },
  { selector: '0xd505accf', name: 'permit', textSignature: 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', params: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }], source: 'bundled' },

  // ERC721
  { selector: '0x42842e0e', name: 'safeTransferFrom', textSignature: 'safeTransferFrom(address,address,uint256)', params: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], source: 'bundled' },
  { selector: '0xb88d4fde', name: 'safeTransferFrom', textSignature: 'safeTransferFrom(address,address,uint256,bytes)', params: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'data', type: 'bytes' }], source: 'bundled' },
  { selector: '0xa22cb465', name: 'setApprovalForAll', textSignature: 'setApprovalForAll(address,bool)', params: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], source: 'bundled' },

  // ERC1155
  { selector: '0xf242432a', name: 'safeTransferFrom', textSignature: 'safeTransferFrom(address,address,uint256,uint256,bytes)', params: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'id', type: 'uint256' }, { name: 'amount', type: 'uint256' }, { name: 'data', type: 'bytes' }], source: 'bundled' },
  { selector: '0x2eb2c2d6', name: 'safeBatchTransferFrom', textSignature: 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', params: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'ids', type: 'uint256[]' }, { name: 'amounts', type: 'uint256[]' }, { name: 'data', type: 'bytes' }], source: 'bundled' },

  // WETH
  { selector: '0xd0e30db0', name: 'deposit', textSignature: 'deposit()', params: [], source: 'bundled' },
  { selector: '0x2e1a7d4d', name: 'withdraw', textSignature: 'withdraw(uint256)', params: [{ name: 'wad', type: 'uint256' }], source: 'bundled' },

  // Uniswap V2 Router
  { selector: '0x7ff36ab5', name: 'swapExactETHForTokens', textSignature: 'swapExactETHForTokens(uint256,address[],address,uint256)', params: [{ name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], source: 'bundled' },
  { selector: '0x38ed1739', name: 'swapExactTokensForTokens', textSignature: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)', params: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], source: 'bundled' },
  { selector: '0x18cbafe5', name: 'swapExactTokensForETH', textSignature: 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)', params: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], source: 'bundled' },

  // Uniswap V3 SwapRouter
  { selector: '0x414bf389', name: 'exactInputSingle', textSignature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', params: [{ name: 'params', type: '(address,address,uint24,address,uint256,uint256,uint256,uint160)' }], source: 'bundled' },
  { selector: '0xc04b8d59', name: 'exactInput', textSignature: 'exactInput((bytes,address,uint256,uint256,uint256))', params: [{ name: 'params', type: '(bytes,address,uint256,uint256,uint256)' }], source: 'bundled' },
  { selector: '0xdb3e2198', name: 'exactOutputSingle', textSignature: 'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', params: [{ name: 'params', type: '(address,address,uint24,address,uint256,uint256,uint256,uint160)' }], source: 'bundled' },

  // Uniswap Universal Router
  { selector: '0x3593564c', name: 'execute', textSignature: 'execute(bytes,bytes[],uint256)', params: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }], source: 'bundled', popularity: 100 },
  { selector: '0x24856bc3', name: 'execute', textSignature: 'execute(bytes,bytes[])', params: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }], source: 'bundled', popularity: 70, deprecated: true },

  // 1inch Aggregation Router V6
  { selector: '0x12aa3caf', name: 'swap', textSignature: 'swap(address,(address,address,address,address,uint256,uint256,uint256),bytes,bytes)', params: [{ name: 'executor', type: 'address' }, { name: 'desc', type: '(address,address,address,address,uint256,uint256,uint256)' }, { name: 'data', type: 'bytes' }, { name: 'callbackData', type: 'bytes' }], source: 'bundled' },
  // 1inch Aggregation Router (alternate `swap` — common inside Enso / aggregator `commands[]`; OpenChain verified)
  {
    selector: '0x90411a32',
    name: 'swap',
    textSignature:
      'swap(address,(address,address,address,address,uint256,uint256,uint256,uint256,address,bytes),(uint256,uint256,uint256,bytes)[])',
    params: [
      { name: 'executor', type: 'address' },
      {
        name: 'desc',
        type: '(address,address,address,address,uint256,uint256,uint256,uint256,address,bytes)',
      },
      { name: 'interactions', type: '(uint256,uint256,uint256,bytes)[]' },
    ],
    source: 'bundled',
    popularity: 2000,
  },

  // Enso Router V2 — `routeMulti` (4byte: same selector as some false tuples; this shape matches mainnet calldata)
  {
    selector: '0xf52e33f5',
    name: 'routeMulti',
    textSignature: 'routeMulti((uint8,bytes)[],bytes)',
    params: [
      { name: 'tokensIn', type: '(uint8,bytes)[]' },
      { name: 'routeData', type: 'bytes' },
    ],
    source: 'bundled',
    popularity: 5000,
  },
  // Enso Router V2 — `routeData` from `routeMulti` is usually this shortcut runner (OpenChain verified)
  {
    selector: '0x95352c9f',
    name: 'executeShortcut',
    textSignature: 'executeShortcut(bytes32,bytes32,bytes32[],bytes[])',
    params: [
      { name: 'shortcutId', type: 'bytes32' },
      { name: 'referrer', type: 'bytes32' },
      { name: 'leaves', type: 'bytes32[]' },
      { name: 'commands', type: 'bytes[]' },
    ],
    source: 'bundled',
    popularity: 5000,
  },

  // Across Protocol SpokePool V2 — `bytes32` args are left-padded addresses on the origin chain
  {
    selector: '0xad5425c6',
    name: 'deposit',
    textSignature:
      'deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)',
    params: [
      { name: 'depositor', type: 'bytes32' },
      { name: 'recipient', type: 'bytes32' },
      { name: 'inputToken', type: 'bytes32' },
      { name: 'outputToken', type: 'bytes32' },
      { name: 'inputAmount', type: 'uint256' },
      { name: 'outputAmount', type: 'uint256' },
      { name: 'destinationChainId', type: 'uint256' },
      { name: 'exclusiveRelayer', type: 'bytes32' },
      { name: 'quoteTimestamp', type: 'uint32' },
      { name: 'fillDeadline', type: 'uint32' },
      { name: 'exclusivityParameter', type: 'uint32' },
      { name: 'message', type: 'bytes' },
    ],
    source: 'bundled',
    popularity: 200,
  },

  // Gnosis Safe
  { selector: '0x6a761202', name: 'execTransaction', textSignature: 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)', params: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'signatures', type: 'bytes' }], source: 'bundled' },
  { selector: '0x468721a7', name: 'execTransactionFromModule', textSignature: 'execTransactionFromModule(address,uint256,bytes,uint8)', params: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }], source: 'bundled' },
  { selector: '0x8d80ff0a', name: 'multiSend', textSignature: 'multiSend(bytes)', params: [{ name: 'transactions', type: 'bytes' }], source: 'bundled' },

  // Curve Finance Router
  { selector: '0x5c9c18e2', name: 'exchange', textSignature: 'exchange(address[11],uint256[5][5],uint256,uint256,address[5])', params: [{ name: '_route', type: 'address[11]' }, { name: '_swap_params', type: 'uint256[5][5]' }, { name: '_amount', type: 'uint256' }, { name: '_min_dy', type: 'uint256' }, { name: '_pools', type: 'address[5]' }], source: 'bundled' },

  // f(x) Protocol
  { selector: '0x1e9a6950', name: 'redeem', textSignature: 'redeem(address,uint256)', params: [{ name: 'receiver', type: 'address' }, { name: 'amountSharesToRedeem', type: 'uint256' }], source: 'bundled' },
  { selector: '0xaa2f892d', name: 'requestRedeem', textSignature: 'requestRedeem(uint256)', params: [{ name: 'shares', type: 'uint256' }], source: 'bundled' },
  { selector: '0x3d18b912', name: 'getReward', textSignature: 'getReward()', params: [], source: 'bundled' },

  // Pendle RouterV4
  { selector: '0x9fa02c86', name: 'callAndReflect', textSignature: 'callAndReflect(address,bytes,bytes,bytes)', params: [{ name: 'reflector', type: 'address' }, { name: 'selfCall1', type: 'bytes' }, { name: 'selfCall2', type: 'bytes' }, { name: 'reflectCall', type: 'bytes' }], source: 'bundled' },
  // Pendle Router — Curve leg inside `swapTokensToTokens` step `bytes` (OpenChain `0xd90ce491`)
  {
    selector: '0xd90ce491',
    name: 'executeCurve',
    textSignature: 'executeCurve(bytes,uint256)',
    params: [
      { name: 'curveCall', type: 'bytes' },
      { name: 'minOutput', type: 'uint256' },
    ],
    source: 'bundled',
    popularity: 120,
  },
  // PendleSwap / Router — OpenChain `0xa373cf1a`; inner `(uint8,address,bytes,bool)` rows carry nested calldata in `bytes`
  {
    selector: '0xa373cf1a',
    name: 'swapTokensToTokens',
    textSignature:
      'swapTokensToTokens(address,(address,address,uint256,(uint8,address,bytes,bool))[],uint256[])',
    params: [
      { name: 'receiver', type: 'address' },
      { name: 'swapData', type: '(address,address,uint256,(uint8,address,bytes,bool))[]' },
      { name: 'netOutFromSwaps', type: 'uint256[]' },
    ],
    source: 'bundled',
    popularity: 400,
  },
  { selector: '0x60fc8466', name: 'multicall', textSignature: 'multicall((bool,bytes)[])', params: [{ name: 'calls', type: '(bool,bytes)[]' }], source: 'bundled', popularity: 75 },

  // Equilibria Finance
  { selector: '0x441a3e70', name: 'withdraw', textSignature: 'withdraw(uint256,uint256)', params: [{ name: '_pid', type: 'uint256' }, { name: '_amount', type: 'uint256' }], source: 'bundled' },

  // ERC-4626 (MetaMorpho, yield vaults, etc.) — first arg is **underlying assets**; use `asset()` on transaction `to`.
  {
    selector: '0xb460af94',
    name: 'withdraw',
    textSignature: 'withdraw(uint256,address,address)',
    params: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    source: 'bundled',
    popularity: 900,
  },

  // CoW Protocol GPv2Settlement
  {
    selector: '0x13d79a0b',
    name: 'settle',
    textSignature:
      'settle(address[],uint256[],(uint256,uint256,address,uint256,uint256,uint32,bytes32,uint256,uint256,uint256,bytes)[],(address,uint256,bytes)[][3])',
    params: [
      { name: 'tokens', type: 'address[]' },
      { name: 'clearingPrices', type: 'uint256[]' },
      { name: 'trades', type: '(uint256,uint256,address,uint256,uint256,uint32,bytes32,uint256,uint256,uint256,bytes)[]' },
      { name: 'interactions', type: '(address,uint256,bytes)[][3]' },
    ],
    source: 'bundled',
    popularity: 85,
  },

  // Contango
  { selector: '0xe8e9fc2a', name: 'closeOrRemovePositionFlashLoanV2', textSignature: 'closeOrRemovePositionFlashLoanV2((address,address,uint256,uint256[],uint256,bytes),address,uint256,uint256,uint256,bytes)', params: [{ name: 'params', type: '(address,address,uint256,uint256[],uint256,bytes)' }, { name: 'pool', type: 'address' }, { name: 'positionId', type: 'uint256' }, { name: 'amountOut', type: 'uint256' }, { name: 'borrowAmount', type: 'uint256' }, { name: 'data', type: 'bytes' }], source: 'bundled' },

  // LayerZero V2 OFT (e.g. Tether USDT0 bridge `send`)
  {
    selector: '0xc7c7f5b3',
    name: 'send',
    textSignature: 'send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)',
    params: [
      { name: '_sendParam', type: '(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)' },
      { name: '_fee', type: '(uint256,uint256)' },
      { name: '_refundAddress', type: 'address' },
    ],
    source: 'bundled',
    popularity: 200,
  },

  // Aave V3 Pool
  { selector: '0x617ba037', name: 'supply', textSignature: 'supply(address,uint256,address,uint16)', params: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], source: 'bundled' },
  { selector: '0x02c205f0', name: 'supplyWithPermit', textSignature: 'supplyWithPermit(address,uint256,address,uint16,uint256,uint8,bytes32,bytes32)', params: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }, { name: 'deadline', type: 'uint256' }, { name: 'permitV', type: 'uint8' }, { name: 'permitR', type: 'bytes32' }, { name: 'permitS', type: 'bytes32' }], source: 'bundled' },
  { selector: '0x69328dec', name: 'withdraw', textSignature: 'withdraw(address,uint256,address)', params: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }], source: 'bundled' },
  { selector: '0xa415bcad', name: 'borrow', textSignature: 'borrow(address,uint256,uint256,uint16,address)', params: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'referralCode', type: 'uint16' }, { name: 'onBehalfOf', type: 'address' }], source: 'bundled' },
  { selector: '0x573ade81', name: 'repay', textSignature: 'repay(address,uint256,uint256,address)', params: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }], source: 'bundled' },
  { selector: '0xee3e210b', name: 'repayWithPermit', textSignature: 'repayWithPermit(address,uint256,uint256,address,uint256,uint8,bytes32,bytes32)', params: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'permitV', type: 'uint8' }, { name: 'permitR', type: 'bytes32' }, { name: 'permitS', type: 'bytes32' }], source: 'bundled' },
  { selector: '0x2dad97d4', name: 'repayWithATokens', textSignature: 'repayWithATokens(address,uint256,uint256)', params: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }], source: 'bundled' },
  { selector: '0xab9c4b5d', name: 'flashLoan', textSignature: 'flashLoan(address,address[],uint256[],uint256[],address,bytes,uint16)', params: [{ name: 'receiverAddress', type: 'address' }, { name: 'assets', type: 'address[]' }, { name: 'amounts', type: 'uint256[]' }, { name: 'interestRateModes', type: 'uint256[]' }, { name: 'onBehalfOf', type: 'address' }, { name: 'params', type: 'bytes' }, { name: 'referralCode', type: 'uint16' }], source: 'bundled' },
  { selector: '0x42b0b77c', name: 'flashLoanSimple', textSignature: 'flashLoanSimple(address,address,uint256,bytes,uint16)', params: [{ name: 'receiverAddress', type: 'address' }, { name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'params', type: 'bytes' }, { name: 'referralCode', type: 'uint16' }], source: 'bundled' },
  { selector: '0x00a718a9', name: 'liquidationCall', textSignature: 'liquidationCall(address,address,address,uint256,bool)', params: [{ name: 'collateralAsset', type: 'address' }, { name: 'debtAsset', type: 'address' }, { name: 'user', type: 'address' }, { name: 'debtToCover', type: 'uint256' }, { name: 'receiveAToken', type: 'bool' }], source: 'bundled' },
  { selector: '0x5a3b74b9', name: 'setUserUseReserveAsCollateral', textSignature: 'setUserUseReserveAsCollateral(address,bool)', params: [{ name: 'asset', type: 'address' }, { name: 'useAsCollateral', type: 'bool' }], source: 'bundled' },
  // Aave V2 Lending Pool
  { selector: '0xe8eda9df', name: 'deposit', textSignature: 'deposit(address,uint256,address,uint16)', params: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], source: 'bundled' },
  // Aave WETH Gateway
  { selector: '0x474cf53d', name: 'depositETH', textSignature: 'depositETH(address,address,uint16)', params: [{ name: 'pool', type: 'address' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], source: 'bundled' },
  { selector: '0x80500d20', name: 'withdrawETH', textSignature: 'withdrawETH(address,uint256,address)', params: [{ name: 'pool', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }], source: 'bundled' },
  { selector: '0x66514c97', name: 'borrowETH', textSignature: 'borrowETH(address,uint256,uint256,uint16)', params: [{ name: 'pool', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'referralCode', type: 'uint16' }], source: 'bundled' },
  { selector: '0x02c5fcf8', name: 'repayETH', textSignature: 'repayETH(address,uint256,uint256,address)', params: [{ name: 'pool', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }], source: 'bundled' },

  // Convex Booster
  { selector: '0x43a0d066', name: 'deposit', textSignature: 'deposit(uint256,uint256,bool)', params: [{ name: '_pid', type: 'uint256' }, { name: '_amount', type: 'uint256' }, { name: '_stake', type: 'bool' }], source: 'bundled' },
  { selector: '0x60759fce', name: 'depositAll', textSignature: 'depositAll(uint256,bool)', params: [{ name: '_pid', type: 'uint256' }, { name: '_stake', type: 'bool' }], source: 'bundled' },
  { selector: '0xcc956f3f', name: 'earmarkRewards', textSignature: 'earmarkRewards(uint256)', params: [{ name: '_pid', type: 'uint256' }], source: 'bundled' },
  // Convex BaseRewardPool
  { selector: '0xa694fc3a', name: 'stake', textSignature: 'stake(uint256)', params: [{ name: '_amount', type: 'uint256' }], source: 'bundled' },
  { selector: '0x8dcb4061', name: 'stakeAll', textSignature: 'stakeAll()', params: [], source: 'bundled' },
  { selector: '0x2ee40908', name: 'stakeFor', textSignature: 'stakeFor(address,uint256)', params: [{ name: '_for', type: 'address' }, { name: '_amount', type: 'uint256' }], source: 'bundled' },
  { selector: '0xc32e7202', name: 'withdrawAndUnwrap', textSignature: 'withdrawAndUnwrap(uint256,bool)', params: [{ name: 'amount', type: 'uint256' }, { name: 'claim', type: 'bool' }], source: 'bundled' },
  // Convex vlCVX Locker
  { selector: '0xe2ab691d', name: 'lock', textSignature: 'lock(address,uint256,uint256)', params: [{ name: '_account', type: 'address' }, { name: '_amount', type: 'uint256' }, { name: '_spendRatio', type: 'uint256' }], source: 'bundled' },
  { selector: '0x312ff839', name: 'processExpiredLocks', textSignature: 'processExpiredLocks(bool)', params: [{ name: '_relock', type: 'bool' }], source: 'bundled' },
];

// Intentionally fail-fast at import: a typo in `BUNDLED_SIGNATURES` must break the build, not silently ship wrong ABIs.
for (const sig of BUNDLED_SIGNATURES) {
  const vr = validateTextSignature(sig.textSignature);
  if (!vr.valid) {
    throw new Error(
      `Bundled ABI textSignature failed validation for "${sig.name}" (${sig.textSignature}): ${formatValidationError(vr.error)}`,
    );
  }
  const canonical = canonicalizeTextSignature(sig.textSignature);
  if (!canonical) {
    throw new Error(
      `Bundled ABI: canonicalizeTextSignature returned null for "${sig.name}" (${sig.textSignature}) after validation.`,
    );
  }
  const expected = keccak256(toUtf8Bytes(canonical)).slice(0, 10).toLowerCase();
  const got = sig.selector.toLowerCase();
  if (expected !== got) {
    throw new Error(
      `Bundled ABI selector mismatch for "${sig.name}" (canonical "${canonical}"): keccak gives ${expected}, registry has ${got}`,
    );
  }
  const parsed = parseTextSignature(sig.textSignature);
  if (!parsed || parsed.paramTypes.length !== sig.params.length) {
    throw new Error(
      `Bundled ABI param count mismatch for "${sig.name}" (${sig.textSignature}): text_signature has ${parsed?.paramTypes.length ?? '?'} types, params has ${sig.params.length}`,
    );
  }
  for (let i = 0; i < sig.params.length; i++) {
    if (parsed.paramTypes[i] !== sig.params[i].type) {
      throw new Error(
        `Bundled ABI param type mismatch for "${sig.name}" at index ${i}: text_signature has "${parsed.paramTypes[i]}", params has "${sig.params[i].type}"`,
      );
    }
  }
}

/**
 * Stable ordering when several bundled rows share the same 4-byte selector: prefer non-deprecated rows, then
 * higher {@link FunctionSignature.popularity}, then lexicographic `textSignature` for determinism.
 */
export function compareBundledSignaturesByRank(a: FunctionSignature, b: FunctionSignature): number {
  const dep = (s: FunctionSignature) => (s.deprecated ? 1 : 0);
  if (dep(a) !== dep(b)) return dep(a) - dep(b);
  const pop = (s: FunctionSignature) => s.popularity ?? 0;
  if (pop(b) !== pop(a)) return pop(b) - pop(a);
  return a.textSignature.localeCompare(b.textSignature);
}

const selectorMap = new Map<string, FunctionSignature[]>();
for (const sig of BUNDLED_SIGNATURES) {
  const existing = selectorMap.get(sig.selector) ?? [];
  existing.push(sig);
  selectorMap.set(sig.selector, existing);
}
for (const list of selectorMap.values()) {
  if (list.length > 1) list.sort(compareBundledSignaturesByRank);
}

export function lookupBundledSelector(selector: string): FunctionSignature[] {
  return selectorMap.get(selector.toLowerCase()) ?? [];
}

export function getAllBundledSelectors(): string[] {
  return [...selectorMap.keys()];
}

/**
 * Bundled ABI rows for Vitest invariant checks (selector ↔ keccak(textSignature), duplicate rows).
 * Note: module load already throws on selector/param drift; tests document and re-verify.
 */
export function getBundledSignaturesForTests(): readonly FunctionSignature[] {
  return BUNDLED_SIGNATURES;
}

export type StaticRegistryAddressKind = 'contract-map-key' | 'token-map-key' | 'contract-extra-address';

/** Every 20-byte address literal in static contract/token maps (keys and `addresses` aliases). */
export function* iterateStaticRegistryAddressLiterals(): Generator<{
  chainId: number;
  literal: string;
  kind: StaticRegistryAddressKind;
}> {
  for (const [cid, entries] of Object.entries(KNOWN_CONTRACTS_RAW)) {
    const chainId = Number(cid);
    for (const [key, entry] of Object.entries(entries)) {
      yield { chainId, literal: key, kind: 'contract-map-key' };
      for (const a of entry.addresses ?? []) {
        yield { chainId, literal: a, kind: 'contract-extra-address' };
      }
    }
  }
  for (const [cid, entries] of Object.entries(KNOWN_TOKENS_RAW)) {
    const chainId = Number(cid);
    for (const key of Object.keys(entries)) {
      yield { chainId, literal: key, kind: 'token-map-key' };
    }
  }
}

export function* iterateKnownContractRegistryRows(): Generator<{
  chainId: number;
  addressKey: string;
  entry: ContractRegistryEntry;
}> {
  for (const [cid, entries] of Object.entries(KNOWN_CONTRACTS_RAW)) {
    const chainId = Number(cid);
    for (const [addressKey, entry] of Object.entries(entries)) {
      yield { chainId, addressKey, entry };
    }
  }
}
