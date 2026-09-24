// A mock X Layer for Playwright: answers eth_call (plain and via Multicall3.aggregate3) by decoding the
// calldata against the real forge ABIs and encoding either an override or a zero value of the output
// types. Nothing leaves the machine.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function makeChain(repo, opts = {}) {
  const viem = await import(join(repo, 'web/node_modules/viem/_esm/index.js'));
  const { decodeFunctionData, encodeFunctionResult, encodeAbiParameters, toFunctionSelector, keccak256, toHex, pad } = viem;
  const art = (n) => JSON.parse(readFileSync(join(repo, `out/${n}.sol/${n}.json`), 'utf8')).abi;
  const now = Math.floor(Date.now() / 1000);
  const A = (s) => `0x${'0'.repeat(38)}${s}`;
  const W = '0x41333df9e7639188bbfca5522dc4844398af9f9e';
  const DESK = '0xe1df35af172e41d5a387d7e1b54a5ab18b539a3e';
  const AGENTIC = '0x055ba8acd60a2287b2d01cb3bf237e4424357105';
  const contracts = {
    [A('a1')]: { name: 'ReopenNote', abi: art('ReopenNote') },
    [A('a2')]: { name: 'ReopenPointer', abi: art('ReopenPointer') },
    [A('a3')]: { name: 'ClosedAuction', abi: art('ClosedAuction') },
    [A('a4')]: { name: 'DepthCert', abi: art('DepthCert') },
    [A('a5')]: { name: 'CurbCredit', abi: art('CurbCredit') },
    [A('a6')]: { name: 'EligibilityRegistry', abi: art('EligibilityRegistry') },
    '0x160dc415902971a7a9b5ade7f43005b36fe5b09b': { name: 'MarketClock', abi: art('MarketClock') },
    '0x3b4076c364abdae93e6419ceadeee8cb283bef1f': { name: 'Scorecard', abi: art('Scorecard') },
  };
  const E18 = 10n ** 18n;
  const lot = {
    seller: DESK, wrapper: W, noteId: 1n, amount: E18 / 10n, startPrice: 5_600_000n, floorPrice: 5_430_000n, refPrice: 5_587_261n,
    startAt: BigInt(now - 420), endAt: BigInt(now + 3000), decaySeconds: 1200, epochAtMint: 0, status: opts.lotStatus ?? 1,
    buyer: opts.lotStatus === 2 ? AGENTIC : '0x0000000000000000000000000000000000000000', clearedPrice: opts.lotStatus === 2 ? 5_500_000n : 0n,
    clearedAt: opts.lotStatus === 2 ? BigInt(now - 60) : 0n, cutoff: BigInt(now + 3000),
  };
  const cert = {
    maker: DESK, wrapper: W, beneficiary: A('a5'), sizeShares: 3n * E18 / 100n, remainingShares: 3n * E18 / 100n, bidPx: 52_000_000n,
    bond: 1_000_000n, postedAt: BigInt(now - 7200), expiry: BigInt(now + 80 * 3600), status: 1,
  };
  const overrides = {
    'ReopenNote.noteCount': () => 1n,
    'ReopenNote.unitOf': () => ({ wrapper: W, issuer: DESK, wrapperShares: E18 / 10n, underlyingAtMint: E18 / 10n, multiplierNonce: 0, epochAtMint: 0, mintedAt: BigInt(now - 3600), mintedBlock: 71_499_000n }),
    'ReopenNote.outstanding': () => E18 / 10n,
    'ReopenNote.capShares': () => 175n * E18,
    'ReopenNote.mintedInEpoch': () => E18 / 10n,
    'ReopenPointer.headOf': () => ({ epoch: 0, open: false, lastShutAt: BigInt(now - 600), lastObservedAt: BigInt(now - 600) }),
    'ClosedAuction.lotCount': () => 1n,
    'ClosedAuction.lotOf': () => lot,
    'ClosedAuction.currentPrice': () => 5_540_000n,
    'ClosedAuction.realisedDiscountBps': () => { if (opts.lotStatus === 2) return 123n; throw new Error('revert NotPrinted'); },
    'Scorecard.priceNow': () => 55_870_000_000_000_000_000n,
    'MarketClock.regime': () => 1,
    'MarketClock.stateOf': () => ({ regime: 1, primaryCapUsd: 0n, nextTransitionAt: BigInt(now + 3000), observedAt: BigInt(now - 60), multiplierNonce: 0, halted: false }),
    'DepthCert.bookOf': () => [1n],
    'DepthCert.certOf': () => cert,
    'DepthCert.isHonourable': () => true,
    'DepthCert.makers': () => A('a6'),
    'DepthCert.honouredDepth': () => [3n * E18 / 100n, 1_560_000n, 52_000_000n, BigInt(now + 80 * 3600)],
    'CurbCredit.ltvFor': () => 3000n,
    'CurbCredit.ltvEffective': () => 2800n,
    'CurbCredit.realisable': () => 1_560_000n,
    'CurbCredit.totalCollateral': () => 5n * E18 / 100n,
    'CurbCredit.minCertExpiry': () => BigInt(now + 73 * 3600 + 1800),
    'CurbCredit.positionOf': () => ({ collateral: 5n * E18 / 100n, principal: 1_400_000n, accrued: 0n, lastAccrual: BigInt(now - 3600) }),
    'CurbCredit.debtOf': () => 1_400_010n,
    'CurbCredit.limitOf': () => 838_089n,
    'CurbCredit.isBreached': () => [true, true],
    'CurbCredit.cureOf': () => ({ active: true, lastOpen: false, openedAt: BigInt(now - 1800), lastTickAt: BigInt(now - 900), openSecondsUsed: 720n, priceAtBreach: 55_870_000_000_000_000_000n }),
    'EligibilityRegistry.isEligible': () => true,
    ...(opts.overrides ?? {}),
  };
  const zero = (p) => {
    if (p.type.endsWith(']')) return [];
    if (p.type === 'tuple') return Object.fromEntries(p.components.map((c) => [c.name, zero(c)]));
    if (p.type === 'bool') return false;
    if (p.type === 'address') return '0x0000000000000000000000000000000000000000';
    if (p.type.startsWith('bytes')) return p.type === 'bytes' ? '0x' : pad('0x', { size: Number(p.type.slice(5)) });
    if (p.type === 'string') return '';
    return p.type.startsWith('uint') && Number(p.type.slice(4) || 256) <= 48 ? 0 : 0n;
  };
  const calls = [];
  function call(to, data) {
    const c = contracts[String(to).toLowerCase()];
    if (!c) return { ok: false, data: '0x' };
    let d;
    try {
      d = decodeFunctionData({ abi: c.abi, data });
    } catch {
      return { ok: false, data: '0x' };
    }
    const key = `${c.name}.${d.functionName}`;
    calls.push(key);
    const fn = c.abi.find((e) => e.type === 'function' && e.name === d.functionName);
    try {
      let result;
      if (overrides[key]) result = overrides[key](d.args);
      else {
        const outs = fn.outputs.map(zero);
        result = outs.length === 1 ? outs[0] : outs;
      }
      if (fn.outputs.length === 0) return { ok: true, data: '0x' };
      return { ok: true, data: encodeFunctionResult({ abi: c.abi, functionName: d.functionName, result }) };
    } catch (e) {
      return { ok: false, data: '0x', err: String(e.message).slice(0, 80) };
    }
  }
  const agg3 = toFunctionSelector('aggregate3((address,bool,bytes)[])');
  const block = () => ({
    number: '0x4430001', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), timestamp: '0x' + now.toString(16),
    nonce: '0x0000000000000000', sha3Uncles: '0x' + '0'.repeat(64), logsBloom: '0x' + '0'.repeat(512), transactionsRoot: '0x' + '0'.repeat(64),
    stateRoot: '0x' + '0'.repeat(64), receiptsRoot: '0x' + '0'.repeat(64), miner: '0x' + '0'.repeat(40), difficulty: '0x0', totalDifficulty: '0x0',
    extraData: '0x', size: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', transactions: [], uncles: [],
  });
  function answer(req) {
    const { id, method, params } = req;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
    switch (method) {
      case 'eth_chainId': return ok('0xc4');
      case 'eth_blockNumber': return ok('0x4430001');
      case 'eth_getBlockByNumber': return ok(block());
      case 'eth_getTransactionReceipt': return ok({
        transactionHash: params[0], transactionIndex: '0x0', blockHash: '0x' + '11'.repeat(32), blockNumber: '0x4430001', from: AGENTIC,
        to: A('a1'), cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, logs: [],
        logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x2',
      });
      case 'eth_call': {
        const { to, data } = params[0];
        if (String(to).toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11' && data.startsWith(agg3)) {
          const { args } = decodeFunctionData({ abi: [{ type: 'function', name: 'aggregate3', inputs: [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }], outputs: [] }], data });
          const res = args[0].map((c) => {
            const r = call(c.target, c.callData);
            return { success: r.ok, returnData: r.data };
          });
          return ok(encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }], [res]));
        }
        const r = call(to, data);
        return r.ok ? ok(r.data) : err(3, 'execution reverted', '0x');
      }
      default: return err(-32601, `mock: ${method}`);
    }
  }
  return { answer, calls, keccak256, toHex };
}
