# Posting Curb's Aave post, step by step

The forum is https://governance.aave.com (a Discourse forum). The post is `docs/AAVE_ARFC.md`. Every forum setting
below was read from the forum itself on 25 Sept 2026 (`/site.json`, `/about.json`, its guidelines and recent topics).

## 1. Create your account (5 minutes)

1. Go to https://governance.aave.com and click **Sign Up** (top right). Email and password only; there is no
   Google, GitHub or wallet login on this forum.
2. Username: 3 to 20 characters. Use the real Curb identity, for example `curb_markets`. The forum rules forbid
   claiming affiliations you do not have.
3. Open the activation email ("Click here to activate your account"); check spam. No staff approval is needed.

## 2. Unlock links before you post (about 15 minutes)

Brand-new accounts may put only a few links in a post, and this post has 18. The limit disappears at trust level 1
("Basic"), which you earn by reading.

1. Log in and open these six topics, scrolling slowly to the bottom of each with the tab in front
   (15 minutes or more in total):
   - https://governance.aave.com/t/25427
   - https://governance.aave.com/t/25401
   - https://governance.aave.com/t/23175
   - https://governance.aave.com/t/25464
   - https://governance.aave.com/t/21113
   - https://governance.aave.com/t/25348
2. Open one more topic (the forum re-checks your level each time you open one).
3. Confirm: your profile's **Badges** tab shows **Basic**.

## 3. Copy the text (1 minute)

In Terminal:

```bash
cd "/Users/oluwademilade/Desktop/Okx Dev Day/curb" && sed -n '/^## Summary$/,/^Copyright and related rights waived/p' docs/AAVE_ARFC.md | pbcopy
```

This copies the body from "## Summary" to the CC0 line, and leaves out the title, the status line and the internal
notes. Copy it this way, not from a web page: the forum converts pasted formatting.

## 4. Post it (5 minutes)

1. Go to https://governance.aave.com/c/risk/general/12 and click **+ New Topic**. Check that the category reads
   **Risk > General** (there are three categories called "General"; it must be the one under Risk). No tags (the
   forum has none). Leave any link box empty.
2. Title (paste exactly):
   `[Discussion] A risk framework for tokenized equities on Aave V3 X Layer, with wTCENTx as the worked example`
   Why [Discussion] and not [ARFC]: under Aave's Governance Framework v2 an ARFC is a binding-vote stage opened by
   approved authors, and new listings come from the service providers. This post asks for no vote.
3. Click in the big text box and press **Cmd+V**.
4. Check the preview on the right: it starts with the "Summary" heading and ends with the CC0 line; three tables and
   two grey code blocks show; "$58,300" and "$50,000" are plain text (if one turns into a formula, put a backslash
   before that `$`); the GitHub links open.
5. Click **+ Create Topic**.
   - "new users can only put N links in a post": you are not at Basic yet. Your draft is kept; read a little more
     and try again. Do not remove the links.
   - "waiting for staff approval": wait; do not post it again.
6. Copy the topic's address and add it to `docs/SUBMISSION.md` (or send it to Claude to add).

## 5. After posting

- Replies are optional for the service providers (LlamaRisk is the one risk provider). Similar independent posts
  got 0 to 7 replies. Answer questions in the thread; use Like rather than "+1" replies.
- Small fixes: edits in the first 5 minutes leave no history; after that, post a reply for corrections.
- A [Discussion] post is not followed by a vote.
