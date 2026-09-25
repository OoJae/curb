#!/usr/bin/env bash
# Send the approved LP outreach (docs/OUTREACH.md, Variant C) as zero-value transactions with UTF-8 calldata,
# from the published deployer wallet. No Builder Code suffix: these are messages, not product transactions.
#
# Send-time guard (from the adversarial verification, 24 Sep): LPs are leaving fast, so immediately before each
# send the recipient must still own its evidence position, with liquidity > 0 and the pool's tick inside its
# range. A recipient that fails is dropped, never substituted on the fly.
#
#   bash script/outreach/send.sh [--dry-run]
set -uo pipefail

DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
ACCOUNT="${ACCOUNT:-curb-deployer}"
PWFILE="${PWFILE:-$HOME/.foundry/curb-secrets/curb-deployer.password}"
READ="https://xlayer.drpc.org"
SEND="https://rpc.xlayer.tech"
NPM=0x315e413A11AB0df498eF83873012430ca36638Ae
DEPTHCERT=0x702b1a988765f85162F4829175EF4232197e9C6D
TEMPLATE='Curb (curb.markets): DepthCert is live at %s. Post a bonded bid for %s shares; a faded fill is proved on chain and the bond goes to the taker. You LP this book. Interested? Reply here.'
# row | recipient | wrapper named | evidence tokenId | that position's pool
RECIPIENTS="
1|0x12C41Db9BbC678b5707EEb81cE814fa23421C34d|wTCENTx|46637|0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f
3|0xb5240c4b1408A293F5aF3341E29Fcee67f5C7018|wTCENTx|38240|0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f
7|0x7e349f84732Ee499a464d118d32635cBaFdfd189|wMEITx|46622|0x54E89e9acaFb073e7fd8471312E753A661b470C7
8|0x1Bb84BcF9852A63e2b95C660e4b6C1098Cc1236d|wTCENTx|44883|0xC89d8b547ceA7CdeAa7474E7a90B6baD01fE992f
9|0x1294394faCc6B4EEe808AeF886ee13eA590F8608|wXIAOx|37071|0xdc7f2F41B48cD4F482D8C900Ac2fA1B5aD058417
"

log() { printf '%s outreach: %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
rd() { cast call "$@" --rpc-url "$READ" 2>/dev/null || cast call "$@" --rpc-url "$SEND" 2>/dev/null; }
lc() { tr '[:upper:]' '[:lower:]'; }

printf '%s\n' "$RECIPIENTS" | while IFS='|' read -r row to wrapper tid pool; do
  [[ -z "$row" ]] && continue
  owner=$(rd $NPM 'ownerOf(uint256)(address)' "$tid")
  pos=$(rd $NPM 'positions(uint256)(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)' "$tid" | awk '{print $1}' | tr '\n' ' ')
  read -r _n _op t0 t1 _fee lo hi liq _ <<< "$pos"
  tick=$(rd "$pool" 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)' | sed -n 2p | awk '{print $1}')
  code=$(cast code "$to" --rpc-url "$READ" 2>/dev/null)
  if [[ "$(printf '%s' "$owner" | lc)" != "$(printf '%s' "$to" | lc)" ]]; then log "row $row DROPPED: token $tid now owned by $owner"; continue; fi
  if [[ -z "$liq" || "$liq" == "0" ]]; then log "row $row DROPPED: token $tid has no liquidity"; continue; fi
  if [[ -z "$tick" ]] || (( tick < lo || tick >= hi )); then log "row $row DROPPED: token $tid out of range (tick ${tick:-?} vs [$lo,$hi))"; continue; fi
  if [[ "$code" != "0x" ]]; then log "row $row DROPPED: recipient has code"; continue; fi
  msg=$(printf "$TEMPLATE" "$DEPTHCERT" "$wrapper")
  bytes=$(printf '%s' "$msg" | wc -c | tr -d ' ')
  (( bytes <= 240 )) || { log "row $row DROPPED: $bytes bytes"; continue; }
  data=$(cast from-utf8 "$msg")
  [[ "$(cast to-utf8 "$data")" == "$msg" ]] || { log "row $row DROPPED: calldata round-trip failed"; continue; }
  log "row $row $to: token $tid live (liq $liq, tick $tick in [$lo,$hi)), $bytes bytes, $wrapper"
  if (( DRY )); then log "  dry run: not sent"; continue; fi
  out=$(cast send "$to" "$data" --account "$ACCOUNT" --password-file "$PWFILE" --rpc-url "$SEND" --gas-limit 40000 2>&1)
  tx=$(printf '%s\n' "$out" | awk '$1 == "transactionHash" {print $2}')
  st=$(printf '%s\n' "$out" | awk '$1 == "status" {print $2}')
  blk=$(printf '%s\n' "$out" | awk '$1 == "blockNumber" {print $2}')
  if [[ -n "$tx" ]]; then log "  SENT row $row: tx $tx status $st block $blk"; else log "  send failed: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"; fi
done
