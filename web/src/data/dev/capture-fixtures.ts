/**
 * Refresh fixtures/*.json from mainnet and api.curb.markets through the real readers, so `?mock=1`
 * serves exactly the shapes the live pages get. Read-only; rate-limited by chain.ts.
 *
 *   node --experimental-strip-types web/src/data/dev/capture-fixtures.ts
 *
 * W3/W4 fixtures (notes, lots, pointer, certs, credit, depth) are specimens built from live prices until
 * those contracts are deployed; every one carries `specimen: true`.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setMock } from "../mock.ts";
import { getRegime } from "../regime.ts";
import { getBoard } from "../clock.ts";
import { getScorecard } from "../scorecard.ts";
import { askWithoutPaying, getAssets, getHealth, getX402, PRICED_ROUTES } from "../api.ts";
import { specimenFixtures } from "./specimens.ts";

setMock(false);
const dir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const save = (name: string, v: unknown) => {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(v, null, 2) + "\n");
  console.log(`fixtures/${name}.json`);
};

const regime = await getRegime();
save("regime", { ...regime, source: "fixture" });
const board = await getBoard();
save("board", { ...board, source: "fixture" });
const scorecard = await getScorecard({ resolveTx: true });
save("scorecard", { ...scorecard, source: "fixture" });
save("x402", await getX402());
save("health", await getHealth());
save("assets", await getAssets());
const unpaid: Record<string, unknown> = {};
for (const p of PRICED_ROUTES) unpaid[p] = { ...(await askWithoutPaying(p)), source: "fixture" };
save("unpaid", unpaid);

const sp = specimenFixtures({ nowMs: Date.now(), prices: scorecard.prices, block: scorecard.block, regime: board.rows });
for (const [k, v] of Object.entries(sp)) save(k, v);
