#!/usr/bin/env bash
# poke.sh -- witness a reopen on ReopenPointer, then record its print 300 s later.
#
# Polls MarketClock.primaryCapNow(wrapper). When capacity returns and the pointer still thinks the market is
# shut, it sends ReopenPointer.observe(wrapper) (the reopen is then bracketed in (shutSeenAt, openedAt]).
# At openedAt + 300 s it sends recordPrint(wrapper, epoch), retrying inside the 30-minute print window
# (Scorecard refuses a print while the pool's spot is >50 ticks off its TWAP). While the market is shut and
# the pointer still says open, it sends observe once to witness the shut -- without that, the next reopen
# could not advance the epoch.
#
# Every transaction carries the ERC-8021 Builder Code: data = `cast calldata ...` || SUFFIX.
# Passwords and keys are never printed: cast reads the keystore password from $PWFILE itself.
#
# Usage:
#   POINTER=0x... PWFILE=~/.foundry/curb-secrets/<desk file> script/w3/poke.sh [--once]
#   POINTER=0x... script/w3/poke.sh --dry-run        # print the calldata it would send, send nothing
#
# Env: POINTER (required), WRAPPER (default wTCENTx), ACCOUNT (default curb-desk), PWFILE (required unless
#      --dry-run), RPC (default https://rpc.xlayer.tech), INTERVAL poll seconds (default 5),
#      EPOCH (dry-run only: epoch for the printed recordPrint calldata when the pointer is unreadable).
set -euo pipefail

RPC="${RPC:-https://rpc.xlayer.tech}"
CLOCK="${CLOCK:-0x160Dc415902971a7a9B5ade7f43005b36FE5B09b}"
WRAPPER="${WRAPPER:-0x41333Df9E7639188BBfca5522dC4844398Af9f9E}"
ACCOUNT="${ACCOUNT:-curb-desk}"
INTERVAL="${INTERVAL:-5}"
SUFFIX="6464377535306e636b74356537323966100080218021802180218021802180218021" # dd7u50nckt5e729f, ERC-8021 schema 0
PRINT_DELAY=300
PRINT_WINDOW=1800

DRY_RUN=0
ONCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --once) ONCE=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

: "${POINTER:?set POINTER to the deployed ReopenPointer address}"
if [[ $DRY_RUN -eq 0 ]]; then
  : "${PWFILE:?set PWFILE to the keystore password file (it is passed to cast, never read or printed here)}"
  [[ -r "$PWFILE" ]] || { echo "PWFILE is not readable" >&2; exit 2; }
fi

log() { printf '%s poke: %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# First word of a `cast call` result ("20000000 [2e7]" -> "20000000").
first() { awk '{print $1}'; }

tagged() { # tagged <sig> [args...] -> calldata || suffix
  local cd
  cd="$(cast calldata "$@")"
  printf '%s%s' "$cd" "$SUFFIX"
}

send() { # send <to> <sig> [args...]
  local to="$1"; shift
  local data
  data="$(tagged "$@")"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf 'to:   %s\ncall: %s\ndata: %s\n' "$to" "$*" "$data"
    return 0
  fi
  # cast estimates first, so a call that would revert fails here without sending anything.
  cast send "$to" "$data" --account "$ACCOUNT" --password-file "$PWFILE" --rpc-url "$RPC" \
    | awk '$1 == "transactionHash" || $1 == "status" || $1 == "blockNumber" || $1 == "gasUsed"'
}

regime() { cast call "$CLOCK" "regime(address)(uint8)" "$WRAPPER" --rpc-url "$RPC" | first; }
cap_now() { cast call "$CLOCK" "primaryCapNow(address)(uint128)" "$WRAPPER" --rpc-url "$RPC" | first; }
is_open() { cast call "$POINTER" "isOpen(address)(bool)" "$WRAPPER" --rpc-url "$RPC" | first; }
epoch_of() { cast call "$POINTER" "epochOf(address)(uint32)" "$WRAPPER" --rpc-url "$RPC" | first; }
opened_at() { # opened_at <epoch>  (Epoch = shutSeenAt, openedAt, openedBlock, print, printedAt)
  cast call "$POINTER" "epochInfo(address,uint32)((uint64,uint64,uint64,uint128,uint64))" "$WRAPPER" "$1" \
    --rpc-url "$RPC" | tr -d '()' | awk -F', ' '{print $2}' | first
}
printed() {
  cast call "$POINTER" "epochInfo(address,uint32)((uint64,uint64,uint64,uint128,uint64))" "$WRAPPER" "$1" \
    --rpc-url "$RPC" | tr -d '()' | awk -F', ' '{print $4}' | first
}

if [[ $DRY_RUN -eq 1 ]]; then
  e="$(epoch_of 2>/dev/null || true)"
  if [[ -n "$e" ]]; then next=$((e + 1)); else next="${EPOCH:-1}"; fi
  log "dry run: pointer $POINTER, wrapper $WRAPPER, account $ACCOUNT (nothing is sent)"
  log "clock now: regime $(regime) cap $(cap_now)"
  echo "# on reopen:"
  send "$POINTER" "observe(address)" "$WRAPPER"
  echo "# at openedAt + ${PRINT_DELAY}s:"
  send "$POINTER" "recordPrint(address,uint32)" "$WRAPPER" "$next"
  exit 0
fi

# Wait until openedAt + 300 (+3 s for block-time slack), then print, retrying inside the window.
print_epoch() {
  local e="$1" at ready deadline now
  at="$(opened_at "$e")"
  ready=$((at + PRINT_DELAY + 3))
  deadline=$((at + PRINT_DELAY + PRINT_WINDOW))
  now="$(date -u +%s)"
  if (( now < ready )); then
    log "epoch $e opened at $at; recordPrint at $ready (sleeping $((ready - now)) s)"
    sleep $((ready - now))
  fi
  while :; do
    if [[ "$(printed "$e")" != "0" ]]; then log "epoch $e already printed: $(printed "$e")"; return 0; fi
    now="$(date -u +%s)"
    if (( now > deadline )); then log "print window for epoch $e closed unprinted"; return 1; fi
    if send "$POINTER" "recordPrint(address,uint32)" "$WRAPPER" "$e"; then
      log "epoch $e print: $(printed "$e")"
      return 0
    fi
    log "recordPrint refused; retrying in 15 s"
    sleep 15
  done
}

log "watching $WRAPPER on pointer $POINTER as $ACCOUNT (every ${INTERVAL}s)"
while :; do
  r="$(regime || echo 0)"
  c="$(cap_now || echo 0)"
  o="$(is_open || echo unknown)"
  if [[ "$r" == "0" ]]; then
    : # MarketClock is stale (UNKNOWN): observe would be a no-op
  elif [[ "$c" != "0" && "$o" == "false" ]]; then
    log "capacity back (regime $r, cap $c): observe"
    if send "$POINTER" "observe(address)" "$WRAPPER"; then
      e="$(epoch_of)"
      if [[ "$(is_open)" == "true" && "$e" != "0" ]]; then
        print_epoch "$e" || true
        [[ $ONCE -eq 1 ]] && exit 0
      else
        log "observed open with no epoch (the pointer never saw this closure's shut)"
      fi
    fi
  elif [[ "$c" == "0" && "$o" == "true" ]]; then
    log "market shut (regime $r): observe to witness it"
    send "$POINTER" "observe(address)" "$WRAPPER" || true
  fi
  sleep "$INTERVAL"
done
