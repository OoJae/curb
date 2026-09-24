#!/usr/bin/env bash
# script/w4/credit.sh -- operator commands for the W4 CurbCredit / DepthCert demo.
#
# Every write is simulated first (eth_call from the signing address, with the Builder Code suffix already
# appended), then sent with
#     cast send --account "$ACCOUNT" --password-file "$PWFILE" --data <calldata ++ ERC-8021 suffix>
# The password file is only ever passed by path; its contents are never read or printed by this script.
#
# Usage: script/w4/credit.sh [--dry-run] <command> [args...]
#
#   status   [BORROWER] [ASSET]              read-only: reserve, ltvFor, realisable, regime, debt, limit, cure
#   approve  TOKEN SPENDER AMOUNT            ERC-20 approve (USDG to CREDIT for fund/repay, to DEPTH_CERT for post;
#                                            wrapper shares to CREDIT for deposit). AMOUNT 0 revokes.
#   fund     AMOUNT                          add USDG (6 dp units) to the reserve
#   deposit  ASSET SHARES                    post wrapper shares (18 dp wei) as collateral
#   withdraw ASSET SHARES
#   borrow   ASSET AMOUNT                    returns false + Refusal(...) rather than reverting on a refusal
#   repay    BORROWER ASSET AMOUNT
#   post     WRAPPER SIZE BIDPX EXPIRY BOND  DepthCert.post naming CREDIT (override with BENEFICIARY=0x..);
#                                            EXPIRY is unix seconds or +SECONDS from now; BIDPX in USDG units/share
#   take     CERT_ID SHARES TO               DepthCert.take (the fade demo)
#   flagBreach BORROWER ASSET
#   tick     BORROWER ASSET
#   liquidate BORROWER ASSET
#   realise  CERT_ID SHARES                  admin: sell seized shares into a cert naming CREDIT
#
# Amounts are integers in token units; scientific notation is fine (1.4e6 = 1.4 USDG, 0.05e18 = 0.05 shares).
#
# Env:
#   CREDIT      CurbCredit address (required)
#   DEPTH_CERT  DepthCert address (required for post/take)
#   ACCOUNT     Foundry keystore name (required to send; e.g. curb-desk)
#   PWFILE      path to that keystore's password file (required to send)
#   RPC_URL     default https://rpc.xlayer.tech
#   FROM        sender used for --dry-run simulation when no keystore is given (default: derived from ACCOUNT)
#
# --dry-run: builds the suffixed calldata, simulates it with eth_call, prints target + calldata, sends nothing.
#            (The printed calldata is also what the Agentic Wallet should submit for A's transactions.)
set -euo pipefail

SUFFIX="6464377535306e636b74356537323966100080218021802180218021802180218021" # ERC-8021, Builder Code dd7u50nckt5e729f
RPC_URL="${RPC_URL:-https://rpc.xlayer.tech}"
CHAIN_ID=196
DRY_RUN=0

die() { echo "credit.sh: $*" >&2; exit 1; }
log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
is_addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }
need_addr() { is_addr "${2:-}" || die "$1 must be a 0x address (got '${2:-}')"; }

sender() {
    if [[ -n "${FROM:-}" ]]; then
        echo "$FROM"
    elif [[ -n "${ACCOUNT:-}" && -n "${PWFILE:-}" ]]; then
        cast wallet address --account "$ACCOUNT" --password-file "$PWFILE"
    else
        echo "0x000000000000000000000000000000000000dEaD"
    fi
}

check_chain() {
    local id
    id=$(cast chain-id --rpc-url "$RPC_URL")
    [[ "$id" == "$CHAIN_ID" ]] || die "RPC is chain $id, expected $CHAIN_ID (X Layer)"
}

# send_tx TARGET CALLDATA LABEL
send_tx() {
    local target="$1" data="$2" label="$3" from tagged
    need_addr target "$target"
    [[ "$(cast code --rpc-url "$RPC_URL" "$target")" != "0x" ]] || die "$target has no code on chain $CHAIN_ID"
    tagged="${data}${SUFFIX}"
    from=$(sender)
    log "$label"
    log "  to       $target"
    log "  from     $from"
    log "  calldata $tagged"
    # Simulate exactly what will be signed (suffix included) from the signing address.
    if ! cast call --rpc-url "$RPC_URL" --from "$from" "$target" --data "$tagged" >/dev/null 2>"${TMPDIR:-/tmp}/credit-sim.$$"; then
        echo "  simulation reverted:" >&2
        sed 's/^/    /' "${TMPDIR:-/tmp}/credit-sim.$$" >&2
        rm -f "${TMPDIR:-/tmp}/credit-sim.$$"
        exit 2
    fi
    rm -f "${TMPDIR:-/tmp}/credit-sim.$$"
    log "  simulation ok"
    if [[ "$DRY_RUN" == 1 ]]; then
        log "  --dry-run: not sent"
        return 0
    fi
    [[ -n "${ACCOUNT:-}" ]] || die "ACCOUNT (keystore name) is required to send"
    [[ -n "${PWFILE:-}" && -r "$PWFILE" ]] || die "PWFILE must be a readable password file"
    local out
    out=$(cast send --rpc-url "$RPC_URL" --account "$ACCOUNT" --password-file "$PWFILE" --json "$target" --data "$tagged")
    log "  tx       $(jq -r '.transactionHash' <<<"$out")  status $(jq -r '.status' <<<"$out")  gas $(jq -r '.gasUsed' <<<"$out" | cast to-dec)"
    [[ "$(jq -r '.status' <<<"$out")" == "0x1" ]] || die "transaction failed"
}

call() { cast call --rpc-url "$RPC_URL" "$@"; }

credit() { [[ -n "${CREDIT:-}" ]] || die "set CREDIT to the CurbCredit address"; need_addr CREDIT "$CREDIT"; echo "$CREDIT"; }
depth() { [[ -n "${DEPTH_CERT:-}" ]] || die "set DEPTH_CERT to the DepthCert address"; need_addr DEPTH_CERT "$DEPTH_CERT"; echo "$DEPTH_CERT"; }

cmd_status() {
    local c b="${1:-}" a="${2:-}"
    c=$(credit)
    log "CurbCredit $c"
    log "  reserve (USDG units)  $(call "$c" 'reserve()(uint256)')"
    local assets
    assets=$(call "$c" 'assets()(address[])' | tr -d '[] ' | tr ',' ' ')
    for x in $assets; do
        if [[ -n "$a" ]] && [[ "$(lower "$x")" != "$(lower "$a")" ]]; then continue; fi
        log "  $x  open=$(call "$c" 'isOpen(address)(bool)' "$x")  ltvFor=$(call "$c" 'ltvFor(address)(uint256)' "$x")bps  realisable=$(call "$c" 'realisable(address)(uint256)' "$x")  totalColl=$(call "$c" 'totalCollateral(address)(uint256)' "$x")  totalPrincipal=$(call "$c" 'totalPrincipal(address)(uint256)' "$x")  seized=$(call "$c" 'seized(address)(uint256)' "$x")"
        if [[ -n "$b" ]]; then
            log "    $b  debt=$(call "$c" 'debtOf(address,address)(uint256)' "$b" "$x")  limit=$(call "$c" 'limitOf(address,address)(uint256)' "$b" "$x")  breached(known,breached)=$(call "$c" 'isBreached(address,address)(bool,bool)' "$b" "$x" | tr '\n' ' ')"
            log "    cure(active,lastOpen,openedAt,lastTickAt,used,priceAtBreach)=$(call "$c" 'cureOf(address,address)((bool,bool,uint64,uint64,uint64,uint128))' "$b" "$x")"
        fi
    done
}

expiry_of() {
    local e="$1"
    if [[ "$e" == +* ]]; then
        echo $(( $(date +%s) + ${e#+} ))
    else
        echo "$e"
    fi
}

main() {
    if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; shift; fi
    local cmd="${1:-}"
    [[ -n "$cmd" ]] || { sed -n '2,40p' "$0"; exit 1; }
    shift
    check_chain
    case "$cmd" in
        status) cmd_status "$@" ;;
        approve)
            [[ $# == 3 ]] || die "approve TOKEN SPENDER AMOUNT"
            need_addr TOKEN "$1"; need_addr SPENDER "$2"
            send_tx "$1" "$(cast calldata 'approve(address,uint256)' "$2" "$3")" "approve $2 for $3 of $1" ;;
        fund)
            [[ $# == 1 ]] || die "fund AMOUNT"
            send_tx "$(credit)" "$(cast calldata 'fund(uint256)' "$1")" "fund $1" ;;
        deposit)
            [[ $# == 2 ]] || die "deposit ASSET SHARES"
            need_addr ASSET "$1"
            send_tx "$(credit)" "$(cast calldata 'deposit(address,uint256)' "$1" "$2")" "deposit $2 of $1" ;;
        withdraw)
            [[ $# == 2 ]] || die "withdraw ASSET SHARES"
            need_addr ASSET "$1"
            send_tx "$(credit)" "$(cast calldata 'withdraw(address,uint256)' "$1" "$2")" "withdraw $2 of $1" ;;
        borrow)
            [[ $# == 2 ]] || die "borrow ASSET AMOUNT"
            need_addr ASSET "$1"
            local ok
            ok=$(call --from "$(sender)" "$(credit)" --data "$(cast calldata 'borrow(address,uint256)' "$1" "$2")${SUFFIX}" 2>/dev/null | cast to-dec 2>/dev/null || true)
            if [[ "$ok" == 1 ]]; then
                log "borrow would succeed"
            else
                log "borrow would be REFUSED: it emits Refusal and returns false; the tx still succeeds and leaves the trace"
            fi
            send_tx "$(credit)" "$(cast calldata 'borrow(address,uint256)' "$1" "$2")" "borrow $2 against $1" ;;
        repay)
            [[ $# == 3 ]] || die "repay BORROWER ASSET AMOUNT"
            need_addr BORROWER "$1"; need_addr ASSET "$2"
            send_tx "$(credit)" "$(cast calldata 'repay(address,address,uint256)' "$1" "$2" "$3")" "repay $3 for $1 on $2" ;;
        post)
            [[ $# == 5 ]] || die "post WRAPPER SIZE BIDPX EXPIRY BOND"
            need_addr WRAPPER "$1"
            local ben="${BENEFICIARY:-$(credit)}" exp
            need_addr BENEFICIARY "$ben"
            exp=$(expiry_of "$4")
            send_tx "$(depth)" "$(cast calldata 'post(address,address,uint128,uint128,uint64,uint128)' "$1" "$ben" "$2" "$3" "$exp" "$5")" \
                "post cert: $2 of $1 at $3/share for $ben, expiry $exp, bond $5" ;;
        take)
            [[ $# == 3 ]] || die "take CERT_ID SHARES TO"
            need_addr TO "$3"
            send_tx "$(depth)" "$(cast calldata 'take(uint256,uint128,address)' "$1" "$2" "$3")" "take cert $1 for $2 shares, proceeds to $3" ;;
        flagBreach|tick|liquidate)
            [[ $# == 2 ]] || die "$cmd BORROWER ASSET"
            need_addr BORROWER "$1"; need_addr ASSET "$2"
            send_tx "$(credit)" "$(cast calldata "${cmd}(address,address)" "$1" "$2")" "$cmd $1 on $2" ;;
        realise)
            [[ $# == 2 ]] || die "realise CERT_ID SHARES"
            send_tx "$(credit)" "$(cast calldata 'realise(uint256,uint256)' "$1" "$2")" "realise $2 seized shares into cert $1" ;;
        *) die "unknown command '$cmd' (see the header of $0)" ;;
    esac
}

main "$@"
