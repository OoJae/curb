# Repository hygiene audit, before the repo goes public

**Audited 24 Sept 2026, 13:40–14:00Z, by the records lane.** Nothing was rewritten. Every fix below is a
recommendation, and the lead decides.

**Scope.** Every commit reachable from any ref at audit time: `main`, `origin/main` and all agent worktree
branches. That is 49 commits from `cc03fa7` (21 Sept) onward: 13 on `main` up to `b70a75f`, plus the lane
commits that followed. The full patch text (`log -p --all`, about 4.8 MB) was scanned, and every object in the
object store was sized. There are no deletions or renames anywhere in history, so the tree at each tip already
shows everything ever committed. Lanes are still committing: re-run the scan (bottom of this file) on the final
`main` before the repo is made public.

## Result

**No secret was found in the history.** No private key, mnemonic, keystore, password, API key, bearer token,
healthchecks ping URL, `.env` content, OKX API key (the prefix was searched in any case: zero hits), or R2/S3
credential was committed.

There is **one medium finding (a second personal email address in commit metadata)**, one low finding, and
housekeeping items.

| id | severity | finding | where |
|---|---|---|---|
| H-1 | **medium** | Commit metadata exposes a second personal email address | author and committer of every commit from `474e820` onward |
| H-2 | low | Absolute local paths reveal the macOS username and names of unrelated local projects | `docs/specs/brand-site-video.md` (`b70a75f`); `artifacts/w0/local/stopgap.log` line 1 (`cc03fa7`); `artifacts/w5/invariants-note.txt` (`a25aa2d`) |
| H-3 | info | `.gitignore` misses secret-file names the deploy scripts actually use | `.gitignore` |
| H-4 | info | Test fixtures and vendored code that any secret scanner will flag, all public or fake | see list |
| H-5 | info | Infrastructure identifiers published on purpose | `docs/DEPLOYMENTS.md`, `script/hostb/deploy.sh` |
| H-6 | info | The repo is not public yet, and there is no top-level LICENSE | GitHub, repo root |

## H-1: a second personal email address in commit metadata (medium)

The first 11 commits (`cc03fa7` … `d3bfc40`, all of them on `origin/main`) are authored and committed as
**`Curb <the user's olamiye… gmail address>`**. Every commit from `474e820` (24 Sept 11:44Z) onward uses **`OoJae
<c…550@gmail.com>`**, a different personal gmail address, in both the author and committer fields. The full
address is withheld from this file on purpose, so that the file does not publish it again. At audit time that
covered 38 commits. It includes every lane commit, because agent worktrees inherit the global identity from
`~/.gitconfig`.

**Why it matters.** Anyone can read commit metadata in a public repo (`git log`, the GitHub UI and the API), and
it cannot be deleted afterwards without rewriting history. If the second address is not meant to be public, now
is the cheap moment:

- **None of the affected commits was on `origin/main` at audit time** (`origin/main` = `d3bfc40`, and local `main`
  was 20 commits ahead). The repo also answered 404 to an anonymous GitHub request. So the history can be fixed
  without force-pushing anything anyone else holds.

**Recommended fix (the lead decides):**

1. Decide the public identity. Either keep the `Curb <…>` identity the first 11 commits use, or switch to a
   GitHub `noreply` address for everything.
2. Stop it spreading: set that identity in the **repo-local** config of the main checkout
   (`git config user.name …; git config user.email …`). Every lane that merges should commit with it too. The
   records lane's own commits (README, SUBMISSION, DECISIONS, OUTREACH, ARFC, HYGIENE) already use the `Curb`
   identity.
3. Optionally, **before the first push of these commits**, re-author the unpushed range onto `origin/main`,
   keeping merges. For example: `git rebase -r origin/main --exec 'git commit --amend --no-edit --reset-author'`,
   run with the intended identity set in step 2. Check the committer field as well as the author field.
4. **If step 3 happens, every commit hash after `d3bfc40` changes.** README.md and docs/SUBMISSION.md cite
   `474e820`, `b70a75f` and `0995f72`. Re-map them, which the submission checklist already asks for.

If the second address is fine to publish, there is nothing to do beyond step 2 for consistency.

## H-2: local absolute paths (low)

- `docs/specs/brand-site-video.md`, in the video section (commit `b70a75f`), gives two absolute paths to other
  local projects, `…/Desktop/Hookathon/videos/hindsight-demo/` and `…/Desktop/blastradius-video/capture-lib.mjs`,
  both under `/Users/<local user>/`.
- `artifacts/w0/local/stopgap.log`, line 1 (commit `cc03fa7`), records the observer's absolute output path
  under `/Users/<local user>/Desktop/…`.
- `artifacts/w5/invariants-note.txt` (commit `a25aa2d`, the P1 invariant output) quotes a forge warning that
  holds the absolute path of an agent worktree's `cache/` directory. Future `artifacts/w5/*` outputs will do the
  same unless the paths are stripped before committing.

These reveal the local username and the names of unrelated projects. They carry no credentials. **Fix without
rewriting:** replace them with relative paths or placeholders in an ordinary commit. The copy in old history then
remains, which is acceptable at this severity. `artifacts/w0/local/stopgap.log` is evidence, so edit it only if
the edit is disclosed, or leave it as is.

## H-3: `.gitignore` gaps (info)

`.gitignore` blocks `.env`, `.env.*`, `*.password`, `*keystore*` and `curb-secrets/`. It does **not** match the
secret-file names the deploy scripts and docs actually use: `okx-api.env`, `attestor-b.alerts.env`,
`keeper.alerts.env`, `keeper.secret.env`, `w0-observer.alerts.env`. `.env.*` only matches names that *start* with
`.env.`. Nothing like this has ever been committed. But one careless `cp /etc/curb/keeper.alerts.env .` followed
by `git add -A` would publish a live healthchecks ping URL. **Fix:** add these lines.

```
*.env
!.env.example
*.secret.env
```

The uncommitted `.claude/` ignore rule seen in the main checkout has since landed in `dfd30b4`. Keep it, because
agent worktrees live under `.claude/worktrees/`.

## H-4: things that look like secrets and are not (info)

Any scanner, such as gitleaks or GitHub secret scanning, will flag these. All of them are public test vectors,
upstream defaults or deliberate fakes. Allowlist them rather than "fixing" them:

- `lib/forge-std`, vendored: the public Anvil test mnemonic (`test test … junk`) and its well-known key
  `0xac09…ff80`, and forge-std's default Sepolia Infura key `b9794ad1…2001`.
- `services/attestor/src/tx/sender.test.ts`: `"a-long-sealed-variable-password-for-tests"`.
- `services/asp` tests: `key-DO-NOT-LEAK-1`, `secret-DO-NOT-LEAK-2`, `pass-DO-NOT-LEAK-3`, and
  `https://…/v2/SECRET_KEY_abc123`. These exist to prove the service never echoes a credential.
- The archive-publisher lane (commit `66d7b89`, on a branch at audit time): AWS's documentation example key pair
  (`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`), the AWS SigV4 test-suite vectors, and
  `s3cr3t-DO-NOT-LEAK-…` / `akid-0123456789abcdef` fakes.
- `services/asp/src/fixtures/*.asset.json`: issuer asset UUIDs, which are public API ids.

## H-5: infrastructure identifiers published on purpose (info)

None of these is a credential. Each one tells a reader something about the infrastructure, which D-8 and
`docs/DEPLOYMENTS.md` already accept in exchange for verifiability. Listed so the choice is explicit:

- The Cloudflare account id inside the R2 S3 endpoint (`docs/DEPLOYMENTS.md`, and the publisher lane's tests). It
  is not a secret, but it helps reconnaissance. It is optional to redact in docs.
- The Railway CNAME target `i9sejppz.up.railway.app`, which is public DNS anyway.
- The VPS SSH alias `Sonar-VPS2`, and the paths of secret files on it (`/etc/curb/*.env`,
  `~/.foundry/curb-secrets/okx-api.env`): names only. **No IP address of the VPS appears anywhere in history.**
  The only IPv4 literals are `127.0.0.1` and Vercel's public `76.76.21.21`.
- D-8's disclosure that host B shares a VPS whose other services run as root. That is an accepted risk, stated
  deliberately.

## H-6: before going public (info)

- `https://github.com/OoJae/curb` returned **404** to an anonymous request on 24 Sept. The submission requires a
  public repo. Settle H-1 first, then flip visibility.
- There is **no top-level LICENSE file.** Every Solidity file in `src/` carries `SPDX-License-Identifier: MIT`,
  but `services/`, `tools/` and `web/` have no licence statement, so they are "all rights reserved" by default.
  If they are meant to be open, add a LICENSE file (MIT, matching `src/`).

## Checked and clean

| check | result |
|---|---|
| Private keys (`--private-key`, `KEY=0x…64`, PEM blocks, keystore JSON `ciphertext`/`kdfparams`) | none, apart from forge-std's public test key (H-4) |
| Mnemonics / seed phrases | none, apart from forge-std's public test mnemonic |
| Passwords or passphrases assigned a literal | none, apart from test fakes (H-4). Keystore passwords are generated on the box and never printed (`script/hostb/deploy.sh`). |
| OKX API credentials; the OKX key prefix searched case-insensitively | none. `.railway/railway.ts` names the three variables with `preserve()` and no values. |
| Bearer / JWT / GitHub / Slack / Telegram / `sk-` tokens | none |
| healthchecks.io ping URLs (`hc-ping.com/<uuid>`) | none. Only the product name, and empty `HC_URL=` templates. |
| R2 / S3 access keys or secrets | none, apart from AWS doc examples and fakes (H-4). R2 tokens did not exist when the history was written. |
| `.env` content | only `.env.example` (public RPC URL and chain id) |
| `artifacts/w0/*.log` and `*.jsonl` | `observer.log`: one line, the 12 Sept TCENTx closed observation. `local/stopgap.log` (181 lines) and the `*.jsonl` files: issuer API observations (public data), `hc: false`, and five "connection reset" errors. No tokens, IPs or credentials. Only H-2's path. |
| `broadcast/` | deploy transactions only. No RPC URLs with keys, and no local paths. |
| Large files | none. The largest blob is 409 KB (`lib/forge-std/src/safeconsole.sol`). Largest of our own: `artifacts/w0/local/stopgap.log` at 229 KB, and web preview PNGs up to 135 KB. The object store holds about 4 MB of blobs in total. |
| Committed `node_modules`, `out/`, `cache/`, key or certificate files | none |
| Email addresses in file *content* | none of ours. Only forge-std's upstream maintainer address and a test fixture `KEY_IN_USERINFO@rpc.example`. |

## Reproduce

Run from a checkout of the final `main`:

```bash
git log -p --all --no-color --format='COMMIT %H %an <%ae> %s' --output=/tmp/curb-logp.txt
grep -n -i -E 'f8728dba|hc-ping|kdfparams|ciphertext|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_|sk-[A-Za-z0-9_-]{20,}' /tmp/curb-logp.txt
grep -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' /tmp/curb-logp.txt | sort | uniq -c
git log --all --format='%h %an <%ae> | %cn <%ce>' | sort -k2 | uniq -c -f1
git cat-file --batch-check='%(objecttype) %(objectsize) %(objectname)' --batch-all-objects | sort -k2 -n | tail
git log --all --diff-filter=DR --name-status
# a second opinion, if installed:  gitleaks detect --log-opts="--all"
```
