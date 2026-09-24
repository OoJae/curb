import { defineRailway, preserve, project, service, volume } from "railway/iac";

/**
 * Curb infrastructure on Railway.
 *
 * w0-observer  W0 evidence: polls the xStocks issuer API across HKEX and US session boundaries.
 *              Stays in `sfo` where its volume already lives; moving it would force a volume
 *              migration with downtime, and an HTTP poller's region does not affect its evidence.
 * attestor-a   Host A for MarketClock. Singapore, closest to the finale venue and the issuer.
 *              Starts in MODE=shadow. ATTESTOR_KEY_PASSWORD is deliberately NOT in this file: a
 *              human sets it as a sealed variable in the Railway dashboard, and it is then marked
 *              preserve() here so an apply can never remove it.
 *
 * Restart policy is ALWAYS for both. The earlier railway.json requested that, but Config as Code is
 * not honoured for new services, and the observer silently ran ON_FAILURE with 10 retries.
 */
export default defineRailway(() => {
  const w0ObserverVolume = volume("w0-observer-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "sfo",
    sizeMB: 5000,
  });
  const w0Observer = service("w0-observer", {
    replicas: { sfo: 1 },
    volumeMounts: { "/data": w0ObserverVolume },
    // HC_URL: healthchecks.io ping URL (period 5m, grace 2m). Kept out of source; preserve() stops deletion.
    env: { OUT: preserve(), TZ: preserve(), HC_URL: preserve() },
    // sleepApplication is omitted: Railway stores the default as null, so `false` shows as a perpetual diff.
    deploy: { restartPolicyType: "ALWAYS" },
  });

  const attestorAData = volume("attestor-a-data", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "sin",
    sizeMB: 2048,
  });
  const attestorA = service("attestor-a", {
    replicas: { sin: 1 },
    volumeMounts: { "/data": attestorAData },
    healthcheck: "/healthz",
    healthcheckTimeout: 180,
    deploy: {
      restartPolicyType: "ALWAYS",
      // One writer per key: never let an old and a new deployment overlap and race on nonces.
      overlapSeconds: 0,
      drainingSeconds: 20,
    },
    env: {
      // live since 14 Sep 2026: host key 0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4 is an enabled attestor.
      MODE: "live",
      HOST_ID: "host-a",
      CHAIN_ID: "196",
      CLOCK: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b",
      RPCS: "https://rpc.xlayer.tech,https://xlayer.drpc.org",
      DATA_DIR: "/data",
      PORT: "8080",
      HEARTBEAT_S: "300",
      TZ: "UTC",
      // X Layer Builder Code dd7u50nckt5e729f as an ERC-8021 suffix on every attestBatch; public, so a literal.
      //
      // A bad value here takes host A, the live writer, DOWN, and there is no old deployment to fall back
      // on. This service has a volume, and Railway never runs two deployments against one volume, so the
      // old one is stopped before the new one boots, health check or not. The new one then logs fatal,
      // waits 60s and exits, and restartPolicyType ALWAYS repeats that until someone fixes the value.
      // Nothing in `railway config apply` checks it, so before any apply that touches it:
      //   - run the attestor tests: main.test.ts pins this exact literal to the code above;
      //   - roll it out one host at a time. Apply here, wait until host A's /healthz shows
      //     attribution.codes ["dd7u50nckt5e729f"], and only then run script/hostb/deploy.sh (or the
      //     other way round), so host B, the standby, is never on an unproven config while host A is.
      DATA_SUFFIX: "0x6464377535306e636b74356537323966100080218021802180218021802180218021",
      // Sealed variable set by a human in the Railway dashboard on 14 Sep 2026. preserve() keeps the
      // existing value and stops any apply from deleting it: without it, host A could no longer decrypt
      // its own key (0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4). Its value never appears in this repo.
      ATTESTOR_KEY_PASSWORD: preserve(),
      // healthchecks.io ping URL (period 5m, grace 3m). A leaked ping URL can mask an outage, so it stays out of source.
      HC_URL: preserve(),
      // R2 archive credentials (publish.ts): token curb-archive-a, Object Read & Write on bucket curb-archive
      // only. Set 24 Sep 2026 via `railway variable set --stdin` from ~/.foundry/curb-secrets/r2-a.env.
      R2_ACCOUNT_ID: preserve(),
      R2_ACCESS_KEY_ID: preserve(),
      R2_SECRET_ACCESS_KEY: preserve(),
      R2_BUCKET: preserve(),
    },
  });

  // curb-asp -- Curb's x402-paid API for the OKX AI marketplace (services/asp), at https://api.curb.markets.
  // Deployed by upload like attestor-a: `railway up services/asp --path-as-root --service curb-asp`.
  const aspData = volume("asp-data", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "sin",
    sizeMB: 1024,
  });
  const curbAsp = service("curb-asp", {
    replicas: { sin: 1 },
    // /data holds receipts/, issuer/ (the evidence bytes each answer was computed from), index/ (the
    // RegimeChanged backfill) and ledger/ (pending and settled payments).
    volumeMounts: { "/data": aspData },
    // Custom domain api.curb.markets is attached with `railway domain` (Railway configuration cannot
    // register custom domains), fronted by a DNS-only CNAME in Cloudflare -- never proxied: a proxy may
    // cache or rewrite a 402, and both OKX's validator and every x402 client depend on the exact status
    // and headers.
    healthcheck: "/healthz",
    // /healthz goes ok after the first tick. The Broker's /supported is fired, not awaited, so a slow
    // OKX cannot hold the first deploy's healthcheck.
    healthcheckTimeout: 180,
    deploy: {
      restartPolicyType: "ALWAYS",
      // One process per volume: the payment ledger and the receipts must never have two writers.
      overlapSeconds: 0,
      // SIGTERM drains paid requests in flight for up to 45 s (main.ts DRAIN_MS); this must exceed it.
      drainingSeconds: 60,
    },
    env: {
      HOST_ID: "asp",
      CHAIN_ID: "196",
      CLOCK: "0x160Dc415902971a7a9B5ade7f43005b36FE5B09b",
      SCORECARD: "0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f",
      RPCS: "https://rpc.xlayer.tech,https://xlayer.drpc.org",
      PUBLIC_URL: "https://api.curb.markets",
      DATA_DIR: "/data",
      PORT: "8080",
      TZ: "UTC",
      OKX_SYNC_SETTLE: "true",
      // A settle outlasting this is an unknown outcome, resolved by the chain (pay/ledger.ts). 5000-120000.
      OKX_SETTLE_TIMEOUT_MS: "30000",
      // curb-revenue: receive-only, key only in an encrypted keystore on the team's Mac. Public, so a literal;
      // listed in docs/WALLETS.md.
      PAY_TO: "0x277cA91276A3801667B76C97Da3872Ccb6E96068",
      // OKX Onchain OS API credentials. Set from ~/.foundry/curb-secrets/okx-api.env with
      // `railway variables --set-from-stdin`, never typed into a command or committed. preserve() keeps them.
      OKX_API_KEY: preserve(),
      OKX_SECRET_KEY: preserve(),
      OKX_PASSPHRASE: preserve(),
    },
  });

  return project("curb", {
    resources: [w0Observer, w0ObserverVolume, attestorA, attestorAData, curbAsp, aspData],
  });
});
