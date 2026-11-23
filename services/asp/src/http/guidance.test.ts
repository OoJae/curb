import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCS_URL, withGuidance, withRouteHelp } from "./guidance.ts";
import { PRICED_ROUTES } from "../pay/routes.ts";

test("an error body keeps its code and fields and gains a message and the docs link", () => {
  const out = withGuidance(400, { error: "unknown-symbol", symbol: "GME", valid: ["wTCENTx"] }) as Record<string, unknown>;
  assert.equal(out.error, "unknown-symbol");
  assert.deepEqual(out.valid, ["wTCENTx"]);
  assert.match(String(out.message), /symbol is not an asset this route covers/);
  assert.equal(out.docs, DOCS_URL);
});

test("an integer refusal is explained from its own bounds", () => {
  const out = withGuidance(400, { error: "bad-horizon", horizonDays: "99", min: 1, max: 14 }) as Record<string, unknown>;
  assert.equal(out.message, "horizonDays must be a whole number from 1 to 14. Omit it for the default.");
  const lim = withGuidance(400, { error: "bad-limit", limit: "0", min: 1, max: 200 }) as Record<string, unknown>;
  assert.equal(lim.message, "limit must be a whole number from 1 to 200. Omit it for the default.");
});

test("a pre-settlement failure says nothing was charged; one after a settle attempt does not", () => {
  for (const code of ["broker-unavailable", "ledger-unavailable", "issuer-unavailable", "payments-unavailable", "facilitator-error"]) {
    assert.match(String((withGuidance(503, { error: code }) as Record<string, unknown>).message), /Nothing was charged/, code);
  }
  for (const code of ["settlement-unconfirmed", "internal"]) {
    assert.doesNotMatch(String((withGuidance(503, { error: code }) as Record<string, unknown>).message), /Nothing was charged/, code);
  }
});

test("success bodies, non-objects and bodies that already explain themselves are left alone", () => {
  const ok = { schema: "curb.asp.calendar/1", windows: [] };
  assert.equal(withGuidance(200, ok), ok);
  assert.equal(withGuidance(402, "text"), "text");
  const own = { error: "x", message: "mine" };
  assert.equal(withGuidance(400, own), own);
  assert.match(String((withGuidance(418, { error: "never-seen" }) as Record<string, unknown>).message), /See `docs`/);
});

test("a priced route's 4xx refusal names its parameters and a request that works; a 5xx does not", () => {
  const route = PRICED_ROUTES.find((r) => r.path === "/v1/closure-calendar")!;
  const out = withRouteHelp(400, { error: "bad-horizon" }, route);
  assert.equal(out.parameters, route.query);
  assert.equal(out.example, "/v1/closure-calendar?symbol=wTCENTx&horizonDays=7");
  assert.equal(withRouteHelp(503, { error: "issuer-unavailable" }, route).example, undefined);
  for (const r of PRICED_ROUTES) assert.ok(r.example.startsWith(r.path + "?"), r.path);
});
