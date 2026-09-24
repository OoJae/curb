// /depth: bond depth and watch the LTV move (lane E).
// The published LTV function with a hypothetical-depth handle, the DepthCert book CurbCredit reads,
// the fade explainer, a Refusal shown as the successful transaction it is, the cure clock, and the
// post / take / deposit / borrow / repay steps for a connected wallet. While the W4 addresses are
// null the page renders lane B's fixtures as an honest "Specimen · in build".
import { boot } from '../../shell/boot';
import './page.css';

import { decodeEventLog, keccak256, parseUnits, toHex, type Hex } from 'viem';
import {
  approveUsdg, approveWrapper, borrow, creditLive, deposit, depthLive, getCreditPosition, getDepth, minBond, notional,
  postCert, refusalsIn, repay, takeCert, CURE_OPEN_SECONDS, MIN_CERT_LIFE_S, REFUSAL_REASONS, SHUT_CERT_LIFE_S,
} from '../../data/depth';
import { curbCreditAbi } from '../../data/abi/curbCredit';
import {
  AGENTIC_WALLET, ASSETS, CURB_CREDIT, CURB_DESK, DEMO_IDS, DEPLOYER, DEPTH_CERT, ELIGIBILITY_REGISTRY, MARKET_CLOCK, SCORECARD, USDG,
  type CohortAsset,
} from '../../data/addresses';
import { depthCertAbi } from '../../data/abi/depthCert';
import { eligibilityAbi } from '../../data/abi/eligibility';
import { publicClient } from '../../data/chain';
import { isMock } from '../../data/mock';
import { getRegime } from '../../data/regime';
import type { Address, CertView, CreditPosition, DepthView, RegimeState } from '../../data/types';
import type { WriteOutcome } from '../../data/wallet';
import { certificateHTML, enableTilt } from '../../certificate/certificate';
import { fmtAgo, fmtBlock } from '../../ui/format';
import { html, render, type SafeHTML } from '../../ui/html';
import { statHTML } from '../../ui/stat';
import { addressLinkHTML } from '../../ui/txlink';
import { fmtPct, fmtShares, fmtUsdg, gate, hktDate, hktShort, mountWalletBar, statusTagHTML, txAction, whoHTML } from '../notes/instrument';
import { mountLtvPlot } from './plot';

const shell = boot({ page: 'depth' });
const $ = <T extends Element = HTMLElement>(sel: string) => shell.main.querySelector<T>(sel);

const TEAM: Record<string, string> = {
  [CURB_DESK.toLowerCase()]: 'team: curb-desk',
  [AGENTIC_WALLET.toLowerCase()]: 'team: Agentic Wallet',
  [DEPLOYER.toLowerCase()]: 'team: deployer',
  ...(CURB_CREDIT ? { [CURB_CREDIT.toLowerCase()]: 'CurbCredit' } : {}),
};
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const LIVE = { depth: depthLive(), credit: creditLive() };
const W4_LIVE = LIVE.depth && LIVE.credit;
/** CurbCredit lends against the five priced wrappers (not wSHEINx, which has no price source). */
const PRICED: CohortAsset[] = ASSETS.filter((a) => a.pool !== null);
const CHOICES: CohortAsset[] = W4_LIVE ? PRICED : PRICED.slice(0, 1);
let asset: CohortAsset = CHOICES[0]!;

interface State {
  depth: DepthView;
  position: CreditPosition | null;
  borrower: Address;
  regime: RegimeState | null;
  /** CurbCredit.minCertExpiry(asset) in ms (live), or an estimate from the published rule (specimen). */
  horizon: { ms: number; estimate: boolean } | null;
}

/** The published cert horizon: now + (open ? 1 h : max(73 h, next transition + 1 h)) + 30 min. Estimate only. */
function horizonEstimate(r: RegimeState | null, now = Date.now()): number | null {
  if (!r || r.regime === 'UNKNOWN') return null;
  const open = r.cap > 0;
  const toNext = r.nextTransitionAtMs && r.nextTransitionAtMs > now ? r.nextTransitionAtMs - now : 0;
  const life = open ? MIN_CERT_LIFE_S * 1000 : Math.max(SHUT_CERT_LIFE_S * 1000, toNext + MIN_CERT_LIFE_S * 1000);
  return now + life + CURE_OPEN_SECONDS * 1000;
}

async function readHorizon(r: RegimeState | null): Promise<State['horizon']> {
  if (W4_LIVE && !isMock()) {
    try {
      const v = await publicClient().readContract({ address: CURB_CREDIT!, abi: curbCreditAbi, functionName: 'minCertExpiry', args: [asset.wrapper] });
      return { ms: Number(v) * 1000, estimate: false };
    } catch {
      /* fall through to the estimate */
    }
  }
  const e = horizonEstimate(r);
  return e ? { ms: e, estimate: true } : null;
}
let state: State | null = null;

const REASON_WORDS: Record<(typeof REFUSAL_REASONS)[number], string> = {
  Ineligible: 'The borrower is not on the eligibility registry.',
  UnsupportedAsset: 'CurbCredit does not lend against this asset.',
  MarketUnknown: 'MarketClock is stale: no attestation in the last 30 minutes.',
  PriceUnavailable: 'Scorecard cannot price the asset right now.',
  NoDepth: 'No honoured, bonded bid names CurbCredit for this asset.',
  ExceedsLtv: 'The loan would take the position over its limit.',
  ExceedsDepth: 'Total lending on the asset would exceed what the bonded bids would pay.',
  ReserveShort: 'The reserve does not hold that much USDG.',
  InCure: 'The position is in a cure: no new borrowing or withdrawals until it clears.',
  WouldBreach: 'The withdrawal would leave the loan over its limit.',
};

const FADE_REASON: Record<string, string> = Object.fromEntries(
  ['ALLOWANCE', 'BALANCE', 'TRANSFER_FAILED'].map((n) => [keccak256(toHex(n)).slice(0, 10), n]),
);

// ---------------------------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------------------------

async function load(): Promise<State> {
  const depth = await getDepth(asset.wrapper);
  const borrower = wallet.account() ?? DEMO_IDS.borrowers[0] ?? AGENTIC_WALLET;
  const [position, regime] = await Promise.all([
    getCreditPosition(borrower, asset.wrapper).catch(() => null),
    getRegime({ wrapper: asset.wrapper }).catch(() => null),
  ]);
  return { depth, position, borrower, regime, horizon: await readHorizon(regime) };
}

// ---------------------------------------------------------------------------------------------
// draw
// ---------------------------------------------------------------------------------------------

const plot = mountLtvPlot($('[data-dp-svg]')!, $<HTMLInputElement>('[data-dp-range]')!, $('[data-dp-readout]')!, $('[data-dp-svg-text]'));

function asOf(x: { specimen: boolean; block: number | null }): string {
  return x.specimen ? 'Specimen' : x.block ? `block ${fmtBlock(x.block)}` : 'now';
}

function drawStatus(block: number | null): void {
  const el = $('[data-dp-status]');
  if (el) render(el, statusTagHTML(W4_LIVE && !isMock(), block));
}

function drawPlot(d: DepthView): void {
  plot.update(d.curve);
  const t = $('[data-dp-plot-title]');
  if (t) t.textContent = `${d.symbol}: loan-to-value against honoured depth`;
  const a = $('[data-dp-plot-asof]');
  if (a) a.textContent = d.specimen ? 'Specimen' : `as of ${asOf(d)}`;
  const now = $('[data-dp-ltv-now]');
  if (now) now.textContent = fmtPct(d.ltvBps);
}

function drawStats(d: DepthView, horizon: State['horizon']): void {
  const el = $('[data-dp-stats]');
  if (!el) return;
  const c = d.curve;
  const regimeWord = c.regime === 'UNKNOWN' ? 'clock stale' : c.regimeCapBps === 6000 ? 'Hong Kong open' : 'Hong Kong shut';
  const at = d.specimen ? undefined : asOf(d);
  render(
    el,
    html`${d.specimen ? html`<p class="dp-stats__tag"><span class="tag tag--specimen">Specimen · in build</span></p>` : ''}<div class="dp-stats__grid">
      ${statHTML({ label: 'ltvFor, now', value: fmtPct(d.ltvBps), asOf: at, size: 'data', note: `Per position; cap ${fmtPct(c.regimeCapBps, 0)}: ${regimeWord}` })}
      ${statHTML({ label: 'Honoured depth', value: `${fmtShares(d.honouredShares)} shares`, asOf: at, size: 'data', note: `${fmtUsdg(d.honouredNotional, 4)} of bids` })}
      ${statHTML({ label: 'Lowest bid counted', value: d.minBidPx !== null ? fmtUsdg(d.minBidPx) : 'none', asOf: at, size: 'data', note: c.priceNow !== null ? `Scorecard price $${c.priceNow.toFixed(2)} a share` : 'Scorecard price unreadable' })}
      ${statHTML({ label: 'Realisable', value: fmtUsdg(d.realisable, 4), asOf: at, size: 'data', note: 'What the bids would pay for the pooled collateral' })}
      ${statHTML({ label: 'Pooled collateral', value: `${fmtShares(c.totalCollateral)} shares`, asOf: at, size: 'data', note: 'totalCollateral, the basis of the LTV' })}
      ${statHTML({
        label: 'A cert must outlive',
        value: horizon ? hktShort(horizon.ms) : '—',
        asOf: horizon && !horizon.estimate ? at : undefined,
        size: 'data',
        note: `${horizon?.estimate ? 'Estimate from the published rule; ' : 'minCertExpiry: '}the next reopen plus a cure.${d.soonestExpiryMs ? ` Soonest counted expiry ${hktShort(d.soonestExpiryMs)}.` : ''}`,
      })}
    </div>`,
  );
}

function certCard(c: CertView | undefined, loaded = true): SafeHTML {
  if (!c) {
    const dash = '—';
    return certificateHTML({
      kind: 'cert', id: 0, title: 'Curb Depth Certificate', asset: asset.symbol, face: `${dash} shares at ${dash} USDG a share`,
      promise: loaded ? 'No cert is in this book yet. The first demo cert is posted by curb-desk after DepthCert is deployed.' : html`Firm until <strong>— — —, —:— HKT</strong>. If the maker can’t pay when it is hit, the bond goes to the trader in the same transaction.`,
      fields: ['Maker', 'Reserved for', 'Shares left', 'Notional left', 'Bond', 'Posted', 'Status', 'Maker can pay'].map((label) => ({ label, value: dash, ...(label === 'Bond' ? { note: 'At least 10% of the notional, rounded up' } : {}) })),
    });
  }
  // The demo plan's cert names CurbCredit; its specimen carries 0x0 only because CurbCredit has no address yet.
  const ben = c.beneficiary.toLowerCase() === ZERO
    ? c.specimen ? 'CurbCredit (demo plan; address in build)' : 'Anyone (an open cert)'
    : TEAM[c.beneficiary.toLowerCase()] ?? c.beneficiary;
  return certificateHTML({
    kind: 'cert',
    id: c.id,
    title: 'Curb Depth Certificate',
    asset: c.symbol,
    face: `${fmtShares(c.sizeShares)} shares at ${fmtUsdg(c.bidPx)} a share`,
    promise: html`Firm until <strong>${hktDate(c.expiryMs)}</strong>. If the maker can’t pay when it is hit, the ${fmtUsdg(c.bond)} bond goes to the trader in the same transaction.`,
    specimen: c.specimen,
    fields: [
      { label: 'Maker', value: whoHTML(c.maker, TEAM) },
      { label: 'Reserved for', value: ben },
      { label: 'Shares left', value: `${fmtShares(c.remainingShares)} of ${fmtShares(c.sizeShares)}` },
      { label: 'Notional left', value: fmtUsdg(c.notional, 4) },
      { label: 'Bond', value: fmtUsdg(c.bond, 4), note: 'At least 10% of the notional, rounded up' },
      { label: 'Posted', value: hktDate(c.postedAtMs) },
      { label: 'Status', value: c.status.toLowerCase() },
      { label: 'Maker can pay', value: c.makerHonourable === null ? 'unknown' : c.makerHonourable ? 'yes: balance and allowance cover every standing bid' : 'no: drops out of the honoured depth' },
    ],
  });
}

let stopTilt: (() => void) | null = null;

function drawBook(d: DepthView): void {
  const body = $('[data-dp-book]');
  const cap = $('[data-dp-book-cap]');
  const now = Date.now();
  if (cap) cap.textContent = `DepthCert book for ${d.symbol}${d.specimen ? ' · Specimen, in build' : `, as of ${asOf(d)}`}`;
  if (body) {
    render(
      body,
      d.certs.length
        ? html`${d.certs.map(
            (c) => html`<tr>
              <th scope="row" class="t-data">${c.id}</th>
              <td>${whoHTML(c.maker, TEAM)}</td>
              <td class="num">${fmtShares(c.remainingShares)} / ${fmtShares(c.sizeShares)}</td>
              <td class="num">${c.bidPx.toFixed(2)}</td>
              <td class="num">${c.bond.toFixed(4)}</td>
              <td>${hktShort(c.expiryMs, now)}</td>
              <td>${c.status === 'LIVE' && c.expiryMs <= now ? 'expired' : c.status.toLowerCase()}</td>
              <td>${c.makerHonourable === null ? '—' : c.makerHonourable ? 'yes' : 'no'}</td>
            </tr>`,
          )}`
        : html`<tr><td colspan="8" class="muted">No certs in this book yet.</td></tr>`,
    );
  }
  const h = $('[data-dp-honoured]');
  if (h) {
    h.textContent =
      d.honouredShares > 0
        ? `honouredDepth(${d.symbol}, CurbCredit, minCertExpiry):${fmtShares(d.honouredShares)} shares, ${fmtUsdg(d.honouredNotional, 4)} of bids, lowest bid ${fmtUsdg(d.minBidPx)}, soonest expiry ${d.soonestExpiryMs ? hktShort(d.soonestExpiryMs) : '—'}. ${d.specimen ? 'Specimen.' : `As of ${asOf(d)}.`}`
        : `honouredDepth(${d.symbol}, CurbCredit, minCertExpiry) is zero: nothing CurbCredit can count yet.`;
  }
  const slot = $('[data-dp-cert]');
  if (slot) {
    stopTilt?.();
    render(slot, certCard(d.certs.find((c) => c.status === 'LIVE') ?? d.certs[0]));
    const card = slot.querySelector<HTMLElement>('.crt');
    if (card) stopTilt = enableTilt(card, 6);
  }
}

function drawReasons(): void {
  const el = $('[data-dp-reasons]');
  if (!el) return;
  render(el, html`${REFUSAL_REASONS.map((r) => html`<div class="ledger__row"><dt><code>${r}()</code></dt><dd>${REASON_WORDS[r]}</dd></div>`)}`);
}

function drawRefusalExample(): void {
  const el = $('[data-dp-refusal]');
  if (!el) return;
  render(
    el,
    html`<figure class="dp-refusal__fig">
      <figcaption class="t-label">${W4_LIVE ? 'What a refused borrow looks like' : 'Specimen, from the demo plan'}</figcaption>
      <p class="dp-refusal__call"><code>borrow(wTCENTx, 1.40 USDG)</code> by the Agentic Wallet, holding 0.05 wTCENTx as collateral, before any cert is posted</p>
      <p class="dp-refusal__result"><span class="dp-refusal__ok">Confirmed</span> · <code>Refusal</code> <code>NoDepth()</code> · requested 1.40 USDG · allowed 0.00 USDG · nothing changed</p>
    </figure>`,
  );
}

function drawPosition(s: State): void {
  const el = $('[data-dp-position]');
  if (!el) return;
  const p = s.position;
  const you = wallet.account();
  const whose = you ? 'Your position' : 'Demo position';
  if (!p) {
    render(el, html`<div class="nt-window surface-ink"><div class="nt-window__head"><span class="nt-window__title">${whose}</span></div><p class="t-small muted">CurbCredit is unreadable just now.</p></div>`);
    return;
  }
  const breach = !p.breach.known ? 'unknown (clock stale or price unreadable)' : p.breach.breached ? 'over its limit' : 'within its limit';
  render(
    el,
    html`<div class="nt-window surface-ink dp-pos">
      <div class="nt-window__head"><span class="nt-window__title">${whose} · ${p.symbol}</span><span class="nt-window__asof">${asOf(p)}</span></div>
      <p class="t-small dp-pos__who">${whoHTML(p.borrower, TEAM)}</p>
      <dl class="dp-pos__grid">
        <div><dt>Collateral</dt><dd>${fmtShares(p.collateral)} shares</dd></div>
        <div><dt>Debt</dt><dd>${fmtUsdg(p.debt, 4)}</dd></div>
        <div><dt>Limit</dt><dd>${fmtUsdg(p.limit, 4)}</dd></div>
        <div><dt>LTV applied</dt><dd>${fmtPct(p.ltvBps)}</dd></div>
        <div class="dp-pos__wide"><dt>Position</dt><dd>${breach}${p.cure?.active ? ', cure running' : ''}</dd></div>
      </dl>
    </div>`,
  );
}

function drawCure(s: State): void {
  const cells = $('[data-dp-cure-cells]');
  const st = $('[data-dp-cure-state]');
  const legend = $('[data-dp-cure-legend]');
  const asofEl = $('[data-dp-cure-asof]');
  const cure = s.position?.cure ?? null;
  const r = s.regime;
  const open = !!r && !r.stale && r.regime !== 'UNKNOWN' && r.cap > 0;
  const used = cure ? Math.min(30, Math.floor(cure.openSecondsUsed / 60)) : 0;
  if (cells) {
    render(cells, html`${Array.from({ length: 30 }, (_, i) => html`<span class="dp-cure__cell${i < used ? ' is-used' : ''}"></span>`)}`);
  }
  if (asofEl) asofEl.textContent = s.position ? asOf(s.position) : '—';
  if (st) {
    st.textContent = !cure?.active
      ? 'No cure is running for this position.'
      : !r || r.stale || r.regime === 'UNKNOWN'
        ? 'Frozen: the clock is stale, and unwitnessed time never counts.'
        : open
          ? 'Running: the market is open, so each tick adds the witnessed open minutes since the last one.'
          : `Frozen: ${asset.symbol}’s market is shut, and shut time never counts.`;
    st.dataset.state = !cure?.active ? 'none' : open ? 'running' : 'frozen';
  }
  if (legend) {
    legend.textContent = cure?.active
      ? `${used} of 30 open minutes used.${cure.openedAtMs ? ` Flagged ${hktShort(cure.openedAtMs)}` : ''}${cure.priceAtBreach ? ` at $${cure.priceAtBreach.toFixed(2)} a share` : ''}.${cure.lastTickAtMs ? ` Last tick ${fmtAgo(cure.lastTickAtMs)}.` : ''} Liquidation needs all 30, an open market and a fresh price.`
      : 'Each cell is one witnessed open minute; liquidation needs all 30.';
  }
}

function drawProvenance(): void {
  const el = $('[data-dp-prov]');
  if (!el) return;
  const row = (dt: string, dd: SafeHTML | string) => html`<div class="ledger__row"><dt>${dt}</dt><dd>${dd}</dd></div>`;
  const addr = (a: Address | null) => (a ? addressLinkHTML(a) : html`<span class="muted">not deployed yet · in build</span>`);
  render(
    el,
    html`${row('DepthCert', addr(DEPTH_CERT))}
    ${row('CurbCredit', addr(CURB_CREDIT))}
    ${row('Eligibility registry', addr(ELIGIBILITY_REGISTRY))}
    ${row('MarketClock (open or shut)', addressLinkHTML(MARKET_CLOCK))}
    ${row('Scorecard (the price)', addressLinkHTML(SCORECARD))}
    ${row('USDG (6 dp)', addressLinkHTML(USDG))}
    ${row('Demo wallets', html`curb-desk ${addressLinkHTML(CURB_DESK)} posts bonds and funds the reserve · Agentic Wallet ${addressLinkHTML(AGENTIC_WALLET)} borrows and takes. Demo counterparties are team wallets.`)}
    ${row('Admin', 'DepthCert has none. CurbCredit’s admin manages the reserve and realises seized shares; it cannot change the LTV function, the caps or the cure clock.')}`,
  );
}

// ---------------------------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------------------------

const wallet = mountWalletBar($('[data-dp-wallet]')!, { live: W4_LIVE });
const btn = (k: string) => $<HTMLButtonElement>(`[data-dp-tx="${k}"]`)!;
const field = (k: string) => $<HTMLInputElement & HTMLSelectElement>(`[data-dp-in="${k}"]`)!;
const statusFor = (k: string) => $<HTMLElement>(`[data-dp-status-for="${k}"]`) ?? undefined;
const ALL_TX = ['approvePost', 'post', 'approveTake', 'take', 'approveDeposit', 'deposit', 'borrow', 'approveRepay', 'repay'];

function num(k: string, what: string): string {
  const v = field(k).value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) throw new Error(`Enter ${what} as a positive number.`);
  return v;
}
function me(): Address {
  const a = wallet.account();
  if (!a) throw new Error('Connect a wallet first.');
  return a;
}
function beneficiary(): Address {
  if (field('ben').value === 'open') return ZERO;
  if (!CURB_CREDIT) throw new Error('CurbCredit is not deployed yet.');
  return CURB_CREDIT;
}

function drawMinBond(): void {
  const el = $('[data-dp-minbond]');
  if (!el) return;
  try {
    const size = parseUnits(num('size', 'the shares'), 18);
    const bid = parseUnits(num('bid', 'the bid'), 6);
    const n = notional(size, bid);
    el.textContent = `Notional ${fmtUsdg(Number(n) / 1e6, 4)}; the minimum bond for these terms is ${fmtUsdg(Number(minBond(size, bid)) / 1e6, 4)}. Approve Bond + notional so the bid stays honoured.`;
  } catch {
    el.textContent = '';
  }
}

async function drawMakerEligibility(): Promise<void> {
  const el = $('[data-dp-maker]');
  if (!el) return;
  const a = wallet.account();
  if (!a || !LIVE.depth || isMock()) {
    el.textContent = '';
    return;
  }
  try {
    const pc = publicClient();
    const registry = (await pc.readContract({ address: DEPTH_CERT!, abi: depthCertAbi, functionName: 'makers' })) as Address;
    if (registry.toLowerCase() === ZERO) {
      el.textContent = 'This DepthCert is ungated: anyone may post.';
      return;
    }
    const ok = await pc.readContract({ address: registry, abi: eligibilityAbi, functionName: 'isEligible', args: [a] });
    el.textContent = ok
      ? 'Your address is an eligible maker.'
      : 'Your address is not on the registry, so a cert naming CurbCredit would revert with IneligibleMaker(); an open cert still works.';
  } catch {
    el.textContent = '';
  }
}

function takeOutcome(o: WriteOutcome): string | null {
  if (!DEPTH_CERT) return null;
  for (const log of o.receipt.logs) {
    if (log.address.toLowerCase() !== DEPTH_CERT.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: depthCertAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'Filled') {
        const a = ev.args as { paid: bigint; shares: bigint };
        return `Filled: the maker paid ${fmtUsdg(Number(a.paid) / 1e6, 4)} for ${fmtShares(Number(a.shares) / 1e18)} shares.`;
      }
      if (ev.eventName === 'Faded') {
        const a = ev.args as { bondSlashed: bigint; reason: Hex };
        return `Faded (${FADE_REASON[a.reason.toLowerCase()] ?? a.reason}): the maker could not pay, so the ${fmtUsdg(Number(a.bondSlashed) / 1e6, 4)} bond came to you and your shares came back.`;
      }
    } catch {
      /* another event */
    }
  }
  return null;
}

function wireActions(): void {
  const sel = $<HTMLSelectElement>('[data-dp-asset]')!;
  render(sel, html`${CHOICES.map((a) => html`<option value="${a.wrapper}">${a.symbol}</option>`)}`);
  sel.disabled = CHOICES.length < 2;
  sel.addEventListener('change', () => {
    asset = CHOICES.find((a) => a.wrapper === sel.value) ?? CHOICES[0]!;
    void refresh();
  });

  ['size', 'bid'].forEach((k) => field(k).addEventListener('input', drawMinBond));
  drawMinBond();

  const append = (s: HTMLElement, text: string) => s.insertAdjacentHTML('beforeend', html` · ${text}`.value);

  txAction(
    btn('approvePost'),
    () => {
      const size = parseUnits(num('size', 'the shares'), 18);
      const bid = parseUnits(num('bid', 'the bid'), 6);
      return approveUsdg('depth', parseUnits(num('bond', 'the bond'), 6) + notional(size, bid));
    },
    { status: statusFor('post') },
  );
  txAction(
    btn('post'),
    () =>
      postCert({
        wrapper: asset.wrapper,
        beneficiary: beneficiary(),
        sizeShares: parseUnits(num('size', 'the shares'), 18),
        bidPx: parseUnits(num('bid', 'the bid'), 6),
        expiry: Math.floor(Date.now() / 1000 + Number(num('hours', 'the hours')) * 3600),
        bond: parseUnits(num('bond', 'the bond'), 6),
      }),
    {
      status: statusFor('post'),
      after: (o, s) => {
        const id = (o as WriteOutcome & { certId?: bigint | null }).certId;
        if (id) append(s, `cert #${String(id)} posted; watch the LTV move`);
        void refresh();
      },
    },
  );
  txAction(btn('approveTake'), () => approveWrapper(asset.wrapper, 'depth', parseUnits(num('takeShares', 'the shares'), 18)), { status: statusFor('take') });
  txAction(btn('take'), () => takeCert(BigInt(num('certId', 'the cert id')), parseUnits(num('takeShares', 'the shares'), 18), me()), {
    status: statusFor('take'),
    after: (o, s) => {
      const t = takeOutcome(o);
      if (t) append(s, t);
      void refresh();
    },
  });
  txAction(btn('approveDeposit'), () => approveWrapper(asset.wrapper, 'credit', parseUnits(num('deposit', 'the shares'), 18)), { status: statusFor('deposit') });
  txAction(btn('deposit'), () => deposit(asset.wrapper, parseUnits(num('deposit', 'the shares'), 18)), { status: statusFor('deposit'), after: () => void refresh() });
  txAction(btn('borrow'), () => borrow(asset.wrapper, parseUnits(num('borrow', 'the amount'), 6)), {
    status: statusFor('borrow'),
    after: (o, s) => {
      const r = refusalsIn(o)[0];
      if (r) {
        s.insertAdjacentHTML(
          'beforeend',
          html`<span class="dp-refused"> · Refused: <code>${r.reason}()</code> · requested ${fmtUsdg(Number(r.requested) / 1e6)} · allowed ${fmtUsdg(Number(r.allowed) / 1e6)} · nothing changed</span>`.value,
        );
      } else append(s, 'borrowed');
      void refresh();
    },
  });
  txAction(btn('approveRepay'), () => approveUsdg('credit', parseUnits(num('repay', 'the amount'), 6)), { status: statusFor('repay') });
  txAction(btn('repay'), () => repay(me(), asset.wrapper, parseUnits(num('repay', 'the amount'), 6)), { status: statusFor('repay'), after: () => void refresh() });

  wallet.onChange(() => {
    applyGate();
    void drawMakerEligibility();
    void refresh();
  });
  applyGate();
}

function applyGate(): void {
  const reason = !W4_LIVE
    ? 'In build: DepthCert and CurbCredit are not deployed yet, so every step below is shown but closed. They open by themselves once the addresses are published.'
    : !wallet.account()
      ? 'Connect a wallet to send. Each step is simulated before your wallet is asked to sign; a step that would revert says why and sends nothing.'
      : null;
  gate(ALL_TX.map(btn), $('[data-dp-gate]'), reason);
}

function fillDefaults(s: State): void {
  const c = s.depth.certs.find((x) => x.status === 'LIVE' && x.beneficiary.toLowerCase() === ZERO) ?? s.depth.certs[0];
  if (c && !field('certId').value) field('certId').value = c.id;
  if (c && !field('takeShares').value) field('takeShares').value = String(c.remainingShares);
}

// ---------------------------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------------------------

async function refresh(): Promise<void> {
  try {
    state = await load();
  } catch (e) {
    console.warn('depth: read failed', e);
    return;
  }
  drawStatus(state.depth.block);
  drawPlot(state.depth);
  drawStats(state.depth, state.horizon);
  drawBook(state.depth);
  drawPosition(state);
  drawCure(state);
  fillDefaults(state);
}

render($('[data-dp-cert]')!, certCard(undefined, false)); // first paint: the same card with dashes
drawReasons();
drawRefusalExample();
drawProvenance();
wireActions();
void refresh();

if (W4_LIVE && !isMock()) {
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 30_000);
}

