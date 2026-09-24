// The HK week as 2,016 five-minute attestation slots, Mon 00:00 HKT = slot 0.
// Open = primary market trading: 09:30–12:00 and 13:00–16:00 HKT on weekdays, each session ending 5 minutes early
// (the measured early cut), i.e. [09:30, 11:55) and [13:00, 15:55) → 64 open slots (320 min) a day, 320 a week.
// Everything else is shut-but-trading: 1,696 of 2,016 slots (84 %), 141 h 20 m.
// A pattern of the regular week: public holidays are not modelled here (schedule.ts owns the live calendar).

export const SLOTS_PER_DAY = 288;
export const SLOTS = 7 * SLOTS_PER_DAY;
const SESSIONS = [
  [9 * 12 + 6, 11 * 12 + 11], // 09:30 → 11:55
  [13 * 12, 15 * 12 + 11], // 13:00 → 15:55
];

export function isOpen(slot) {
  const day = Math.floor(slot / SLOTS_PER_DAY);
  const s = slot % SLOTS_PER_DAY;
  return day < 5 && SESSIONS.some(([a, b]) => s >= a && s < b);
}

/** Runs of equal state: [{ start, end, open }], end exclusive. */
export function runs() {
  const out = [];
  for (let i = 0; i < SLOTS; i++) {
    const open = isOpen(i);
    const last = out[out.length - 1];
    if (last && last.open === open && i % SLOTS_PER_DAY !== 0) last.end = i + 1;
    else out.push({ start: i, end: i + 1, open });
  }
  return out;
}
