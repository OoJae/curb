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

export interface CheckLike {
  reproduced: boolean;
  labelsConsistent: boolean;
  failures: string[];
  labelFailures: string[];
  warnings: string[];
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
  out.push(c.reproduced
    ? `  REPRODUCED${c.labelsConsistent ? "" : "  (but the uncommitted labels disagree -- see LABEL above)"}`
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
  });
}

/** An offline `{ok, root, failures}` result shaped into the same contract as a RoundCheck. */
export function fromOffline(r: { ok: boolean; root: string; failures: string[] }): CheckLike {
  const labelFailures = r.failures.filter((f) => f.startsWith("top-level "));
  const failures = r.failures.filter((f) => !f.startsWith("top-level "));
  return { reproduced: failures.length === 0, labelsConsistent: labelFailures.length === 0, failures, labelFailures, warnings: [] };
}
