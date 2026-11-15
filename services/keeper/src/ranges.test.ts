import { test } from "node:test";
import assert from "node:assert/strict";
import { addRange, subtractRange, subtractBlocks, gapsWithin, inRanges, normalizeRanges, blockCount } from "./ranges.ts";
import type { Range } from "./ranges.ts";

test("range arithmetic", () => {
  assert.deepEqual(addRange([[1, 5]], 6, 9), [[1, 9]]);
  assert.deepEqual(addRange([[1, 5], [10, 12]], 4, 11), [[1, 12]]);
  assert.deepEqual(subtractRange([[1, 9]], 4, 5), [[1, 3], [6, 9]]);
  assert.deepEqual(subtractBlocks([[1, 10]], [3, 7]), [[1, 2], [4, 6], [8, 10]]);
  assert.deepEqual(gapsWithin([[3, 5], [8, 9]], 1, 10), [[1, 2], [6, 7], [10, 10]]);
  assert.equal(inRanges([[3, 5]], 5), true);
  assert.equal(inRanges([[3, 5]], 6), false);
});

test("addRange keeps the list sorted, disjoint and merged, and never mutates its input", () => {
  const r: Range[] = [[10, 20], [30, 40]];
  assert.deepEqual(addRange(r, 1, 3), [[1, 3], [10, 20], [30, 40]]);
  assert.deepEqual(addRange(r, 21, 29), [[10, 40]], "adjacent on both sides");
  assert.deepEqual(addRange(r, 50, 50), [[10, 20], [30, 40], [50, 50]]);
  assert.deepEqual(addRange(r, 15, 35), [[10, 40]]);
  assert.deepEqual(addRange(r, 5, 4), [[10, 20], [30, 40]], "an empty range adds nothing");
  assert.deepEqual(addRange([], 7, 7), [[7, 7]]);
  assert.deepEqual(r, [[10, 20], [30, 40]], "input untouched");
});

test("subtractRange and subtractBlocks cut only what is asked", () => {
  assert.deepEqual(subtractRange([[1, 9]], 1, 9), []);
  assert.deepEqual(subtractRange([[1, 9]], 0, 100), []);
  assert.deepEqual(subtractRange([[1, 9], [20, 30]], 5, 25), [[1, 4], [26, 30]]);
  assert.deepEqual(subtractRange([[1, 9]], 10, 20), [[1, 9]]);
  assert.deepEqual(subtractRange([[1, 9]], 9, 9), [[1, 8]]);
  assert.deepEqual(subtractBlocks([[1, 10]], []), [[1, 10]]);
  assert.deepEqual(subtractBlocks([[1, 3]], [1, 2, 3]), []);
  assert.deepEqual(subtractBlocks([[1, 10]], [7, 3, 3]), [[1, 2], [4, 6], [8, 10]], "order and repeats do not matter");
});

test("gapsWithin: covered, uncovered, and ranges that reach outside the window", () => {
  assert.deepEqual(gapsWithin([], 5, 8), [[5, 8]]);
  assert.deepEqual(gapsWithin([[0, 100]], 5, 8), []);
  assert.deepEqual(gapsWithin([[0, 6]], 5, 8), [[7, 8]]);
  assert.deepEqual(gapsWithin([[7, 100]], 5, 8), [[5, 6]]);
  assert.deepEqual(gapsWithin([[1, 2], [20, 30]], 5, 8), [[5, 8]]);
  assert.deepEqual(gapsWithin([[5, 5], [8, 8]], 5, 8), [[6, 7]]);
  assert.deepEqual(gapsWithin([[5, 8]], 9, 8), [], "an empty window has no gaps");
});

test("a malformed or unsorted list read back from disk never invents coverage", () => {
  const junk = [[30, 40], [1, 5], [6, 9], [12, 11], ["a", 3], [2.5, 4], [Number.MAX_VALUE, Number.MAX_VALUE], null, [1]] as unknown as Range[];
  assert.deepEqual(normalizeRanges(junk), [[1, 9], [30, 40]]);
  assert.deepEqual(normalizeRanges(undefined), []);
  assert.deepEqual(gapsWithin(junk, 1, 40), [[10, 29]]);
  assert.equal(inRanges(junk, 11), false);
  assert.equal(inRanges(junk, 35), true);
  assert.equal(blockCount([[1, 9], [30, 40]]), 20);
});
