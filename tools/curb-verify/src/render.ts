/**
 * Turning a check into words and an exit code.
 *
 * Pure on purpose, so the exit-code matrix is unit-testable without a network or a process. Two
 * rules that are easy to get wrong and expensive if you do:
 *
 *   - Timestamps render as ISO-8601 UTC, never `toLocaleString`. A verifier that prints a different
 *     instant in Lagos than in Singapore is not a verifier, and the four-timezone test asserts the
 *     exact string this produces.
 *   - "I could not reach the archive" is NOT "this row does not reproduce". They are exit 3 and
 *     exit 1, and conflating them turns a flaky public RPC into an accusation. This is a deliberate
 *     divergence from `checkRound`, which folds unavailability into `reproduced: false` -- correct
 *     for a witness that has to sign something either way, wrong for a tool a stranger runs once.
 */
export const EXIT = {
  VERIFIED: 0,
  NOT_REPRODUCED: 1,
  USAGE: 2,
  UNAVAILABLE: 3,
  UNSUPPORTED: 4,
} as const;

/**
 * What a mark's swap evidence does and does not record (keeper swapEvidence.ts). `era` is "pre-swap-fix" for a
 * row read before the swap-evidence cutover, "swap-evidence" from it; `complete` is null for pre-fix rows.
 * Notes never change the verdict or the exit code.
 */
export interface EvidenceLike { era: string; complete: boolean | null; notes: string[] }

export interface CheckLike {
  reproduced: boolean;
  labelsConsistent: boolean;
  failures: string[];
  labelFailures: string[];
  warnings: string[];
  evidence?: EvidenceLike;
}

/** E1 and E2: the bundle's own numbers show a swap its lists omit. */
const OMITS_SWAPS = ["the bundle's own pool reads moved ", "lastPrint is the keeper's last pre-cut reading"];

/** Why a reproduced row needs reading with its EVIDENCE lines, or "" when it does not. */
function reproducedQualifier(e: EvidenceLike | undefined): string {
  if (!e || e.era !== "pre-swap-fix") return "";
  const notes = e.notes;
  if (notes.some((n) => OMITS_SWAPS.some((p) => n.includes(p)))) return "  (from the evidence as published; that evidence omits pool swaps -- see EVIDENCE above)";
  if (notes.some((n) => n.includes("decoded no pool Swap logs"))) return "  (pre-fix row: swap evidence was not recorded -- see EVIDENCE above)";
  return "  (pre-fix row: its swap lists were not checked -- see EVIDENCE above)";
}

export const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export const exitFor = (c: CheckLike): number => (c.reproduced ? EXIT.VERIFIED : EXIT.NOT_REPRODUCED);

const bullet = (lines: string[], prefix: string) => lines.map((f) => `  ${prefix} ${f}`);

export function renderCheck(header: string, fields: Array<[string, string]>, c: CheckLike): string {
  const out = [header];
  const width = Math.max(0, ...fields.map(([k]) => k.length));
  for (const [k, v] of fields) out.push(`  ${k.padEnd(width)}  ${v}`);
  // Every failure, in full. The witness truncates to three for a pager message; a verifier must not,
  // because the one it dropped is the one the reader needed.
  out.push(...bullet(c.failures, "FAIL   "));
  out.push(...bullet(c.labelFailures, "LABEL  "));
  out.push(...bullet(c.warnings, "warn   "));
  // Every EVIDENCE note, never elided. They describe what the evidence records; they are not failures.
  out.push(...bullet(c.evidence?.notes ?? [], "EVIDENCE"));
  out.push(c.reproduced
    ? `  REPRODUCED${reproducedQualifier(c.evidence)}${c.labelsConsistent ? "" : "  (but the uncommitted labels disagree -- see LABEL above)"}`
    : "  NOT REPRODUCED");
  return out.join("\n");
}

export function renderJson(kind: string, extra: Record<string, unknown>, c: CheckLike): string {
  return JSON.stringify({
    schema: "curb.verify/1",
    kind,
    ...extra,
    ok: c.reproduced && c.labelsConsistent,
    reproduced: c.reproduced,
    labelsConsistent: c.labelsConsistent,
    failures: c.failures,
    labelFailures: c.labelFailures,
    warnings: c.warnings,
    ...(c.evidence ? { evidence: c.evidence } : {}),
  });
}

/**
 * An offline `{ok, root, failures}` result shaped into the same contract as a RoundCheck. A mark bundle's
 * result also carries its era and EVIDENCE notes, which ride along unchanged.
 */
export function fromOffline(r: {
  ok: boolean; root: string; failures: string[]; notes?: string[]; era?: string; evidenceComplete?: boolean | null;
}): CheckLike {
  const labelFailures = r.failures.filter((f) => f.startsWith("top-level "));
  const failures = r.failures.filter((f) => !f.startsWith("top-level "));
  const out: CheckLike = { reproduced: failures.length === 0, labelsConsistent: labelFailures.length === 0, failures, labelFailures, warnings: [] };
  if (r.era !== undefined) out.evidence = { era: r.era, complete: r.evidenceComplete ?? null, notes: r.notes ?? [] };
  return out;
}
