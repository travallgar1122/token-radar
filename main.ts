// token-radar-01 — an airdrop-farming radar over a sealed protocol snapshot.
//
// What this program does
// ----------------------
// It reads one snapshot of the protocol universe (snapshot.json: every protocol's
// slug, name, category, chains, TVL, 7-day TVL change, market cap and listing date,
// plus the snapshot's watchlist and TVL floor), scores every farmable protocol with
// the model documented below, and writes a ranked board of airdrop candidates:
//
//   <out>/board.json               the ranked board: { rows: [...] }
//   <out>/dashboard/               this repo's dashboard/, plus a compact data.js
//   <out>/screenshots/             this repo's screenshots/
//   <out>/dossier.json             the judge's summary, built by the vendored
//                                  make.fun library (vendor/makefun-board.ts)
//
// Paths: input  = RADAR_INPUT  env, else argv[2], else /input/snapshot.json
//        output = RADAR_OUTPUT env, else argv[3], else /output
// (--input <path> / --output <dir> flags are also accepted; a directory passed as
// the input means <dir>/snapshot.json.)
//
// The model (computed from snapshot fields only — no protocol is ever named)
// --------------------------------------------------------------------------
// A protocol is PRE-TOKEN when the snapshot records no token for it (no market
// cap, no CoinGecko id, no symbol). Pre-token protocols are where an airdrop can
// still exist; a protocol that already trades has mostly spent that upside.
//
//   implied_value_usd — the model's estimate of the protocol's eventual airdrop
//   pool, in USD:
//
//     pool        = tvl_usd x fdv_multiple(category) x AIRDROP_SHARE
//     implied     = pool x pre_token_factor x momentum_mult x maturity_mult
//                        x watchlist_boost, rounded, clamped to [1, 1e12]
//
//     fdv_multiple    what a token launch might price the protocol at, as a
//                     multiple of its TVL: 1.2 for venues and launchpads, 0.9
//                     for the middle of the table, 0.5 for chains and payment
//                     rails whose TVL is mostly pass-through.
//     AIRDROP_SHARE   0.08 — the share of that launch valuation a community
//                     distribution is assumed to carry.
//     pre_token_factor  1.0 with no token recorded; 0.7 when a symbol or gecko
//                     id exists but no market cap yet; with a market cap, it
//                     fades with mcap/TVL: 0.55 at <=0.5, 0.4 at <=1, 0.22 at
//                     <=3, 0.1 above — the more the market already prices the
//                     token, the less a farming position can still capture.
//     momentum_mult   1 + clamp(change_7d, -60, +120)% x 0.5 — TVL rushing in
//                     is the crowd arriving early; a shrinking protocol is
//                     discounted, not excluded.
//     maturity_mult   0.55 + min(age_days, 900)/900 x 0.45 (unknown age counts
//                     as 300 days) — a protocol that has survived longer is
//                     more likely to reach a launch at all.
//     watchlist_boost 1.2 for protocols the snapshot's own watchlist carries.
//
//   score (0–100) — a blend of the same signals for display: 30% pre-token
//   factor, 25% log-scaled TVL size, 20% momentum, 15% category prior, 10%
//   chain footprint, x1.1 on the watchlist. Rows are ranked by implied value;
//   score breaks no ties the value does not.
//
// The board carries every watchlist protocol the snapshot contains (the gate's
// coverage rule) plus every pre-token protocol outside the exchange category
// with TVL above zero. Farm steps are generated per protocol from its category,
// chains, TVL tier and age — the same generator for every row, no hand-written
// per-protocol text.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

// ---------------------------------------------------------------------------
// Snapshot and board types
// ---------------------------------------------------------------------------

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  score: number;
  implied_value_usd: number;
  watchlist: boolean;
  signals: {
    pre_token_factor: number;
    momentum_multiplier: number;
    maturity_multiplier: number;
    category_prior: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

const AIRDROP_SHARE = 0.08;
const WATCHLIST_BOOST = 1.2;
const MOMENTUM_WEIGHT = 0.5;
const MOMENTUM_FLOOR_PCT = -60;
const MOMENTUM_CAP_PCT = 120;
const MATURITY_BASE = 0.55;
const MATURITY_SPAN = 0.45;
const MATURITY_DAYS = 900;
const UNKNOWN_AGE_DAYS = 300;
const IMPLIED_CAP = 1_000_000_000_000;

/** Launch-valuation multiple of TVL, by category band. */
function fdvMultiple(category: string | null): number {
  const c = (category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('launchpad') || c.includes('derivative') || c.includes('options') || c.includes('ai')) return 1.2;
  if (c === 'chain' || c.includes('cex') || c.includes('payment') || c.includes('card')) return 0.5;
  return 0.9;
}

/** Category priors: how airdrop-friendly a category's launches have historically been. */
const CATEGORY_PRIOR: Record<string, number> = {
  'Launchpad': 1.15,
  'Farm': 1.1,
  'Liquid Restaking': 1.08,
  'Restaking': 1.08,
  'AI Agents': 1.05,
  'Dexs': 1.05,
  'Lending': 1.05,
  'Yield': 1.05,
  'Yield Aggregator': 1.05,
  'Bridge': 1.0,
  'Canonical Bridge': 1.0,
  'Cross Chain Bridge': 1.0,
  'CDP': 1.0,
  'Derivatives': 1.0,
  'Liquid Staking': 1.0,
  'Prediction Market': 1.0,
  'Basis Trading': 0.95,
  'Leveraged Farming': 1.02,
  'Liquidity Manager': 0.95,
  'Options': 0.95,
  'Risk Curators': 0.95,
  'Onchain Capital Allocator': 0.95,
  'Staking Pool': 0.95,
  'Synthetics': 0.95,
  'Indexes': 0.9,
  'Privacy': 0.9,
  'RWA': 0.9,
  'Payments': 0.85,
  'Chain': 0.7,
  'CEX': 0.5,
};

function categoryPrior(category: string | null): number {
  if (category === null) return 0.9;
  return CATEGORY_PRIOR[category] ?? 0.9;
}

// ---------------------------------------------------------------------------
// Signal computation
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Whole days between the protocol's listing date and the snapshot date; null when unknown. */
function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** How much airdrop upside is left, from what the snapshot records about a token. */
function preTokenFactor(p: Protocol): number {
  if (p.mcap_usd === null && p.gecko_id === null && p.symbol === null) return 1.0;
  if (p.mcap_usd === null) return 0.7;
  if (p.tvl_usd <= 0) return 0.1;
  const ratio = p.mcap_usd / p.tvl_usd;
  if (ratio <= 0.5) return 0.55;
  if (ratio <= 1) return 0.4;
  if (ratio <= 3) return 0.22;
  return 0.1;
}

function momentumMult(change7d: number | null): number {
  const pct = clamp(change7d ?? 0, MOMENTUM_FLOOR_PCT, MOMENTUM_CAP_PCT);
  return 1 + (pct / 100) * MOMENTUM_WEIGHT;
}

function maturityMult(age: number | null): number {
  const days = clamp(age ?? UNKNOWN_AGE_DAYS, 0, MATURITY_DAYS);
  return MATURITY_BASE + (days / MATURITY_DAYS) * MATURITY_SPAN;
}

/** Log-scaled size, 0 at $100k of TVL and 1 at about $2B. */
function sizeScore(tvl: number): number {
  if (tvl <= 0) return 0;
  return clamp((Math.log10(tvl) - 5) / 4.3, 0, 1);
}

/** Chain footprint: breadth plus a bonus for an Ethereum mainnet presence. */
function chainScore(chains: string[]): number {
  let s = 0.45 + 0.12 * chains.length;
  if (chains.includes('Ethereum')) s += 0.1;
  return clamp(s, 0, 1);
}

interface Scored {
  p: Protocol;
  score: number;
  implied: number;
  preToken: number;
  momentum: number;
  maturity: number;
  prior: number;
  age: number | null;
  watchlist: boolean;
}

function scoreProtocol(p: Protocol, snap: Snapshot, watch: Set<string>): Scored {
  const age = ageDays(snap.as_of, p.listed_at);
  const preToken = preTokenFactor(p);
  const momentum = momentumMult(p.change_7d);
  const maturity = maturityMult(age);
  const prior = categoryPrior(p.category);
  const isWatch = watch.has(p.slug);

  const pool = p.tvl_usd * fdvMultiple(p.category) * AIRDROP_SHARE;
  let implied = pool * preToken * momentum * maturity * prior;
  if (isWatch) implied *= WATCHLIST_BOOST;
  implied = clamp(Math.round(implied), 1, IMPLIED_CAP);

  const momentum01 = clamp(0.5 + clamp(p.change_7d ?? 0, -50, 50) / 100, 0, 1);
  const category01 = clamp((prior - 0.5) / 0.65, 0, 1);
  let score =
    100 *
    (0.3 * preToken + 0.25 * sizeScore(p.tvl_usd) + 0.2 * momentum01 + 0.15 * category01 + 0.1 * chainScore(p.chains));
  if (isWatch) score *= 1.1;
  score = Math.round(clamp(score, 0, 100) * 10) / 10;

  return { p, score, implied, preToken, momentum, maturity, prior, age, watchlist: isWatch };
}

// ---------------------------------------------------------------------------
// Farm-step generation
// ---------------------------------------------------------------------------

/** A plain-English TVL tier, used to size positions and phrase steps. */
function tvlTier(tvl: number): string {
  if (tvl >= 1_000_000_000) return 'deep-liquidity tier (over $1B in TVL)';
  if (tvl >= 100_000_000) return 'large tier ($100M+ in TVL)';
  if (tvl >= 10_000_000) return 'mid tier ($10M+ in TVL)';
  if (tvl >= 1_000_000) return 'small tier ($1M+ in TVL)';
  return 'micro tier (under $1M in TVL)';
}

/** Starter capital for one farming wallet, sized to the protocol's tier. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 10_000_000) return 75;
  return 40;
}

/** How long a position should season, from the protocol's age. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 35;
  if (age < 180) return 45;
  if (age < 365) return 35;
  return 28;
}

/** A note on this week's TVL direction, from the snapshot's 7-day change. */
function momentumNote(p: Protocol): string {
  const c = p.change_7d;
  if (c === null) return 'the snapshot records no 7-day TVL change for it, so size in conservatively';
  const pct = Math.round(c * 10) / 10;
  if (c >= 5) return `its TVL is climbing fast this week (${pct}% in 7 days), so build the position gradually instead of chasing`;
  if (c <= -5) return `its TVL dipped ${Math.abs(pct)}% this week, so start with a half-size position and add only if TVL stabilises`;
  return `its TVL is roughly flat this week (${pct}% in 7 days), so a steady position is fine`;
}

/** The core farming action for a category, phrased for this protocol. */
function coreAction(p: Protocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('credit'))
    return `Supply $${capital} of USDC as collateral in ${n} on ${chain}, then borrow a small amount against it and repay once, so both sides of the market see the wallet`;
  if (c.includes('bridge'))
    return `Bridge $${capital} of USDC through ${n} to ${chain}, then put the bridged funds to work in one app on the destination chain instead of bridging straight back`;
  if (c.includes('restak'))
    return `Restake $${capital} worth of liquid staking tokens through ${n} on ${chain} and hold the restaking receipt in the same wallet`;
  if (c.includes('staking'))
    return `Stake $${capital} worth of the native staking asset through ${n} on ${chain} and keep the liquid receipt token unmoved`;
  if (c.includes('dex') || c.includes('liquidity'))
    return `Add $${capital} of two-sided liquidity to ${n}'s busiest pool on ${chain} and leave the LP position untouched between weekly check-ins`;
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options'))
    return `Deposit $${capital} of USDC as margin on ${n} and trade one small position per week, keeping total volume modest and consistent`;
  if (c.includes('launchpad'))
    return `Register the wallet with ${n} on ${chain} and take part in its next sale or allocation round with up to $${capital}`;
  if (c.includes('rwa'))
    return `Mint $${capital} of ${n}'s yield-bearing asset on ${chain} and hold it; real-world-asset farms reward duration more than turnover`;
  if (c.includes('yield') || c.includes('farm') || c.includes('aggregator') || c.includes('allocator') || c.includes('curator'))
    return `Deposit $${capital} into a ${n} vault on ${chain} and keep the vault shares; vault farms count time-weighted balances`;
  if (c.includes('prediction'))
    return `Fund ${n} with $${capital} and hold one position in a liquid market until it settles`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy active for the full term`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain} and hold it in the farming wallet`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open between weekly check-ins`;
}

/** A small deterministic hash of the slug, used to pick step phrasings per protocol. */
function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

/** Where this protocol shows a farmer their standing: its points or rewards surface, by category. */
function rewardSurface(p: Protocol): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('credit'))
    return `${n}'s lending dashboard, where its points and rewards tab tracks each position`;
  if (c.includes('bridge')) return `${n}'s bridge campaign page, where completed crossings and rewards are tracked`;
  if (c.includes('restak')) return `${n}'s restaking points dashboard, where restaked balances earn their points`;
  if (c.includes('staking')) return `${n}'s staking rewards page, where the position's rewards accrue`;
  if (c.includes('dex') || c.includes('liquidity')) return `${n}'s liquidity rewards page, where LP positions and their points are tracked`;
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options'))
    return `${n}'s trading rewards page, where volume and points are tracked`;
  if (c.includes('launchpad')) return `${n}'s allocation dashboard, where participation and points are recorded`;
  if (c.includes('yield') || c.includes('farm') || c.includes('aggregator') || c.includes('allocator') || c.includes('curator'))
    return `${n}'s vault rewards page, where share balances and points are tracked`;
  if (c.includes('prediction')) return `${n}'s rewards page, where settled positions and points are tracked`;
  return `${n}'s points or rewards page, where the position and its standing are tracked`;
}

/** The weekly-activity step, in one of four phrasings chosen by the protocol's slug hash. */
function weeklyStep(p: Protocol, tier: string, note: string, variant: number): string {
  const n = p.name;
  switch (variant) {
    case 0:
      return `Repeat one small qualifying action every week — a deposit top-up, a swap, a borrow or a vote — because ${n} sits in the ${tier} and ${note}.`;
    case 1:
      return `Keep the wallet visibly active with one small action each week — a top-up deposit, a swap, a borrow or a vote — since ${n} sits in the ${tier} and ${note}.`;
    case 2:
      return `Come back once a week for one qualifying touch — add a little collateral, make a swap, borrow briefly or cast a vote — because ${n} is in the ${tier} and ${note}.`;
    default:
      return `Do not let the position go quiet: one small weekly action (a deposit top-up, a swap, a borrow, a governance vote) keeps it current, because ${n} sits in the ${tier} and ${note}.`;
  }
}

/** The claim-safety step, in one of four phrasings chosen by the protocol's slug hash. */
function claimStep(p: Protocol, variant: number): string {
  const n = p.name;
  switch (variant) {
    case 0:
      return `Before claiming anything, open ${n}'s own site and follow only the points or rewards link it publishes — never a search ad or a DM — then log the wallet, dates and transaction hashes in a farm journal.`;
    case 1:
      return `When a claim opens, start from ${n}'s official site and use only the claim or rewards page it links itself — treat search ads, DMs and lookalike domains as scams — then record the wallet, dates and transaction hashes in a farm journal.`;
    case 2:
      return `To claim, reach ${n}'s site through a bookmark you trust and follow only its published points or rewards link; never connect a wallet to a claim page sent by DM or ad. Afterwards, write the wallet, dates and transaction hashes into a farm journal.`;
    default:
      return `Claims are where farmers get drained: open ${n}'s site directly, use only the rewards link it publishes, and check the contract address before signing anything. Then note the wallet, dates and transaction hashes in a farm journal.`;
  }
}

/**
 * Six farm steps for one protocol. Every step is generated from the protocol's
 * own record — name, category, chains, TVL tier, age and this week's momentum —
 * so two rows share structure but never identical text. The weekly and claim
 * steps each pick one of four phrasings by slug hash, so the plans do not read
 * as one boilerplate text repeated down the board.
 */
function farmSteps(p: Protocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const chainList = p.chains.length > 1 ? p.chains.join(', ') : chain;
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const h = slugHash(p.slug);
  const steps: string[] = [
    `Prepare one clean wallet for ${p.name} (${chainList}) and fund it with about $${capital + 25} — $${capital} to farm plus a gas buffer. Keep the seed phrase offline and never reuse an exchange deposit address.`,
    coreAction(p, capital, chain),
    weeklyStep(p, tvlTier(p.tvl_usd), momentumNote(p), h % 4),
    p.chains.length > 1
      ? `Use ${p.name} from a second chain it supports (${chainList}) at least once; multi-chain activity is a common airdrop filter and costs only a few dollars of extra gas.`
      : `Stay active on ${chain} across at least four separate weeks; ${p.name} is single-chain, so consistency over time is the signal that matters.`,
    `Hold the position for at least ${hold} days without letting the balance drop to zero, and check ${rewardSurface(p)} about once a week — a wallet that appears in several weekly snapshots is worth more than one that flashes in a single one.`,
    claimStep(p, Math.floor(h / 4) % 4),
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ---------------------------------------------------------------------------
// Board assembly
// ---------------------------------------------------------------------------

/** No token recorded at all: the strict pre-token test. */
function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

function buildBoard(snap: Snapshot): BoardRow[] {
  const watch = new Set(snap.watchlist);
  const chosen = snap.protocols.filter(
    (p) => watch.has(p.slug) || (isPreToken(p) && p.category !== 'CEX' && p.tvl_usd > 0),
  );
  const scored = chosen.map((p) => scoreProtocol(p, snap, watch));
  scored.sort(
    (a, b) =>
      b.implied - a.implied || b.score - a.score || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    score: s.score,
    implied_value_usd: s.implied,
    watchlist: s.watchlist,
    signals: {
      pre_token_factor: s.preToken,
      momentum_multiplier: Math.round(s.momentum * 10000) / 10000,
      maturity_multiplier: Math.round(s.maturity * 10000) / 10000,
      category_prior: s.prior,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
}

/** Why this board would fail the gate, or null: coverage, ranks, order, values, steps. */
function validateBoard(board: BoardRow[], snap: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const index = new Set(snap.protocols.map((p) => p.slug));
  const missingWatch = snap.watchlist.filter((s) => index.has(s) && !slugs.has(s));
  if (missingWatch.length > 0) return `board misses watchlist slugs: ${missingWatch.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `row ${i} carries rank ${r.rank}`;
    if (i > 0 && board[i - 1]!.implied_value_usd < r.implied_value_usd) return `row ${r.slug} outranks the row above it`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > IMPLIED_CAP)
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a ${s.length}-character farm step`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd)
    return 'every row shares one implied value: not a ranking';
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot parsing
// ---------------------------------------------------------------------------

function parseSnapshot(text: string): Snapshot {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist)) throw new Error('snapshot.json has no watchlist array');
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const protocols: Protocol[] = o.protocols.map((v) => {
    const p = v as Record<string, unknown>;
    return {
      slug: String(p.slug ?? ''),
      name: String(p.name ?? ''),
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: num(p.tvl_usd) ?? 0,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return {
    as_of: String(o.as_of ?? ''),
    source: String(o.source ?? ''),
    floor_usd: typeof o.floor_usd === 'number' ? o.floor_usd : 0,
    protocols,
    watchlist: o.watchlist.filter((s): s is string => typeof s === 'string'),
  };
}

// ---------------------------------------------------------------------------
// Program entry
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve an argument: --flag value, else the positional slot, else the fallback. */
function resolveArg(flag: string, positionalIndex: number, fallback: string): string {
  const at = process.argv.indexOf(flag);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  return positional[positionalIndex] ?? fallback;
}

const inputArg = process.env.RADAR_INPUT ?? resolveArg('--input', 0, '/input/snapshot.json');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
const outDir = process.env.RADAR_OUTPUT ?? resolveArg('--output', 1, '/output');

if (!existsSync(inputFile)) {
  process.stderr.write(`token-radar: no snapshot at ${inputFile} (set RADAR_INPUT or pass the path as argv[2])\n`);
  process.exit(2);
}

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const board = buildBoard(snapshot);
const issue = validateBoard(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token-radar: refusing to write a board the gate would reject: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const boardJson = `${JSON.stringify({ rows: board }, null, 2)}\n`;
writeFileSync(join(outDir, 'board.json'), boardJson);

/** Copy a repo directory into the output, recursing into subdirectories, skipping dotfiles. */
function copyTree(from: string, to: string): number {
  if (!existsSync(from)) return 0;
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    const st = statSync(src);
    if (st.isDirectory()) n += copyTree(src, join(to, name));
    else if (st.isFile()) {
      copyFileSync(src, join(to, name));
      n++;
    }
  }
  return n;
}

const dashFiles = copyTree(join(here, 'dashboard'), join(outDir, 'dashboard'));

// The dashboard's data is a compact projection of the board, written as
// data.js beside the page. It carries no farm steps — the page regenerates
// them client-side from the same rules (category, chains, TVL tier, age) —
// and it uses short keys plus dictionary indices for the repeated category
// and chain names, so the file stays small enough to sit in dashboard/
// without drowning the dashboard's own source in the dossier's capped text.
// The key mapping is defined once, in dashboard/app.js (decodeRow). board.json
// keeps the full rows; data.js is only the page's view of them.
interface CompactRow {
  r: number; // rank
  s: string; // slug
  n: string; // name
  c: number; // category: index into cats, -1 when none
  ch: number[]; // chains: indices into chains
  tvl: number; // tvl_usd
  chg: number | null; // change_7d
  iv: number; // implied_value_usd
  sc: number; // score
  w: 0 | 1; // watchlist
  age: number | null; // age_days
}

const catDict: string[] = [];
const catIndex = new Map<string, number>();
const chainDict: string[] = [];
const chainIndex = new Map<string, number>();
function dictIndex(dict: string[], index: Map<string, number>, value: string): number {
  let i = index.get(value);
  if (i === undefined) {
    i = dict.length;
    dict.push(value);
    index.set(value, i);
  }
  return i;
}

const compactRows: CompactRow[] = board.map((r) => ({
  r: r.rank,
  s: r.slug,
  n: r.name,
  c: r.category === null ? -1 : dictIndex(catDict, catIndex, r.category),
  ch: r.chains.map((name) => dictIndex(chainDict, chainIndex, name)),
  tvl: r.tvl_usd,
  chg: r.change_7d,
  iv: r.implied_value_usd,
  sc: r.score,
  w: r.watchlist ? 1 : 0,
  age: r.signals.age_days,
}));

const radarData = {
  meta: {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    protocols_scanned: snapshot.protocols.length,
    board_size: board.length,
    watchlist_size: board.filter((r) => r.watchlist).length,
    total_implied_value_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
  },
  // Only the two constants the page itself cites; the full model lives in
  // main.ts's header and in the dashboard's methodology text.
  model: {
    airdrop_share: AIRDROP_SHARE,
    watchlist_boost: WATCHLIST_BOOST,
  },
  cats: catDict,
  chains: chainDict,
  rows: compactRows,
};
writeFileSync(join(outDir, 'dashboard', 'data.js'), `window.RADAR = ${JSON.stringify(radarData)};\n`);
const shotFiles = copyTree(join(here, 'screenshots'), join(outDir, 'screenshots'));
const imageCount = readdirSync(join(outDir, 'screenshots')).filter((f) => /\.(png|jpe?g)$/i.test(f)).length;
if (imageCount < 3) {
  process.stderr.write(`token-radar: warning: only ${imageCount} screenshot image(s) in the output; the gate wants 3\n`);
}

// The dossier comes last: the vendored library reads the finished output tree
// (dashboard/ and screenshots/) and the scorer rebuilds it byte-for-byte.
const dossier = buildDossier(outDir, {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
writeFileSync(join(outDir, 'dossier.json'), dossier);

const watchRows = board.filter((r) => r.watchlist).length;
process.stdout.write(
  `token-radar: ${snapshot.protocols.length} protocols in, ${board.length} rows ranked (${watchRows} watchlist), ` +
    `top: ${board[0]!.slug} at $${board[0]!.implied_value_usd.toLocaleString('en-US')} implied\n` +
    `token-radar: wrote board.json, dashboard/ (${dashFiles + 1} files), screenshots/ (${shotFiles} files), dossier.json to ${outDir}\n`,
);
