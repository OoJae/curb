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
    },
  });

  return project("curb", {
    resources: [w0Observer, w0ObserverVolume, attestorA, attestorAData],
  });
});
