# Curb-controlled wallets

Published in advance, deliberately. Every address below is operated by the Curb team and must be
**excluded** from any claim about third-party usage, external underwriters, or independent borrowers.
OKX's judges read onchain data; the funding graph of every demo wallet is disclosed here before anyone
has to ask.

| role | address | purpose | privileges |
|---|---|---|---|
| deployer / admin | `0x78a5955b433988198bccA2E8bdC671444798f809` | deploys contracts; permanent admin | registers assets, grants/revokes attestors and keepers |
| attestor (cold spare) | `0x4c3eD38809FA6469871F4e0cbEa7ae7dBdA87fb8` | writes market regime to `MarketClock`; used only from the Mac if every host is down | `attest`, `attestBatch` only |
| attestor, host A | `0x842e9eeE514C419183Ca79D4cb0dc30ad29fEeC4` | live `MarketClock` writer on Railway `attestor-a` (Singapore); key generated inside the container, encrypted in its volume, never exported | `attest`, `attestBatch` only |
| attestor, host B | `0x50Fa162a1dE84D2719644DC45E44EC5D16e539fB` | standby writer and witness signer on `Sonar-VPS2` (Tencent, Silicon Valley). The key was generated inside the container and encrypted with a password generated on the box; neither ever left it. Enabled 14 Sep 20:02Z. | `attest`, `attestBatch` only |
| keeper (retired) | `0x4b150c0e37c9BFdb8B1FE4608A5465aE6B9a8669` | was to commit closure marks; never sent a transaction. Drained to the live keeper 21 Sep. | none — not a keeper on Scorecard v2 |
| revenue (payTo) | `0x277cA91276A3801667B76C97Da3872Ccb6E96068` | receives x402 payments for Curb's paid API on the OKX AI marketplace. Receive-only: it never signs, so its key lives only in an encrypted Foundry keystore on the team's Mac (`curb-revenue`) and on no server. Kept separate from every gas-paying wallet so that track-2 revenue is legible on its own on OKLink, and so "a wallet with no funding path to Curb paid us" can be checked by looking at one address. Created 24 Sept 2026. | none |
| curb-desk (demo counterparty) | `0xe1df35Af172E41D5A387D7e1b54A5Ab18b539A3E` | **team wallet**, created 24 Sept 2026 as an encrypted Foundry keystore on the team's Mac (`curb-desk`, password generated into `~/.foundry/curb-secrets/`, never printed). It is the ReopenNote seller, DepthCert maker and CurbCredit reserve funder in the live demos. Funded only from the team's Agentic Wallet below. Every demo it takes part in is between two team wallets and is presented as a demonstration of the mechanism, **never** as third-party usage. | none on Curb contracts |
| OKX marketplace identity (Agentic Wallet) | `0x055ba8acd60a2287b2d01cb3bf237e4424357105` | the team's OKX Agentic Wallet (email login, key held in OKX's TEE, not by Curb). Owns Curb's ASP identity on the OKX AI marketplace, agent **#13869**, registered 24 Sept 2026 in [`0xe2420407…ccc7`](https://www.oklink.com/xlayer/tx/0xe2420407a65b51a468f060a52496e15587ce13d1c23fccff30330d8ab293ccc7). Any paid call it makes to Curb's API is a **team wallet paying the team**: it proves the payment rail works, and is never presented as third-party usage. | none on Curb contracts |
| OKX developer identity | `0xacaf4f0b077879ae36338e00f8d460c0e389e490` | the team's own MetaMask wallet, connected to the OKX dev portal on 22 Sept; manages Curb's OKX API keys and owns Builder Code `dd7u50nckt5e729f` (payout address for any Builder Code rewards). Funded by the team directly, not from any Curb wallet. | none on Curb contracts |
| keeper, live | `0xd3D9Bf9Ff2A80Aa13D9C0299fadc9775343a1AF6` | commits closure marks to `Scorecard v2` and settles them, from `curb-keeper` on `Sonar-VPS2`. Key generated inside the container, encrypted with a password generated on the box; neither ever left it. Enabled 21 Sep 14:28Z. | `commit` only (`settle` is permissionless) |

Chain: X Layer mainnet, chain ID 196.

## Funding graph

| date | from | to | amount | tx |
|---|---|---|---|---|
| 2026-09-13 | OKX exchange withdrawal (team) | deployer | 0.105418 OKB | inbound native transfer |
| 2026-09-13 | deployer | attestor | 0.05 OKB | [`0x0fc906b3…ba2a5`](https://www.oklink.com/xlayer/tx/0x0fc906b36b8cab73793227ffc71d1a4b542fb8c6f44ae95a8ea56e6e64fba2a5) (block 70,543,707) |
| 2026-09-13 | deployer | keeper | 0.02 OKB | [`0x966f7882…8ed5`](https://www.oklink.com/xlayer/tx/0x966f7882f0e9dafd33ca320afd1d0f62fffe37cbe8f27dbcdb1227afef798ed5) (block 70,543,716) |
| 2026-09-14 | team, via contract `0xccc88a9d1b4ed6b0eaba998850414b24f1c315be` (internal transfer; relayed by `0xf70da978…dbef`, selector `0x0a2b8f36`) | host A | 0.04339953752875328 OKB | [`0x5fdc5f6a…c6af`](https://www.oklink.com/xlayer/tx/0x5fdc5f6a3163b3eeb7287a7913e08791b18c632cd2062ac108ba908cf904c6af) (block 70,617,100) |
| 2026-09-14 | attestor (cold spare) | host A | 0.04 OKB | [`0x2dbebb58…b793`](https://www.oklink.com/xlayer/tx/0x2dbebb58d50fe775f4d058788725f48ec00413aaa3c32cd9fe4c828e9abcb793) (block 70,617,162) |
| 2026-09-14 | deployer | host B | 0.02 OKB | [`0x60db8141…d205`](https://www.oklink.com/xlayer/tx/0x60db81418d8b9122261f61b2d1b80a2aa59a9dd6f344a90b7f0764f82122d205) (block 70,647,370) |
| 2026-09-21 | deployer | host B | 0.012 OKB | [`0x814729a7…6895`](https://www.oklink.com/xlayer/tx/0x814729a7a735e26630b8727a5f8b014da91ce56ce089a7c2ce5bbef0a1066895) (block 71,217,976) — top-up to clear 6 Oct |
| 2026-09-21 | keeper (retired) | keeper, live | 0.019 OKB | [`0x4cf89f5e…9852`](https://www.oklink.com/xlayer/tx/0x4cf89f5e2ee5d6c918e92afa89d05679bbfd15f7e6bedcb97cde4a67cb849852) (block 71,232,127) — consolidating a superseded wallet rather than stranding it |

**Gas economics, so nobody over-funds these wallets.** At 0.02 gwei flat and ~253k gas, one round costs
**0.0000051 OKB (~$0.0006 at $115/OKB)**; a full day of continuous writing is **~0.0014 OKB (~$0.16)**.
Host A therefore holds ~52 days and host B ~22 days of *worst-case* writing (B spends nothing unless it
takes over, and has spent nothing so far). The original contract deploys — two contracts, nine
transactions — cost 0.0000578 OKB in total, about half a cent. On 13–14 Sep the five wallets then in use held ~$16 together.

**The live keeper was funded from the retired keeper, not the deployer.** The deployer held only
0.0033 OKB after the Scorecard v2 deploy — too little — while the 13 Sep keeper wallet still held its
full 0.02 OKB and had never sent a transaction. One row costs **~0.00001 OKB (~$0.0012)** for the
commit and settle together, so 0.019 OKB is roughly **1,900 rows**, against an expected ~8 a day.

Host B was funded from the deployer, not the spare attestor: the spare held 0.009999 OKB after funding host A,
too little for 0.02 plus gas. It keeps that balance for emergency rounds (~0.0000054 OKB each).

The 0.0434 OKB transfer is a **contract-internal transfer**, not a top-level transaction, so a scan of
`tx.to` misses it. Its source was found by binary-searching host A's balance: 0 at block 70,617,099,
non-zero at 70,617,100. Its odd amount matches a bridge or swap payout, not a typed number.

### curb-desk gas — 24 Sept 2026

| from | to | amount | tx |
|---|---|---|---|
| deployer `0x78a5…f809` | curb-desk `0xe1df…9A3E` | 0.0008 OKB (gas only) | `0xc404ec8fb86d2ced41c2369ab0ea72f52e04fcd8bd28e23a88df400eaca3f480` (block 71,505,855) |

curb-desk's USDG and wTCENTx come only from the team's Agentic Wallet (below); every demo counterparty
pair is team ↔ team.

### Demo funding — 24 Sept 2026 (~$51, sent by the team from its OKX exchange account)

| step | wallet | detail | tx |
|---|---|---|---|
| inbound | Agentic Wallet | 0.428 OKB withdrawn from the team's OKX exchange account | inbound native transfer |
| swap | Agentic Wallet | 0.25 OKB → 29.832 USDG (OKX DEX aggregator) | `0xe7d469d4e23f3d7d13425fa0da222a9d63e16e348a5936880d09c903efccd777` |
| swap | Agentic Wallet | 0.15 OKB → 0.31839 wTCENTx | `0xee7b3dbdf6c89eb50777d85ca498deaef1b763b4e3f1877364c34d88e456119d` |
| swap | Agentic Wallet | 0.025 OKB → 0.01328 wNVDAx | `0xe31df80f59d3a37b7a5ae4722546951662dfcd7ce08976c70e5c67a6e9c74177` |
| transfer | Agentic Wallet → curb-desk | 20 USDG | `0x1be006cc9b8abf71982c4c4836eed1c23f304932c2bd41c9cea2ac8b0fa0074c` |
| transfer | Agentic Wallet → curb-desk | 0.1 wTCENTx | `0x7afc67e4b29ac129dd3dc1212c392d14852afe4c2d9d191f43e1e76e94d8eae6` |

**Rebalancing for cycle 2 and the fade demo, 24 Sep ~21:15Z** (no new money: team wallet to team wallet).

| step | wallet | detail | tx |
|---|---|---|---|
| transfer | curb-desk → Agentic Wallet | 3 USDG, so A can bid on cycle 2's lot | `0x66de800918580f8f8653bb5a3eeee3f8bb8cf66876ca63c17607cd75c9b8a61a` (block 71,515,480) |
| transfer | Agentic Wallet → curb-desk | 0.1 wTCENTx, for K to mint cycle 2's note (A cannot list: listing needs `setApprovalForAll`, which the Agentic Wallet does not grant) | `0xd6b05e0158eff1dba034aabaa36fe6ea45c3cb01dfa1fb94d63148990791e001` (block 71,515,517) |
| transfer | curb-desk → deployer | 2 USDG, the fade demo's bond (D is the fading maker) | `0x6efcb6e99afd5bf67d0ac3ad5d74e30fcb499f604bad65c2b05fad2bf30b6bb0` (block 71,515,679) |
| transfer | curb-desk → deployer | 2 USDG more, sent by mistake (a retry of the line above whose output was lost); left with D, returned at cleanup | `0xaa52f33416d05d50ef0ea04385f27c9ccea1bea9bd36ead06a57672379974c32` (block 71,515,747) |

## Admin transactions

Every privileged call, signed by the deployer/admin from the team's Mac.

| date | call | tx |
|---|---|---|
| 2026-09-14 11:43:32Z | `MarketClock.setAttestor(0x842e…eEC4, true)` — enable host A | [`0x982af160…f817`](https://www.oklink.com/xlayer/tx/0x982af1608c30833a5cefedc9664033dc889162646da5d0f8c57f700fcc96f817) (block 70,617,176) |
| 2026-09-14 20:02:43Z | `MarketClock.setAttestor(0x50Fa…39fB, true)`: enable host B | [`0x90f87de8…de9a`](https://www.oklink.com/xlayer/tx/0x90f87de8fa1e7c79101996108a83012540d80c9e4c45b0a9210800956b71de9a) (block 70,647,127) |

Read back after the calls: `isAttestor(host A)` = true, `isAttestor(host B)` = true, `isAttestor(0x4c3e…)` = true
(kept as cold spare). Host B's `/healthz` then reported `armed: true`.

### Outreach sent from the deployer — 25 Sept 2026

Three zero-value messages (UTF-8 calldata, no Builder Code) to third-party LPs, as `docs/OUTREACH.md` requires. These
recipients are **not** Curb wallets; they are listed so nobody mistakes them for team addresses.

| to | tx |
|---|---|
| `0x12C41Db9BbC678b5707EEb81cE814fa23421C34d` | `0x72c40545155323601e8fb9b757a3d0e456a5eceff46569320cf94bda0c08352b` (block 71,577,123) |
| `0xb5240c4b1408A293F5aF3341E29Fcee67f5C7018` | `0x9882f1745f7f9bfd6c0fcf28843621d3e6ad3d415d9623cc34c2a27f413d2d43` (block 71,577,135) |
| `0x1Bb84BcF9852A63e2b95C660e4b6C1098Cc1236d` | `0xad83bcc0b1c62a37c473d6759b2a4394e7687c6fda87947dee525426f051f3a0` (block 71,577,153) |

## Key custody

- Encrypted Foundry keystores at `~/.foundry/keystores/curb-{deployer,attestor,keeper}` (`keeper` is the retired
  13 Sep wallet), outside this repo.
- Keystore passwords in `~/.foundry/curb-secrets/`, mode 600, outside this repo.
- Nothing secret is ever committed. `.gitignore` blocks keystores, password files and `.env`.

**On the shared VPS (`Sonar-VPS2`).** D-8 accepts a stated risk for host B's key: most other services on that box
run as root, and root can read its keystore and password. The same risk applies to the keeper key and to two of
the archive tokens, which sit on the same box:

- **Live keeper key** `0xd3D9…1AF6`: an encrypted keystore at `/var/lib/curb/keeper/keys/keeper.keystore.json`
  (the container's volume), and its password in the root-owned `0600` file `/etc/curb/keeper.secret.env`. Both
  were generated on the box and never left it. Host B's key is kept the same way (`/var/lib/curb/attestor-b`,
  `/etc/curb/attestor-b.secret.env`). A stolen keeper key can call only `Scorecard.commit`. The deployer can
  revoke it with `setKeeper(0xd3D9…1AF6, false)`, which stops new rows. Rows already committed stay in the
  record: anyone may settle them, and settled rows count in `skill()`.
- **Archive (R2) tokens.** Three Cloudflare account API tokens, one per writer. Each is scoped to Object Read &
  Write on bucket `curb-archive` only, with no bucket configuration rights, so none can lift a lock.
  - `curb-archive-a`: a Railway variable on `attestor-a` (host A), not on the VPS.
  - `curb-archive-b` and `curb-archive-keeper`: root-owned `0600` files `/etc/curb/attestor-b.r2.env` and
    `/etc/curb/keeper.r2.env` on the shared VPS.
  - The Mac keeps a `0600` copy in `~/.foundry/curb-secrets/` for the backfill.

  A leaked token cannot delete or overwrite anything under the locked `rounds/`, `marks/` and `witness/`
  prefixes. It can add new objects to the bucket, which `archive.curb.markets` serves, and rewrite the unlocked
  `index/`. The token list and the deleted superseded token are in `docs/DEPLOYMENTS.md`, "Publisher live".
