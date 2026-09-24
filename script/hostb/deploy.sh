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
#
# It does not touch nginx, the firewall, or any other service on the box.
set -euo pipefail

HOST="${HOST:-Sonar-VPS2}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CURB_UID=10001

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

echo "==> sync source to $HOST"
rsync -a --delete --exclude node_modules --exclude 'src/fixtures' --exclude '*.test.ts' \
  "$REPO/services/attestor/" "$HOST:/tmp/curb-src-attestor/"
rsync -a --delete --exclude node_modules --exclude '*.test.ts' \
  "$REPO/services/keeper/" "$HOST:/tmp/curb-src-keeper/"
rsync -a --delete "$REPO/script/w0/" "$HOST:/tmp/curb-src-w0/"

echo "==> install and (re)start containers"
# DATA_SUFFIX is safe inside single quotes: the check above leaves it empty or 0x-prefixed hex.
ssh "$HOST" "sudo CURB_UID=$CURB_UID SCORECARD='${SCORECARD:-}' KEEPER_MODE='${KEEPER_MODE:-shadow}' DATA_SUFFIX='$DATA_SUFFIX' bash -s" <<'REMOTE'
set -euo pipefail
install -d -m 755 /opt/curb
rsync -a --delete /tmp/curb-src-attestor/ /opt/curb/attestor/
rsync -a --delete /tmp/curb-src-keeper/   /opt/curb/keeper/
rsync -a --delete /tmp/curb-src-w0/       /opt/curb/w0/
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

# SCORECARD is empty on the very first deploy: the keeper then only generates its key and reports
# the address on /healthz, which is what the Scorecard is subsequently deployed with.
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
CONF
)

docker build -q -t curb-attestor:latest   /opt/curb/attestor
docker build -q -t curb-keeper:latest     /opt/curb/keeper
docker build -q -t curb-w0-observer:latest /opt/curb/w0

HARDEN=(--restart always --user "$CURB_UID:$CURB_UID" --read-only --tmpfs /tmp:size=16m
        --cap-drop ALL --security-opt no-new-privileges --pids-limit 256
        --log-driver json-file --log-opt max-size=20m --log-opt max-file=5)

docker rm -f curb-attestor-b >/dev/null 2>&1 || true
docker run -d --name curb-attestor-b "${HARDEN[@]}" \
  --memory 384m --memory-swap 384m --cpus 1 \
  --env-file /etc/curb/attestor-b.env --env-file /etc/curb/attestor-b.alerts.env --env-file /etc/curb/attestor-b.secret.env \
  -v /var/lib/curb/attestor-b:/data -p 127.0.0.1:8091:8080 \
  curb-attestor:latest >/dev/null

docker rm -f curb-keeper >/dev/null 2>&1 || true
docker run -d --name curb-keeper "${HARDEN[@]}" \
  --memory 384m --memory-swap 384m --cpus 1 \
  --env-file /etc/curb/keeper.env --env-file /etc/curb/keeper.alerts.env --env-file /etc/curb/keeper.secret.env \
  -v /var/lib/curb/keeper:/data -p 127.0.0.1:8092:8080 \
  curb-keeper:latest >/dev/null

# Recreated like the others so config changes take effect. The observer appends to the JSONL on its
# volume, so a restart costs at most one poll interval of coverage and loses nothing already recorded.
docker rm -f curb-w0-observer >/dev/null 2>&1 || true
docker run -d --name curb-w0-observer "${HARDEN[@]}" \
  --memory 96m --memory-swap 96m --cpus 0.25 \
  --env-file /etc/curb/w0-observer.alerts.env \
  -e OUT=/data/hkex_flip.jsonl -e TZ=UTC \
  -v /var/lib/curb/w0:/data curb-w0-observer:latest >/dev/null

rm -rf /tmp/curb-src-attestor /tmp/curb-src-keeper /tmp/curb-src-w0
docker ps --filter name=curb- --format '{{.Names}}  {{.Status}}  {{.Image}}'
REMOTE

# Both writers must answer before the deploy is called done; the observer has no HTTP surface.
for svc in "host B:8091:curb-attestor-b" "keeper:8092:curb-keeper"; do
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
