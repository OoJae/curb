#!/usr/bin/env bash
# Register the six US xStock wrappers that Morpho lends against on X Layer (chain 196) with MarketClock.
#
#   bash script/registry/register-us6.sh            # checks, shows the six calls, asks, then sends
#   PWFILE=/path/to/password bash script/registry/register-us6.sh   # same, without six password prompts
#
# registerAsset is admin-only and PERMANENT: MarketClock has no way to remove an asset. Every row below was
# checked on 21 Nov 2026: the wrapper's asset() is the raw token the issuer lists for X Layer, the raw token
# has code, the MIC is the issuer's own trading.exchange.mic, and the issuer reports tradingHoursMode
# TwentyFourFive (hoursMode 1, as wNVDAx and wAAPLx were registered). The attestor reads only the MIC; it takes
# the hours from the issuer. This script re-checks all of it on chain before it sends anything.
set -euo pipefail

RPC="${RPC:-https://rpc.xlayer.tech}"
ACCOUNT="${ACCOUNT:-curb-deployer}"
CLOCK=0x160Dc415902971a7a9B5ade7f43005b36FE5B09b
ADMIN=0x78a5955b433988198bccA2E8bdC671444798f809
HOURS=1   # TwentyFourFive

# symbol  wrapper                                     raw                                         MIC
ROWS=$(cat <<'EOF'
wSPYx   0xe7e553cd128f0011777323a0b44a7b96ea1cb540  0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48  ARCX
wQQQx   0x4c1ae29c159838fc1b224636e28e086eb69101f7  0xa753a7395cae905cd615da0b82a53e0560f250af  XNAS
wGOOGLx 0xf8c5308f80e459bb53d9ebe689854d9cbb2caa6f  0xe92f673ca36c5e2efd2de7628f815f84807e803f  XNAS
wCRCLx  0xb11134f14d5b94db60d4599dfdc3bf1bba2150e8  0xfebded1b0986a8ee107f5ab1a1c5a813491deceb  XNYS
wSPCXx  0x8e2eed8b8b5e13ea7bf38e50d7821d2c57309072  0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28  XNAS
wTSLAx  0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171  0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0  XNAS
EOF
)

mic_hex() { printf '0x%s' "$(printf '%s' "$1" | xxd -p)"; }
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

echo "Checking on chain ($RPC) ..."
[ "$(lc "$(cast call --rpc-url "$RPC" "$CLOCK" 'admin()(address)')")" = "$(lc "$ADMIN")" ] || { echo "MarketClock admin is not $ADMIN; stopping."; exit 1; }
before=$(cast call --rpc-url "$RPC" "$CLOCK" 'registeredCount()(uint256)')
echo "registeredCount now: $before"

todo=()
while read -r sym w raw mic; do
  [ -z "$sym" ] && continue
  asset=$(cast call --rpc-url "$RPC" "$w" 'asset()(address)')
  [ "$(lc "$asset")" = "$(lc "$raw")" ] || { echo "$sym: asset() is $asset, expected $raw; stopping."; exit 1; }
  [ "$(cast call --rpc-url "$RPC" "$w" 'symbol()(string)')" = "\"$sym\"" ] || { echo "$sym: wrapper symbol mismatch; stopping."; exit 1; }
  [ "$(cast code --rpc-url "$RPC" "$raw")" != "0x" ] || { echo "$sym: raw token has no code; stopping."; exit 1; }
  if [ "$(cast call --rpc-url "$RPC" "$CLOCK" 'assets(address)(address,bytes4,uint8,bool)' "$w" | tail -1)" = "true" ]; then
    echo "$sym: already registered, skipped"; continue
  fi
  m=$(mic_hex "$mic")
  cast call --rpc-url "$RPC" --from "$ADMIN" "$CLOCK" 'registerAsset(address,address,bytes4,uint8)' "$w" "$raw" "$m" "$HOURS" >/dev/null \
    || { echo "$sym: simulation failed; stopping."; exit 1; }
  printf '  %-8s registerAsset(%s, %s, %s "%s", %s)  simulation ok\n' "$sym" "$w" "$raw" "$m" "$mic" "$HOURS"
  todo+=("$sym $w $raw $m")
done <<< "$ROWS"

[ ${#todo[@]} -gt 0 ] || { echo "Nothing to register."; exit 0; }
echo
echo "About to send ${#todo[@]} transaction(s) from $ACCOUNT ($ADMIN) to MarketClock $CLOCK."
echo "This cannot be undone: a registered asset stays registered."
read -r -p "Type REGISTER to send: " ok
[ "$ok" = "REGISTER" ] || { echo "Not sent."; exit 1; }

pw=()
[ -n "${PWFILE:-}" ] && pw=(--password-file "$PWFILE")
for row in "${todo[@]}"; do
  read -r sym w raw m <<< "$row"
  out=$(cast send --rpc-url "$RPC" --account "$ACCOUNT" "${pw[@]}" --json "$CLOCK" \
        'registerAsset(address,address,bytes4,uint8)' "$w" "$raw" "$m" "$HOURS")
  st=$(printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status"), d.get("transactionHash"), int(d.get("blockNumber"),16))')
  echo "  $sym  $st"
  case "$st" in 0x1*|1*) ;; *) echo "$sym: transaction did not succeed; stopping."; exit 1;; esac
done

after=$(cast call --rpc-url "$RPC" "$CLOCK" 'registeredCount()(uint256)')
echo "registeredCount: $before -> $after"
