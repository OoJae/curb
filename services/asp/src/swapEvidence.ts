/**
 * Where the keeper's swap evidence starts (docs/DECISIONS.md D-15).
 *
 * Until deploy 2 the keeper decoded no pool Swap logs. Every row committed before the first block its fixed build
 * read carries swapsDuringClosure 0 and empty swap lists, and has closingVwap == lastPrint on chain, whatever the
 * pool did. The chain cannot tell those rows apart from later ones, so this service is told where they end.
 *
 * This is the keeper's SWAP_EVIDENCE_FROM_BLOCK (services/keeper/src/swapEvidence.ts), copied by hand: the chain head
 * read at 16 Nov 2026 05:40Z, after the fixed keeper had started. Number.MAX_SAFE_INTEGER, its value before that,
 * still means "not set": served text then names the pre-fix rows by the fix instead of by block and counts none.
 */
export const SWAP_EVIDENCE_FROM_BLOCK: number = 76_038_603;

export const swapEvidenceSet = (from: number = SWAP_EVIDENCE_FROM_BLOCK): boolean => from !== Number.MAX_SAFE_INTEGER;

/** A row is pre-fix when it was committed before the fixed keeper's first read (every row, until the block is set). */
export const isPreFix = (committedBlock: number, from: number = SWAP_EVIDENCE_FROM_BLOCK): boolean => committedBlock < from;

/** How the pre-fix rows are named in served text: by block once it is set, and by the fix until then. */
export function preFixRows(from: number = SWAP_EVIDENCE_FROM_BLOCK): string {
  return swapEvidenceSet(from) ? `rows committed before block ${from}` : "rows committed before the keeper's swap-decoding fix";
}
