#!/usr/bin/env bash
# script/w4/tick.sh -- the cure-clock keeper for CurbCredit.
#
# Every INTERVAL seconds (default 300), for each BORROWER ASSET pair with an active cure, sends
#     CurbCredit.tick(borrower, asset)
# as calldata ++ the ERC-8021 Builder Code suffix, via
#     cast send --account "$ACCOUNT" --password-file "$PWFILE"
# after simulating it (eth_call, suffix included) from the signing address. `tick` is permissionless.
#
# Why every 5 minutes: the cure clock only counts a gap between two ticks if the market was open at both and the
# gap is at most MAX_TICK_GAP (600 s). A keeper that misses a round loses that gap -- it never over-counts -- so
# 300 s leaves one missed round of slack. Pairs without an active cure are skipped (tick would revert NoCure).
#
# Usage: script/w4/tick.sh [--dry-run] [--once] BORROWER ASSET [BORROWER ASSET ...]
#
# Env:
#   CREDIT    CurbCredit address (required)
#   ACCOUNT   Foundry keystore name (required unless --dry-run)
#   PWFILE    path to that keystore's password file (required unless --dry-run); never read or printed here
#   RPC_URL   default https://rpc.xlayer.tech
#   INTERVAL  seconds between rounds, default 300
#   FROM      sender for --dry-run simulation (default: derived from ACCOUNT, else a placeholder)
set -euo pipefail

SUFFIX="6464377535306e636b74356537323966100080218021802180218021802180218021" # ERC-8021, Builder Code dd7u50nckt5e729f
RPC_URL="${RPC_URL:-https://rpc.xlayer.tech}"
INTERVAL="${INTERVAL:-300}"
CHAIN_ID=196
DRY_RUN=0
ONCE=0

die() { echo "tick.sh: $*" >&2; exit 1; }
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
is_addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --once) ONCE=1; shift ;;
        -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
        *) break ;;
    esac
done

[[ $# -ge 2 && $(( $# % 2 )) -eq 0 ]] || die "usage: tick.sh [--dry-run] [--once] BORROWER ASSET [BORROWER ASSET ...]"
PAIRS=("$@")
for x in "${PAIRS[@]}"; do is_addr "$x" || die "not an address: $x"; done
[[ -n "${CREDIT:-}" ]] && is_addr "$CREDIT" || die "set CREDIT to the CurbCredit address"
[[ "$INTERVAL" =~ ^[0-9]+$ && "$INTERVAL" -ge 30 && "$INTERVAL" -le 600 ]] || die "INTERVAL must be 30..600 seconds"
if [[ "$DRY_RUN" == 0 ]]; then
    [[ -n "${ACCOUNT:-}" ]] || die "ACCOUNT (keystore name) is required unless --dry-run"
    [[ -n "${PWFILE:-}" && -r "$PWFILE" ]] || die "PWFILE must be a readable password file unless --dry-run"
fi

id=$(cast chain-id --rpc-url "$RPC_URL")
[[ "$id" == "$CHAIN_ID" ]] || die "RPC is chain $id, expected $CHAIN_ID (X Layer)"
[[ "$(cast code --rpc-url "$RPC_URL" "$CREDIT")" != "0x" ]] || die "CREDIT $CREDIT has no code on chain $CHAIN_ID"

if [[ -n "${FROM:-}" ]]; then
    SENDER="$FROM"
elif [[ -n "${ACCOUNT:-}" && -n "${PWFILE:-}" ]]; then
    SENDER=$(cast wallet address --account "$ACCOUNT" --password-file "$PWFILE")
else
    SENDER="0x000000000000000000000000000000000000dEaD"
fi
log "keeper $SENDER  credit $CREDIT  interval ${INTERVAL}s  pairs $(( ${#PAIRS[@]} / 2 ))  dry-run $DRY_RUN"

# cureOf -> "(active, lastOpen, openedAt, lastTickAt, openSecondsUsed, priceAtBreach)"
cure_of() {
    cast call --rpc-url "$RPC_URL" "$CREDIT" 'cureOf(address,address)((bool,bool,uint64,uint64,uint64,uint128))' "$1" "$2" \
        | tr -d '()' | sed 's/\[[^]]*\]//g' | tr -d ' '
}

tick_pair() {
    local b="$1" a="$2" cure active used open data out
    if ! cure=$(cure_of "$b" "$a"); then
        log "$b/$a: cureOf read failed; skipping this round"
        return 0
    fi
    active=$(cut -d, -f1 <<<"$cure")
    used=$(cut -d, -f5 <<<"$cure")
    if [[ "$active" != "true" ]]; then
        log "$b/$a: no active cure"
        return 0
    fi
    open=$(cast call --rpc-url "$RPC_URL" "$CREDIT" 'isOpen(address)(bool)' "$a" || echo "?")
    data="$(cast calldata 'tick(address,address)' "$b" "$a")${SUFFIX}"
    if ! cast call --rpc-url "$RPC_URL" --from "$SENDER" "$CREDIT" --data "$data" >/dev/null 2>&1; then
        log "$b/$a: tick simulation reverted (cure cleared or liquidated in between?); skipping"
        return 0
    fi
    if [[ "$DRY_RUN" == 1 ]]; then
        log "$b/$a: open=$open used=${used}s/1800 -- would send tick, calldata $data"
        return 0
    fi
    if ! out=$(cast send --rpc-url "$RPC_URL" --account "$ACCOUNT" --password-file "$PWFILE" --json "$CREDIT" --data "$data" 2>&1); then
        log "$b/$a: send failed: $(tr '\n' ' ' <<<"$out" | cut -c1-300)"
        return 0
    fi
    cure=$(cure_of "$b" "$a" || echo "?")
    log "$b/$a: open=$open tx $(jq -r '.transactionHash' <<<"$out") status $(jq -r '.status' <<<"$out") cure now ($cure)"
}

while true; do
    for (( i = 0; i < ${#PAIRS[@]}; i += 2 )); do
        tick_pair "${PAIRS[i]}" "${PAIRS[i+1]}"
    done
    [[ "$ONCE" == 1 ]] && break
    sleep "$INTERVAL"
done
