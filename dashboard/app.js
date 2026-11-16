/* Token Radar — dashboard behaviour.
 *
 * Data arrives as window.RADAR from data.js, written by main.ts beside this
 * page: a compact projection of the ranked board (no farm steps), using
 * short keys and dictionary indices so the file stays small. The farm
 * plans are regenerated here, client-side, from the same rules main.ts uses
 * for board.json — the generator below is a line-for-line port, so a plan
 * opened on this page reads the same as the one the gate checks in
 * board.json for the same protocol. Everything is local: no fetch, no
 * network, no tracking.
 */

'use strict';

const RADAR = window.RADAR;
const META = RADAR.meta;

/* The short-key mapping for data.js rows, defined once: r rank, s slug,
 * n name, c category (index into RADAR.cats, -1 = none), ch chains (indices
 * into RADAR.chains), tvl TVL in USD, chg 7-day TVL change in %, iv implied
 * pool in USD, sc score, w watchlist (1/0), age age in days. Everything
 * below works on decoded rows with the long names. */
function decodeRow(x) {
  return {
    rank: x.r,
    slug: x.s,
    name: x.n,
    category: x.c < 0 ? null : RADAR.cats[x.c],
    chains: x.ch.map((i) => RADAR.chains[i]),
    tvl_usd: x.tvl,
    change_7d: x.chg,
    implied_value_usd: x.iv,
    score: x.sc,
    watchlist: x.w === 1,
    age_days: x.age,
  };
}
const ROWS = RADAR.rows.map(decodeRow);

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtUsd(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 1e9) return '$' + trimNum(v / 1e9) + 'B';
  if (v >= 1e6) return '$' + trimNum(v / 1e6) + 'M';
  if (v >= 1e3) return '$' + trimNum(v / 1e3) + 'K';
  return '$' + v;
}

function trimNum(n) {
  return String(Math.round(n * 100) / 100);
}

function fmtFullUsd(v) {
  return '$' + Math.round(v).toLocaleString('en-US');
}

function fmtPct(c) {
  if (c === null || c === undefined) return '—';
  const pct = Math.round(c * 10) / 10;
  return (pct > 0 ? '+' : '') + pct + '%';
}

function fmtAge(days) {
  if (days === null || days === undefined) return 'age unknown';
  if (days < 30) return days + ' days old';
  if (days < 365) return Math.round(days / 30.4) + ' months old';
  return (Math.round((days / 365.25) * 10) / 10) + ' years old';
}

/* ------------------------------------------------------------------ */
/* Farm-step generation — a port of main.ts's generator, same rules,   */
/* same texts. Inputs per row: category, name, chains, tvl_usd,        */
/* change_7d, age_days.                                                */
/* ------------------------------------------------------------------ */

/** A plain-English TVL tier, used to size positions and phrase steps. */
function tvlTier(tvl) {
  if (tvl >= 1_000_000_000) return 'deep-liquidity tier (over $1B in TVL)';
  if (tvl >= 100_000_000) return 'large tier ($100M+ in TVL)';
  if (tvl >= 10_000_000) return 'mid tier ($10M+ in TVL)';
  if (tvl >= 1_000_000) return 'small tier ($1M+ in TVL)';
  return 'micro tier (under $1M in TVL)';
}

/** Starter capital for one farming wallet, sized to the protocol's tier. */
function capitalFor(tvl) {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 10_000_000) return 75;
  return 40;
}

/** How long a position should season, from the protocol's age. */
function holdDaysFor(age) {
  if (age === null) return 35;
  if (age < 180) return 45;
  if (age < 365) return 35;
  return 28;
}

/** A note on this week's TVL direction, from the snapshot's 7-day change. */
function momentumNote(p) {
  const c = p.change_7d;
  if (c === null) return 'the snapshot records no 7-day TVL change for it, so size in conservatively';
  const pct = Math.round(c * 10) / 10;
  if (c >= 5) return `its TVL is climbing fast this week (${pct}% in 7 days), so build the position gradually instead of chasing`;
  if (c <= -5) return `its TVL dipped ${Math.abs(pct)}% this week, so start with a half-size position and add only if TVL stabilises`;
  return `its TVL is roughly flat this week (${pct}% in 7 days), so a steady position is fine`;
}

/** The core farming action for a category, phrased for this protocol. */
function coreAction(p, capital, chain) {
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
function slugHash(slug) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

/** Where this protocol shows a farmer their standing: its points or rewards surface, by category. */
function rewardSurface(p) {
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
function weeklyStep(p, tier, note, variant) {
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
function claimStep(p, variant) {
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

/** Six farm steps for one row — the same six board.json carries. */
function farmSteps(p) {
  const age = p.age_days;
  const chain = p.chains.length > 0 ? p.chains[0] : 'its main chain';
  const chainList = p.chains.length > 1 ? p.chains.join(', ') : chain;
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const h = slugHash(p.slug);
  const steps = [
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

function stepsListHtml(p) {
  return '<ol class="steps">' + farmSteps(p).map((s) => `<li>${esc(s)}</li>`).join('') + '</ol>';
}

/* ------------------------------------------------------------------ */
/* Header: snapshot line + headline stats                              */
/* ------------------------------------------------------------------ */

document.getElementById('snapshot-line').textContent =
  `Snapshot ${META.as_of} · Source: ${META.source} · TVL floor ${fmtFullUsd(META.floor_usd)} · ` +
  'computed entirely from the snapshot — no live data, no network.';

const stats = [
  [META.protocols_scanned.toLocaleString('en-US'), 'protocols scanned'],
  [META.board_size.toLocaleString('en-US'), 'protocols ranked'],
  [META.watchlist_size.toLocaleString('en-US'), 'on the watchlist'],
  [fmtUsd(META.total_implied_value_usd), 'total implied airdrop pool'],
];
document.getElementById('stat-grid').innerHTML = stats
  .map(([v, l]) => `<div class="stat"><span class="stat-value">${esc(v)}</span><span class="stat-label">${esc(l)}</span></div>`)
  .join('');

/* ------------------------------------------------------------------ */
/* The board: filter, sort, render, expand                             */
/* ------------------------------------------------------------------ */

const state = { q: '', cat: '', watchOnly: false, sortKey: 'rank', dir: 1 };
const openSlugs = new Set();
const planCache = new Map();

const catSelect = document.getElementById('cat');
[...new Set(ROWS.map((r) => r.category ?? 'Uncategorised'))]
  .sort()
  .forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    catSelect.appendChild(opt);
  });

function visibleRows() {
  let out = ROWS.filter((r) => {
    if (state.watchOnly && !r.watchlist) return false;
    if (state.cat && (r.category ?? 'Uncategorised') !== state.cat) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      if (!r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const k = state.sortKey;
  out.sort((a, b) => {
    let va = a[k];
    let vb = b[k];
    if (va === null || va === undefined) va = -Infinity;
    if (vb === null || vb === undefined) vb = -Infinity;
    if (typeof va === 'string') return state.dir * va.localeCompare(vb) || a.rank - b.rank;
    return state.dir * (va - vb) || a.rank - b.rank;
  });
  return out;
}

function planHtml(r) {
  if (!planCache.has(r.slug)) {
    const meta =
      `<p class="detail-meta">${esc(r.category ?? 'Uncategorised')} · ${esc(r.chains.join(', ') || 'chain not recorded')} · ` +
      `${esc(tvlTier(r.tvl_usd))} · ${esc(fmtAge(r.age_days))} · implied pool ${esc(fmtFullUsd(r.implied_value_usd))} (model estimate)</p>`;
    planCache.set(r.slug, meta + stepsListHtml(r));
  }
  return planCache.get(r.slug);
}

function renderBoard() {
  const rows = visibleRows();
  document.getElementById('result-count').textContent =
    `Showing ${rows.length} of ${ROWS.length} protocols`;
  const html = rows.map((r) => {
    const open = openSlugs.has(r.slug);
    const pctCls = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
    const main =
      `<tr class="row${open ? ' open' : ''}" data-slug="${esc(r.slug)}">` +
      `<td class="num rank">${r.rank}</td>` +
      `<td class="name">${esc(r.name)}${r.watchlist ? '<span class="badge">Watchlist</span>' : ''}` +
      `<span class="slug">${esc(r.slug)}</span></td>` +
      `<td>${esc(r.category ?? '—')}</td>` +
      `<td class="chains">${esc(r.chains.join(', '))}</td>` +
      `<td class="num" title="${esc(fmtFullUsd(r.tvl_usd))}">${esc(fmtUsd(r.tvl_usd))}</td>` +
      `<td class="num"><span class="${pctCls}">${esc(fmtPct(r.change_7d))}</span></td>` +
      `<td class="num">${r.score}</td>` +
      `<td class="num implied" title="${esc(fmtFullUsd(r.implied_value_usd))}">${esc(fmtUsd(r.implied_value_usd))}</td>` +
      `<td><button class="plan-btn" data-plan="${esc(r.slug)}" aria-expanded="${open}">${open ? 'Hide plan' : 'Farm plan'}</button></td></tr>`;
    const detail = open
      ? `<tr class="detail" data-detail="${esc(r.slug)}"><td colspan="9">${planHtml(r)}</td></tr>`
      : '';
    return main + detail;
  }).join('');
  document.getElementById('board-body').innerHTML =
    html || '<tr><td colspan="9">No protocols match the current filters.</td></tr>';
  document.querySelectorAll('th.sortable').forEach((th) => {
    const arrow = th.dataset.key === state.sortKey ? (state.dir === 1 ? ' ▲' : ' ▼') : '';
    th.innerHTML = th.dataset.label + (arrow ? `<span class="arrow">${arrow}</span>` : '');
  });
}

document.querySelectorAll('th.sortable').forEach((th) => {
  th.dataset.label = th.textContent;
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (state.sortKey === key) state.dir *= -1;
    else {
      state.sortKey = key;
      state.dir = key === 'name' ? 1 : -1;
      if (key === 'rank') state.dir = 1;
    }
    renderBoard();
  });
});

document.getElementById('board-body').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-plan]');
  const tr = ev.target.closest('tr.row');
  const slug = btn ? btn.dataset.plan : tr ? tr.dataset.slug : null;
  if (!slug) return;
  if (openSlugs.has(slug)) openSlugs.delete(slug);
  else openSlugs.add(slug);
  renderBoard();
});

document.getElementById('q').addEventListener('input', (ev) => {
  state.q = ev.target.value.trim();
  renderBoard();
});
catSelect.addEventListener('change', (ev) => {
  state.cat = ev.target.value;
  renderBoard();
});
document.getElementById('watch-only').addEventListener('change', (ev) => {
  state.watchOnly = ev.target.checked;
  renderBoard();
});

renderBoard();

/* ------------------------------------------------------------------ */
/* Watchlist cards                                                     */
/* ------------------------------------------------------------------ */

document.getElementById('watch-grid').innerHTML = ROWS
  .filter((r) => r.watchlist)
  .sort((a, b) => a.rank - b.rank)
  .map((r) => {
    const pctCls = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
    return (
      `<article class="card">` +
      `<header><span class="rank">#${r.rank}</span><h3>${esc(r.name)}</h3></header>` +
      `<p class="card-cat">${esc(r.category ?? 'Uncategorised')} · ${esc(r.chains.join(', '))}</p>` +
      `<dl>` +
      `<div><dt>Implied</dt><dd>${esc(fmtUsd(r.implied_value_usd))}</dd></div>` +
      `<div><dt>TVL</dt><dd>${esc(fmtUsd(r.tvl_usd))}</dd></div>` +
      `<div><dt>Score</dt><dd>${r.score}</dd></div>` +
      `<div><dt>7d TVL</dt><dd><span class="${pctCls}">${esc(fmtPct(r.change_7d))}</span></dd></div>` +
      `</dl>` +
      `<details><summary>Farm plan — 6 steps</summary>${stepsListHtml(r)}</details>` +
      `</article>`
    );
  })
  .join('');
