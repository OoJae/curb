#!/usr/bin/env bash
# Deploy Curb's VPS services to Sonar-VPS2:
#   - MarketClock host B  (standby writer + witness)
#   - a second W0 observer
#   - curb-keeper         (Scorecard marks: commit before the reopen, settle after)
#
# Idempotent. Run from the repo root on the Mac:   script/hostb/deploy.sh
#
# Before anything reaches the box it checks DATA_SUFFIX (below) on the Mac, and stops if the value is
# malformed or is not Curb's Builder Code.
#
# What it does on the box, and nothing else:
#   /opt/curb/{attestor,w0,keeper}       source, root-owned
#   /var/lib/curb/{attestor-b,w0,keeper} data volumes, owned by an unprivileged uid (10001) used only by Curb
#   /etc/curb/<svc>.env                  non-secret config, rewritten on every deploy
#   /etc/curb/<svc>.alerts.env           healthchecks URLs; created empty once, never overwritten
#   /etc/curb/<svc>.secret.env           the keystore password; generated ON THE BOX once, never printed,
#                                        never copied off, never overwritten (overwriting orphans the key)
#   containers curb-attestor-b, curb-w0-observer, curb-keeper: restart=always, hard memory caps,
#   no inbound ports except /healthz (and /witness) bound to 127.0.0.1.
#   /var/lib/curb/logs/curb-keeper-<ts>.log.gz   the replaced keeper's log, saved before `docker rm -f` (newest 10)
#   /var/lib/curb/keeper/keeper-state.predeploy-<ts>.json   its state, copied after it stopped (newest 5)
#
# It does not touch nginx, the firewall, or any other service on the box.
set -euo pipefail

HOST="${HOST:-Sonar-VPS2}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CURB_UID=10001

# Which services this run touches. Default: all three, exactly as before. A code change to one service should
# not restart the other two:   SERVICES=keeper KEEPER_MODE=live SCORECARD=0x... bash script/hostb/deploy.sh
SERVICES="${SERVICES:-attestor-b keeper w0}"
for s in $SERVICES; do
  case "$s" in attestor-b|keeper|w0) ;; *) echo "unknown service '$s' in SERVICES (attestor-b, keeper, w0)" >&2; exit 1 ;; esac
done
want() { case " $SERVICES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
echo "==> services: $SERVICES"

# ERC-8021 attribution. DATA_SUFFIX is the X Layer Builder Code BUILDER_CODE as an ERC-8021 suffix, appended
# to every transaction host B and the keeper sign. It is public by design (it is in the calldata), so it
# lives here, not in a secret file, and both env files below take this one value. Set DATA_SUFFIX= (empty)
# to turn attribution off.
BUILDER_CODE=dd7u50nckt5e729f
DATA_SUFFIX=0x6464377535306e636b74356537323966100080218021802180218021802180218021

# Checked HERE, on the Mac, before anything reaches the box, with the services' own validator and
# against the code it is meant to carry. A malformed value would stop both containers at boot, and the
# script below `docker rm -f`s each container before starting its replacement, so host B (the standby) and
# the keeper would go down together. A well-formed but wrong code would boot cleanly and credit every
# transaction to someone else. Neither may reach the box. This needs services/attestor/node_modules.
# One check covers both services only because their sender.ts copies are byte-identical, so that is
# checked too.
#
# Roll attribution out one host at a time: host A is applied from .railway/railway.ts, separately. Do not
# run this while host A is mid-deploy on a new DATA_SUFFIX; wait until its /healthz shows
# attribution.codes, so host B is never on an unproven config while host A is.
echo "==> check DATA_SUFFIX"
cmp -s "$REPO/services/attestor/src/tx/sender.ts" "$REPO/services/keeper/src/tx/sender.ts" || {
  echo "services/attestor and services/keeper sender.ts differ; they must be byte-identical" >&2; exit 1; }
DATA_SUFFIX="$(node --experimental-strip-types --input-type=module -e '
  const { pathToFileURL } = await import("node:url");
  const [sender, suffix, want] = process.argv.slice(1);
  const { normalizeDataSuffix, builderCodes } = await import(pathToFileURL(sender).href);
  const value = normalizeDataSuffix(suffix);
  const codes = builderCodes(value).join(",");
  if (value !== "" && codes !== want) throw new Error(`DATA_SUFFIX carries Builder Code ${codes}, not ${want}`);
  console.error(value === "" ? "attribution off" : `attribution on: Builder Code ${codes}`);
  console.log(value);
' "$REPO/services/attestor/src/tx/sender.ts" "$DATA_SUFFIX" "$BUILDER_CODE")"

# keeper.env is rewritten on every run. Since 21 Sep the keeper is live on Scorecard v2, so a run without both
# variables would quietly demote it to a shadow keeper with no Scorecard and stop the marks. Say them out loud:
#   KEEPER_MODE=live SCORECARD=0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f bash script/hostb/deploy.sh
if want keeper; then
  : "${KEEPER_MODE:?set KEEPER_MODE (live since 21 Sep; shadow only on purpose)}"
  if [[ "$KEEPER_MODE" == "live" ]]; then : "${SCORECARD:?set SCORECARD (Scorecard v2 0x3b4076c364AbDaE93e6419CeAdEEe8CB283BEf1f)}"; fi
fi

echo "==> sync source to $HOST"
if want attestor-b; then
  rsync -a --delete --exclude node_modules --exclude 'src/fixtures' --exclude '*.test.ts' \
    "$REPO/services/attestor/" "$HOST:/tmp/curb-src-attestor/"
fi
if want keeper; then
  rsync -a --delete --exclude node_modules --exclude '*.test.ts' \
    "$REPO/services/keeper/" "$HOST:/tmp/curb-src-keeper/"
fi
if want w0; then rsync -a --delete "$REPO/script/w0/" "$HOST:/tmp/curb-src-w0/"; fi

echo "==> install and (re)start containers"
# DATA_SUFFIX is safe inside single quotes: the check above leaves it empty or 0x-prefixed hex.
ssh "$HOST" "sudo CURB_UID=$CURB_UID SERVICES='$SERVICES' SCORECARD='${SCORECARD:-}' KEEPER_MODE='${KEEPER_MODE:-shadow}' DATA_SUFFIX='$DATA_SUFFIX' bash -s" <<'REMOTE'
set -euo pipefail
want() { case " $SERVICES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
install -d -m 755 /opt/curb
if want attestor-b; then rsync -a --delete /tmp/curb-src-attestor/ /opt/curb/attestor/; fi
if want keeper;     then rsync -a --delete /tmp/curb-src-keeper/   /opt/curb/keeper/; fi
if want w0;         then rsync -a --delete /tmp/curb-src-w0/       /opt/curb/w0/; fi
install -d -m 700 -o "$CURB_UID" -g "$CURB_UID" /var/lib/curb/attestor-b /var/lib/curb/w0 /var/lib/curb/keeper
install -d -m 700 /etc/curb

# A keystore password is generated once and never replaced: replacing it orphans an enabled key.
for svc in attestor-b keeper; do
  var=ATTESTOR_KEY_PASSWORD; [ "$svc" = keeper ] && var=KEEPER_KEY_PASSWORD
  if [ ! -s "/etc/curb/$svc.secret.env" ]; then
    (umask 077; printf '%s=%s\n' "$var" "$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 64)" > "/etc/curb/$svc.secret.env")
    echo "generated a new keystore password for $svc on the box (not shown)"
  fi
done
for f in attestor-b.alerts.env keeper.alerts.env; do
  [ -f "/etc/curb/$f" ] || (umask 077; printf 'HC_URL=\nHC_ALARM_URL=\n' > "/etc/curb/$f")
done
[ -f /etc/curb/w0-observer.alerts.env ] || (umask 077; printf 'HC_URL=\n' > /etc/curb/w0-observer.alerts.env)

# DATA_SUFFIX in both env files is the one value checked on the Mac before this ran (top of the script).
if want attestor-b; then
(umask 077; cat > /etc/curb/attestor-b.env <<CONF
MODE=standby
HOST_ID=host-b
CHAIN_ID=196
CLOCK=0x160Dc415902971a7a9B5ade7f43005b36FE5B09b
RPCS=https://rpc.xlayer.tech,https://xlayer.drpc.org
DATA_DIR=/data
PORT=8080
HEARTBEAT_S=300
TZ=UTC
PRIMARY_BUNDLE_URL=https://attestor-a-production.up.railway.app
EXPECTED_ATTESTORS=0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4,0x4c3eD38809FA6469871F4e0cbEa7ae7dBdA87fb8
WITNESS_FROM_BLOCK=70617365
DATA_SUFFIX=${DATA_SUFFIX}
CONF
)
fi

# SCORECARD is empty on the very first deploy: the keeper then only generates its key and reports
# the address on /healthz, which is what the Scorecard is subsequently deployed with.
if want keeper; then
(umask 077; cat > /etc/curb/keeper.env <<CONF
MODE=${KEEPER_MODE}
HOST_ID=keeper
CHAIN_ID=196
CLOCK=0x160Dc415902971a7a9B5ade7f43005b36FE5B09b
SCORECARD=${SCORECARD}
RPCS=https://rpc.xlayer.tech,https://xlayer.drpc.org
DATA_DIR=/data
PORT=8080
TICK_MS=30000
MIN_CLOSURE_S=1800
COMMIT_LEAD_S=600
COMMIT_FLOOR_S=120
SETTLE_DELAY_S=300
TZ=UTC
DATA_SUFFIX=${DATA_SUFFIX}
# Swap-coverage backfill: eth_getLogs chunks per quiet tick, [0,60], 0 disables. 10 if the pre-deploy probe
# shows any refusal at 1 req/s. Builds before deploy 2 ignore it.
BACKFILL_CHUNKS_PER_TICK=20
# mark/2's cross-market signal. This box is in the US, where Binance answers 451, so the perp leg goes
# through curb-asp's byte-exact relay in Singapore (the upstream bytes are committed and re-fetchable).
SIGNAL=on
SIGNAL_RELAY_BASE=https://api.curb.markets
SIGNAL_BINANCE_DIRECT=off
CONF
)
fi

# Archive (R2) credentials: created empty once and never overwritten, like the alerts files. Publishing
# stays off until they are filled on the box; the values never pass through this script.
for f in attestor-b.r2.env keeper.r2.env; do
  [ -f "/etc/curb/$f" ] || (umask 077; : > "/etc/curb/$f")
done

# The image each running container was started from stays reachable as <repo>:prev-<image id>: the build
# below moves :latest, and `docker rm -f` drops the last reference to the old one. The tag carries the image
# id, so a second run (a retry after a bad deploy) cannot overwrite the good one. Roll back with the same
# `docker run` and that tag; `docker images curb-*` lists them, newest first.
keep_prev() {
  local id; id="$(docker inspect --format '{{.Image}}' "$1" 2>/dev/null)" || return 0
  id="${id#sha256:}"; docker tag "$id" "$2:prev-${id:0:12}"
}
if want attestor-b; then keep_prev curb-attestor-b curb-attestor;      docker build -q -t curb-attestor:latest    /opt/curb/attestor; fi
if want keeper;     then keep_prev curb-keeper curb-keeper;            docker build -q -t curb-keeper:latest      /opt/curb/keeper; fi
if want w0;         then keep_prev curb-w0-observer curb-w0-observer;  docker build -q -t curb-w0-observer:latest /opt/curb/w0; fi

HARDEN=(--restart always --user "$CURB_UID:$CURB_UID" --read-only --tmpfs /tmp:size=16m
        --cap-drop ALL --security-opt no-new-privileges --pids-limit 256
        --log-driver json-file --log-opt max-size=20m --log-opt max-file=5)

if want attestor-b; then
docker rm -f curb-attestor-b >/dev/null 2>&1 || true
docker run -d --name curb-attestor-b "${HARDEN[@]}" \
  --memory 384m --memory-swap 384m --cpus 1 \
  --env-file /etc/curb/attestor-b.env --env-file /etc/curb/attestor-b.alerts.env --env-file /etc/curb/attestor-b.secret.env \
  --env-file /etc/curb/attestor-b.r2.env \
  -v /var/lib/curb/attestor-b:/data -p 127.0.0.1:8091:8080 \
  curb-attestor:latest >/dev/null
fi

# The keeper's history lives only in its container log, which `docker rm -f` destroys. Save it on the box right
# before the old container dies (after the build, so the saved log runs up to that moment), then copy the state
# while no keeper writes it. Newest 10 logs and 5 state copies are kept. Neither save may stop the deploy once
# the old container is gone: the keeper is the only settler, so a failed copy warns and the new one starts.
# A state copy is for the restore rule of the deploy-2 runbook only (never restore one older than the last
# commit or settle in the saved logs).
if want keeper; then
install -d -m 700 /var/lib/curb/logs
if docker inspect curb-keeper >/dev/null 2>&1; then
  docker logs curb-keeper 2>&1 | gzip -c > "/var/lib/curb/logs/curb-keeper-$(date -u +%Y%m%dT%H%M%SZ).log.gz" || echo "WARNING: could not save the keeper's log" >&2
fi
docker rm -f curb-keeper >/dev/null 2>&1 || true
if [ -f /var/lib/curb/keeper/keeper-state.json ]; then
  cp -p /var/lib/curb/keeper/keeper-state.json "/var/lib/curb/keeper/keeper-state.predeploy-$(date -u +%Y%m%dT%H%M%SZ).json" \
    || echo "WARNING: could not back up keeper-state.json; starting the new keeper without a predeploy copy" >&2
fi
{ ls -1t /var/lib/curb/logs/curb-keeper-*.log.gz 2>/dev/null | tail -n +11 | xargs -r rm -f; } || true
{ ls -1t /var/lib/curb/keeper/keeper-state.predeploy-*.json 2>/dev/null | tail -n +6 | xargs -r rm -f; } || true
docker run -d --name curb-keeper "${HARDEN[@]}" \
  --memory 384m --memory-swap 384m --cpus 1 \
  --env-file /etc/curb/keeper.env --env-file /etc/curb/keeper.alerts.env --env-file /etc/curb/keeper.secret.env \
  --env-file /etc/curb/keeper.r2.env \
  -v /var/lib/curb/keeper:/data -p 127.0.0.1:8092:8080 \
  curb-keeper:latest >/dev/null
fi

# Recreated like the others so config changes take effect. The observer appends to the JSONL on its
# volume, so a restart costs at most one poll interval of coverage and loses nothing already recorded.
if want w0; then
docker rm -f curb-w0-observer >/dev/null 2>&1 || true
docker run -d --name curb-w0-observer "${HARDEN[@]}" \
  --memory 96m --memory-swap 96m --cpus 0.25 \
  --env-file /etc/curb/w0-observer.alerts.env \
  -e OUT=/data/hkex_flip.jsonl -e TZ=UTC \
  -v /var/lib/curb/w0:/data curb-w0-observer:latest >/dev/null
fi

rm -rf /tmp/curb-src-attestor /tmp/curb-src-keeper /tmp/curb-src-w0
docker ps --filter name=curb- --format '{{.Names}}  {{.Status}}  {{.Image}}'
REMOTE

# Both writers must answer before the deploy is called done; the observer has no HTTP surface.
for svc in "host B:8091:curb-attestor-b" "keeper:8092:curb-keeper"; do
  case "$svc" in "host B:"*) want attestor-b || continue ;; "keeper:"*) want keeper || continue ;; esac
  name="${svc%%:*}"; rest="${svc#*:}"; port="${rest%%:*}"; container="${rest#*:}"
  echo "==> waiting for $name to report healthy on $port"
  ok=""
  for _ in $(seq 1 30); do
    if out=$(ssh "$HOST" "curl -fsS -m 5 http://127.0.0.1:$port/healthz" 2>/dev/null); then
      echo "$out"; ok=1; break
    fi
    sleep 5
  done
  if [ -z "$ok" ]; then
    echo "$name did not report healthy within 150s; recent logs:" >&2
    ssh "$HOST" "sudo docker logs --tail 40 $container" >&2
    exit 1
  fi
done
