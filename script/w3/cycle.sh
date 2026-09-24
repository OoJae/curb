#!/usr/bin/env bash
# cycle.sh -- one W3 demo cycle, one transaction per subcommand, sent from a Foundry keystore.
#
#   approve  TOKEN SPENDER AMOUNT                 ERC-20 approve (TOKEN: wtcentx|usdg|0x..; SPENDER: note|auction|0x..)
#   mint     AMOUNT [TO]                          ReopenNote.mint(WRAPPER, AMOUNT, TO=FROM)
#   setApprovalForAll [OPERATOR] [true|false]     ReopenNote.setApprovalForAll(OPERATOR=auction, true)
#   list     NOTE_ID AMOUNT START FLOOR DECAY END_AT
#                                                 ClosedAuction.list; END_AT is unix seconds or +SECONDS from now
#   bid      LOT_ID MAX_PRICE                     ClosedAuction.bid
#   redeem   NOTE_ID AMOUNT [TO]                  ReopenNote.redeem(NOTE_ID, AMOUNT, TO=FROM)
#   withdraw LOT_ID                               ClosedAuction.withdraw
#   status   LOT_ID                               read-only: lot, current price, realisedDiscountBps
#
# Units are raw integers: note/wrapper amounts in share wei (0.1 wTCENTx = 100000000000000000), prices in
# USDG units (6 dp: 5.60 USDG = 5600000).
#
# Every transaction carries the ERC-8021 Builder Code: data = `cast calldata ...` || SUFFIX, sent with
# `cast send <to> <data>`. With --dry-run nothing is signed or sent: it prints `to` and the tagged `data`
# (which can also be handed to a wallet that is not a Foundry keystore, such as the Agentic Wallet).
# Passwords and keys are never printed: cast reads the password from $PWFILE itself.
#
# Env: NOTE, AUCTION (deployed W3 addresses; required), ACCOUNT (keystore name, default curb-desk),
#      FROM (that keystore's address, default the curb-desk wallet; checked against the keystore before sending),
#      PWFILE (required unless --dry-run), WRAPPER (default wTCENTx), RPC (default https://rpc.xlayer.tech).
set -euo pipefail

RPC="${RPC:-https://rpc.xlayer.tech}"
WRAPPER="${WRAPPER:-0x41333Df9E7639188BBfca5522dC4844398Af9f9E}"
USDG="${USDG:-0x4ae46a509F6b1D9056937BA4500cb143933D2dc8}"
ACCOUNT="${ACCOUNT:-curb-desk}"
FROM="${FROM:-0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E}"
SUFFIX="6464377535306e636b74356537323966100080218021802180218021802180218021" # dd7u50nckt5e729f, ERC-8021 schema 0

DRY_RUN=0
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--dry-run" ]]; then DRY_RUN=1; else ARGS+=("$a"); fi
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

usage() { sed -n '2,24p' "$0"; exit "${1:-0}"; }
[[ $# -ge 1 ]] || usage 2
cmd="$1"; shift
[[ "$cmd" == "-h" || "$cmd" == "--help" ]] && usage 0

need() { local n; for n in "$@"; do [[ -n "${!n:-}" ]] || { echo "set $n" >&2; exit 2; }; done; }
nargs() { (( $1 >= $2 )) || { echo "$cmd: expected at least $2 argument(s)" >&2; usage 2; }; }

addr_of() { # alias -> address
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    wtcentx|wrapper) echo "$WRAPPER" ;;
    usdg) echo "$USDG" ;;
    note) need NOTE; echo "$NOTE" ;;
    auction) need AUCTION; echo "$AUCTION" ;;
    0x*) echo "$1" ;;
    *) echo "unknown address alias: $1" >&2; exit 2 ;;
  esac
}

checked=0
check_account() { # the keystore must be the address we pay from / mint to
  [[ $checked -eq 1 ]] && return 0
  need PWFILE
  [[ -r "$PWFILE" ]] || { echo "PWFILE is not readable" >&2; exit 2; }
  local who
  who="$(cast wallet address --account "$ACCOUNT" --password-file "$PWFILE")"
  if [[ "$(printf '%s' "$who" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$FROM" | tr '[:upper:]' '[:lower:]')" ]]; then
    echo "keystore $ACCOUNT is $who, not FROM=$FROM" >&2
    exit 2
  fi
  checked=1
}

send() { # send <to> <sig> [args...]
  local to="$1"; shift
  local data
  data="$(cast calldata "$@")$SUFFIX"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf 'to:   %s\ncall: %s\ndata: %s\n' "$to" "$*" "$data"
    return 0
  fi
  check_account
  printf 'sending %s to %s as %s\n' "$1" "$to" "$ACCOUNT"
  cast send "$to" "$data" --account "$ACCOUNT" --password-file "$PWFILE" --rpc-url "$RPC" \
    | awk '$1 == "transactionHash" || $1 == "status" || $1 == "blockNumber" || $1 == "gasUsed"'
}

case "$cmd" in
  approve)
    nargs $# 3
    send "$(addr_of "$1")" "approve(address,uint256)" "$(addr_of "$2")" "$3"
    ;;
  mint)
    nargs $# 1; need NOTE
    send "$NOTE" "mint(address,uint128,address)" "$WRAPPER" "$1" "${2:-$FROM}"
    ;;
  setApprovalForAll|setapprovalforall)
    need NOTE
    send "$NOTE" "setApprovalForAll(address,bool)" "$(addr_of "${1:-auction}")" "${2:-true}"
    ;;
  list)
    nargs $# 6; need AUCTION
    end="$6"
    if [[ "$end" == +* ]]; then end=$(( $(date -u +%s) + ${end#+} )); fi
    send "$AUCTION" "list(uint256,uint128,uint128,uint128,uint32,uint64)" "$1" "$2" "$3" "$4" "$5" "$end"
    ;;
  bid)
    nargs $# 2; need AUCTION
    send "$AUCTION" "bid(uint256,uint256)" "$1" "$2"
    ;;
  redeem)
    nargs $# 2; need NOTE
    send "$NOTE" "redeem(uint256,uint128,address)" "$1" "$2" "${3:-$FROM}"
    ;;
  withdraw)
    nargs $# 1; need AUCTION
    send "$AUCTION" "withdraw(uint256)" "$1"
    ;;
  status)
    nargs $# 1; need AUCTION
    echo "lot $1 (seller, wrapper, noteId, amount, start, floor, ref, startAt, endAt, decay, epochAtMint, status, buyer, cleared, clearedAt):"
    cast call "$AUCTION" \
      "lotOf(uint256)((address,address,uint256,uint128,uint128,uint128,uint128,uint64,uint64,uint32,uint32,uint8,address,uint128,uint64))" \
      "$1" --rpc-url "$RPC"
    printf 'currentPrice: '; cast call "$AUCTION" "currentPrice(uint256)(uint256)" "$1" --rpc-url "$RPC" || true
    printf 'realisedDiscountBps: '
    cast call "$AUCTION" "realisedDiscountBps(uint256)(int256)" "$1" --rpc-url "$RPC" 2>/dev/null \
      || echo "not yet (unsold, or the reopen is not printed)"
    ;;
  *)
    echo "unknown subcommand: $cmd" >&2
    usage 2
    ;;
esac
