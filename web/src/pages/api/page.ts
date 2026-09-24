// /api: get an agent to its first call. Prices come from /.well-known/x402; "Ask without paying" makes a
// plain unpaid GET, decodes the PAYMENT-REQUIRED header and shows the free preview (data/api.ts).
// No viem on this page: everything here is api.curb.markets.
import { boot } from '../../shell/boot';
import './page.css';

import { askWithoutPaying, formatUsd6, getAssets, getHealth, getX402 } from '../../data/api';
import { isMock } from '../../data/mock';
import type { ApiRoute, PaymentAccept, UnpaidCall } from '../../data/types';
import { fmtHKT } from '../../shell/hkt';
import { copyButton, enhanceCopyButtons } from '../../ui/copy';
import { fmtAgo, fmtInt, shortAddress } from '../../ui/format';
import { html, render, type SafeHTML } from '../../ui/html';
import { prefersReducedMotion } from '../../motion/reduced';

boot({ page: 'api' });

const main = document.getElementById('main')!;
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = main) => root.querySelector<T>(sel);

const NETWORK_NAME: Record<string, string> = { 'eip155:196': 'X Layer' };
const KNOWN_PAYTO: Record<string, string> = { '0x277ca91276a3801667b76c97da3872ccb6e96068': 'curb-revenue' };

// ── copy buttons ───────────────────────────────────────────────────────────────────────────────

enhanceCopyButtons(main);
main.querySelectorAll<HTMLButtonElement>('button[data-copy-cmd]').forEach((b) => {
  copyButton(b, () => $(`[data-cmd="${b.dataset.copyCmd}"]`)?.textContent ?? '');
});

// ── the service line ───────────────────────────────────────────────────────────────────────────

async function loadHealth(): Promise<void> {
  const el = $('[data-api-health]');
  if (!el) return;
  try {
    const h = await getHealth();
    const now = isMock() ? h.lastTickOkMs : Date.now();
    const state = h.ok ? 'Up' : 'Degraded';
    const pay = h.payments.ready ? 'payments ready' : 'payments not ready';
    el.textContent = `${state} · ${pay} · last tick ${fmtAgo(h.lastTickOkMs, now)} (${fmtHKT(h.lastTickOkMs)} HKT)`;
  } catch {
    el.textContent = 'Unreachable just now.';
  }
}

async function loadAssets(): Promise<void> {
  const el = $('[data-api-assets]');
  if (!el) return;
  try {
    const a = await getAssets();
    const graded = a.assets.filter((x) => x.hasPriceSource).length;
    el.textContent = `Now: ${fmtInt(a.assets.length)} assets, ${fmtInt(graded)} with a Scorecard price source (as of ${fmtHKT(a.asOfMs)} HKT).`;
  } catch {
    el.textContent = '';
  }
}

// ── priced routes ──────────────────────────────────────────────────────────────────────────────

let routes: ApiRoute[] = [];

function routeHTML(r: ApiRoute, i: number): SafeHTML {
  const price = r.price || formatUsd6(r.amount);
  return html`<li class="api-route" data-route="${r.path}">
  <div class="api-route__main">
    <p class="api-route__path t-data"><span class="api-route__method">${r.method}</span> ${r.path}</p>
    <p class="api-route__price t-h2">${price}<span class="api-route__per t-small muted"> a call</span></p>
    <p class="api-route__summary">${r.summary}</p>
    <p class="api-route__query t-small muted"><span class="api-route__qk">Query</span> ${r.query || 'none'}</p>
    <details class="api-route__more">
      <summary class="t-small">What it returns</summary>
      <p class="t-small muted">${r.description}</p>
    </details>
  </div>
  <div class="api-route__try">
    <button type="button" class="btn btn--secondary api-ask" data-ask="${r.path}" aria-controls="api-console-${i}" aria-expanded="false"><span class="btn__label">Ask without paying</span></button>
    <p class="visually-hidden" role="status" data-ask-status="${r.path}"></p>
  </div>
  <div class="api-console surface-ink" id="api-console-${i}" data-console="${r.path}" hidden></div>
</li>`;
}

async function loadRoutes(): Promise<void> {
  const list = $('[data-api-routes]');
  const asof = $('[data-api-x402-asof]');
  if (!list) return;
  try {
    const d = await getX402();
    routes = d.routes;
    render(list, html`${routes.map(routeHTML)}`);
    if (asof) asof.textContent = `${isMock() ? 'Fixture of' : 'Read from'} /.well-known/x402 · x402 version ${d.x402Version} · ${fmtInt(routes.length)} priced routes${isMock() ? '' : ` · ${fmtHKT(Date.now(), true)} HKT`}`;
  } catch {
    if (asof) asof.textContent = 'Could not read /.well-known/x402 just now. The routes are listed at api.curb.markets.';
  }
}

// ── ask without paying: 402 → decoded challenge → preview ─────────────────────────────────────

function acceptRows(a: PaymentAccept): [string, SafeHTML | string][] {
  const net = NETWORK_NAME[a.network];
  const name = typeof a.extra?.name === 'string' ? a.extra.name : 'token';
  const payee = KNOWN_PAYTO[a.payTo.toLowerCase()];
  return [
    ['scheme', a.scheme],
    ['network', net ? `${a.network} · ${net}` : a.network],
    ['amount', `${a.amount} · ${formatUsd6(a.amount)} ${name}`],
    ['asset', html`<span title="${a.asset}">${shortAddress(a.asset)}</span> · ${name}`],
    ['payTo', html`<span title="${a.payTo}">${shortAddress(a.payTo)}</span>${payee ? ` · ${payee}` : ''}`],
    ['maxTimeoutSeconds', String(a.maxTimeoutSeconds)],
  ];
}

function consoleHTML(path: string, u: UnpaidCall): SafeHTML {
  const pr = u.paymentRequired;
  const first = pr?.accepts?.[0];
  const statusWord = u.status === 402 ? 'Payment required' : u.status === 200 ? 'OK' : 'Unexpected';
  const preview = u.preview ? JSON.stringify(u.preview, null, 2) : '(no body)';
  return html`<div class="api-step" style="--i:0"><span class="api-step__k">request</span><code>GET ${path}</code></div>
<div class="api-step api-step--status" style="--i:1"><span class="api-step__k">response</span><code><span class="api-402">HTTP ${u.status}</span> ${statusWord}</code></div>
${pr
  ? html`<div class="api-step" style="--i:2"><span class="api-step__k">PAYMENT-REQUIRED</span><span class="api-step__note">base64 header, decoded: x402 v${pr.x402Version}</span>
  ${first ? html`<dl class="api-kv">${acceptRows(first).map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>` : ''}</div>`
  : html`<div class="api-step" style="--i:2"><span class="api-step__k">PAYMENT-REQUIRED</span><span class="api-step__note">no challenge header on this response</span></div>`}
<div class="api-step" style="--i:3"><span class="api-step__k">preview</span><span class="api-step__note">the free part of the body${isMock() ? ' (fixture)' : `, read ${fmtHKT(u.readAtMs, true)} HKT`}</span>
<pre class="api-json" tabindex="0" aria-label="Preview body"><code>${preview}</code></pre></div>`;
}

const inFlight = new Set<string>();

main.addEventListener('click', async (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>('button[data-ask]');
  if (!btn) return;
  const path = btn.dataset.ask!;
  if (inFlight.has(path)) return;
  const con = $<HTMLElement>(`[data-console="${path}"]`);
  const status = $<HTMLElement>(`[data-ask-status="${path}"]`);
  if (!con) return;
  inFlight.add(path);
  btn.setAttribute('aria-busy', 'true');
  con.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  render(con, html`<div class="api-step api-step--wait"><span class="api-step__k">request</span><code>GET ${path}</code><span class="api-step__note">waiting for api.curb.markets…</span></div>`);
  try {
    const u = await askWithoutPaying(path);
    con.classList.toggle('api-console--animate', !prefersReducedMotion());
    render(con, consoleHTML(path, u));
    const a = u.paymentRequired?.accepts?.[0];
    if (status) {
      status.textContent = a
        ? `HTTP ${u.status}: ${formatUsd6(a.amount)} to pay. Preview shown below.`
        : `HTTP ${u.status}. Preview shown below.`;
    }
    const label = btn.querySelector('.btn__label');
    if (label) label.textContent = 'Ask again';
  } catch {
    render(con, html`<div class="api-step"><span class="api-step__k">request</span><code>GET ${path}</code><span class="api-step__note">Could not reach api.curb.markets just now. Try again.</span></div>`);
    if (status) status.textContent = 'Could not reach api.curb.markets just now.';
  } finally {
    inFlight.delete(path);
    btn.removeAttribute('aria-busy');
  }
});

void loadRoutes();
void loadHealth();
void loadAssets();
