/**
 * The home page's record line ("N graded. No wins, N ties.") without viem: Scorecard.skill() and
 * closureCount() via rpc-lite, falling back to the free preview of GET /v1/accuracy-record (the 402 body)
 * only if both RPCs fail. Chain first; the API is the fallback, never the source.
 */
import { askWithoutPaying } from "./api.ts";
import { fixture, isMock } from "./mock.ts";
import { readSkill } from "./rpc-lite.ts";
import type { RecordLine, RecordPreview } from "./types.ts";

export async function getRecord(signal?: AbortSignal): Promise<RecordLine> {
  if (isMock()) {
    const s = (await fixture("scorecard")).skill;
    return { settled: s.settled, beatLastPrint: s.beatLastPrint, beatClosingVwap: s.beatClosingVwap, closureCount: s.closureCount, block: s.block, readAtMs: s.readAtMs, source: "fixture" };
  }
  try {
    const r = await readSkill(signal);
    return { ...r, readAtMs: Date.now(), source: "chain" };
  } catch (chainErr) {
    const u = await askWithoutPaying<RecordPreview>("/v1/accuracy-record", {}, signal);
    if (!u.preview?.skill) throw chainErr;
    return { ...u.preview.skill, closureCount: u.preview.rowCount ?? null, block: null, readAtMs: u.readAtMs, source: "api" };
  }
}
