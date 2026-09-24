// Write paths against a mocked EIP-6963 wallet and a mocked RPC. Nothing leaves the machine:
// every rpc.xlayer.tech / xlayer.drpc.org request is answered by page.route, and the "wallet" only
// records what it was asked to sign.
// usage: node wallet-test.mjs <baseUrl> <outDir> <webDir>
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
const root = execSync('npm root -g').toString().trim();
const { chromium } = createRequire(join(root, 'noop.js'))('@playwright/test');
const [base, outDir, webDir] = process.argv.slice(2);
const viem = await import(join(webDir, 'node_modules/viem/_esm/index.js'));
const { toFunctionSelector, keccak256, toHex, pad, encodeAbiParameters } = viem;
mkdirSync(outDir, { recursive: true });

const A = { note: 'a1', pointer: 'a2', auction: 'a3', depth: 'a4', credit: 'a5', registry: 'a6' };
const addr = (s) => `0x${'0'.repeat(38)}${s}`;
const ACCOUNT = '0x055ba8acd60a2287b2d01cb3bf237e4424357105';
const SUFFIX = '6464377535306e636b74356537323966100080218021802180218021802180218021';
const SEL = {
  observe: toFunctionSelector('observe(address)'),
  mint: toFunctionSelector('mint(address,uint128,address)'),
  borrow: toFunctionSelector('borrow(address,uint256)'),
  marketNotClosed: toFunctionSelector('MarketNotClosed()'),
  noDepth: toFunctionSelector('NoDepth()'),
};
const REFUSAL_TOPIC = keccak256(toHex('Refusal(address,address,bytes4,uint256,uint256)'));

function receipt(hash) {
  const logs = [];
  if (hash.endsWith(A.credit)) {
    logs.push({
      address: addr(A.credit),
      topics: [REFUSAL_TOPIC, pad(ACCOUNT), pad('0x41333df9e7639188bbfca5522dc4844398af9f9e'), pad(SEL.noDepth, { dir: 'right' })],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1_400_000n, 0n]),
      blockNumber: '0x4430001', transactionHash: hash, transactionIndex: '0x0', blockHash: '0x' + '11'.repeat(32), logIndex: '0x0', removed: false,
    });
  }
  return {
    transactionHash: hash, transactionIndex: '0x0', blockHash: '0x' + '11'.repeat(32), blockNumber: '0x4430001',
    from: ACCOUNT, to: addr(hash.slice(-2)), cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1',
    contractAddress: null, logs, logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x2',
  };
}

function answer(req) {
  const { id, method, params } = req;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
  switch (method) {
    case 'eth_chainId': return ok('0xc4');
    case 'eth_blockNumber': return ok('0x4430001');
    case 'eth_getTransactionReceipt': return ok(receipt(params[0]));
    case 'eth_call': {
      const { to = '', data = '' } = params[0] ?? {};
      const t = to.toLowerCase();
      if (t === addr(A.pointer) && data.startsWith(SEL.observe)) return ok('0x' + '0'.repeat(128));
      if (t === addr(A.note) && data.startsWith(SEL.mint)) return err(3, 'execution reverted', SEL.marketNotClosed);
      if (t === addr(A.credit) && data.startsWith(SEL.borrow)) return ok('0x' + '0'.repeat(64));
      return err(-32000, 'execution reverted');
    }
    default: return err(-32601, `mock: ${method} not served`);
  }
}

const browser = await chromium.launch();
const results = [];
async function session(path, run) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.route(/https:\/\/(rpc\.xlayer\.tech|xlayer\.drpc\.org).*/, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  await ctx.route(/https:\/\/api\.curb\.markets.*/, (route) => route.fulfill({ status: 503, body: '{}' }));
  await ctx.addInitScript(({ ACCOUNT }) => {
    window.__sent = [];
    let n = 0;
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ACCOUNT];
        if (method === 'eth_chainId') return '0xc4';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_sendTransaction') {
          window.__sent.push(params[0]);
          n++;
          return '0x' + String(n).padStart(2, '0') + 'ab'.repeat(30) + params[0].to.slice(-2);
        }
        return null;
      },
      on() {},
      removeListener() {},
    };
    const icon = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" fill="black"/></svg>');
    const announce = () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'other-1', name: 'Another Wallet', icon, rdns: 'io.other' }, provider }) }));
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'okx-1', name: 'OKX Wallet', icon, rdns: 'com.okex.wallet' }, provider }) }));
    };
    window.addEventListener('eip6963:requestProvider', announce);
  }, { ACCOUNT });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await run(page);
  const sent = await page.evaluate(() => window.__sent);
  results.push({ path, errors, sent: sent.map((s) => ({ to: s.to, suffixed: String(s.data).endsWith(SUFFIX), data: String(s.data).slice(0, 10) })) });
  await ctx.close();
}

async function connect(page, walletSel) {
  await page.locator(`${walletSel} [data-wallet-connect]`).click();
  const names = await page.locator('dialog[open] .nt-dialog__name').allTextContents();
  console.log('  wallets listed:', names.join(' | '));
  await page.locator('dialog[open]').screenshot({ path: join(outDir, `wallet-picker.png`) });
  await page.locator('dialog[open] .nt-dialog__wallet').first().click();
  await page.waitForTimeout(300);
  console.log('  bar:', (await page.locator(walletSel).innerText()).replace(/\s+/g, ' '));
}

await session('/notes', async (page) => {
  await connect(page, '[data-nt-wallet]');
  const obs = page.locator('[data-nt-tx="observe"]');
  await obs.scrollIntoViewIfNeeded();
  await obs.click();
  await page.waitForFunction(() => document.querySelector('[data-nt-tx="observe"]')?.dataset.state !== 'pending', null, { timeout: 15000 });
  await page.waitForTimeout(900);
  console.log('  observe status:', (await page.locator('[data-nt-status-for="redeem"]').innerText()).trim());
  await page.locator('[data-nt-tx="observe"]').locator('xpath=ancestor::li').screenshot({ path: join(outDir, 'notes-tx-confirmed.png') });
  const mint = page.locator('[data-nt-tx="mint"]');
  await mint.scrollIntoViewIfNeeded();
  await mint.click();
  await page.waitForTimeout(1500);
  console.log('  mint status:', (await page.locator('[data-nt-status-for="mint"]').innerText()).trim());
  await mint.locator('xpath=ancestor::li').screenshot({ path: join(outDir, 'notes-tx-reverted.png') });
});

await session('/depth', async (page) => {
  await connect(page, '[data-dp-wallet]');
  const b = page.locator('[data-dp-tx="borrow"]');
  await b.scrollIntoViewIfNeeded();
  await b.click();
  await page.waitForFunction(() => document.querySelector('[data-dp-tx="borrow"]')?.dataset.state !== 'pending', null, { timeout: 15000 });
  await page.waitForTimeout(900);
  console.log('  borrow status:', (await page.locator('[data-dp-status-for="borrow"]').innerText()).trim());
  await b.locator('xpath=ancestor::li').screenshot({ path: join(outDir, 'depth-refusal-confirmed.png') });
});

for (const r of results) {
  console.log(r.path, 'sent:', JSON.stringify(r.sent), 'errors:', r.errors.length);
  for (const e of r.errors) console.log('   err:', e.slice(0, 160));
}
await browser.close();
