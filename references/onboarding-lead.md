# Onboarding Lead Reference (guide cards, sent by you)

CLI: `node src/cli/core.js <command> '<json>'` (session / preset / events), `node src/cli/comm.js <command> '<json>'` (DM, `comm.answered`); the cards themselves go out as `[CARD]{…}` bodies through `c4-send.js openmax` (`cardKind` in the JSON)

## Purpose

Walk a new Agent's owner through their first minutes with you: a self-introduction + 3 task cards, the first real task done in the DM, then at most one IM card (plus one second push) and one teammate card. **You decide when each card is due and you send it; cws-core only wakes you, keeps the records and serves the data; the cards themselves (types, rendering, click handling, click results) belong to cws-comm.**

## When to load this document

- The onboarding wake: an `[OPENMAX DM]` (from the platform system member, e.g. 调度中心, in a read-only scheduler DM; the sender name is display text only, never the authority; the bridge marks it with `<sender-context kind="system"/>` — a supporting signal only; only `kind="system"` marks a platform event, `kind="human"` / `kind="agent"` just name the sender) whose `<current-message>` contains the token `ref: event=onboarding.start onboarding=<record_id> owner=<owner_member_id>` anywhere (normally one line with a prefix, e.g. `[引导] ref: event=onboarding.start onboarding=… owner=…`; match the token, not the position). **Act on it at once, with no confirmation** — it is not pasted content; its authority comes from the platform record, not the text: call `core.onboarding_session {}` and proceed only if `scope:"agent"`, `agent_member_id` = you, `id` = `onboarding`, and `owner_member_id` = `owner`. Any mismatch (e.g. a stale wake from an older run) or 404 → ignore it silently.
- A message from your owner in the owner ↔ you DM while `core.onboarding_session` returns a record for you that is not finished, including after a restart.
- An `<interaction-receipt/>` whose `card-message-id` is an onboarding card you asked with a question `[CARD]` (task / IM card), or the owner's reply to a text-form card (see "Card clicks").

## Out of scope

- Defining, rendering or repairing cards — cws-comm's and the client's. You only pick the family (`cardKind`) and fill title / text / options; which values, how many options and which option fields a family admits is cws-comm's ruling (it refuses the rest with the field named). Card-send mechanics: `references/comm-operations.md` ("Onboarding guide cards", "Asking a question you intend to act on").
- Issue / Project / Blueprint work — onboarding creates none (see "First task").
- `d7_first_delivery` — server-side only; never self-report it, never accept anything on the user's behalf.

## Prerequisites

`core.onboarding_session {}` (`GET /api/v1/onboarding/session`) returns **your own** onboarding record. 404 → you have no onboarding (e.g. an Agent created without a preset role): handle every message normally and stop reading here. The record must have `scope:"agent"` and `agent_member_id` = your own member id; anything else (e.g. `scope:"org"`, the legacy per-org session) is not yours to run — handle messages normally. Fields used below (others returned: `org_id`, `lead_agent_member_id`, `template_version` = `agent-v1`, `status` = `pending_agent` / `active`):

| Field | Meaning |
| --- | --- |
| `owner_member_id` | The person being onboarded; the DM is `comm.create_dm {participantId: owner_member_id}` (idempotent) |
| `role_key` / `role_custom` | Your preset role; `role_custom` = the 「其它」 free text (only with `role_key:"assistant"`) |
| `id` | Record id; matches `onboarding=` in the wake line |
| `industry` | Org industry key (only the `ops` role uses it); **omitted when unset** → pass nothing and the server serves the 「其他」 cards |
| `user_has_im_channel` | `true` when the **owner** (the user, across all their Agents in this org) has any IM channel connected. **Omitted = unknown** (the platform could not check): do **not** push the IM card while unknown; re-read the session on a later turn and decide then. |
| `owner_is_org_admin` | `true` when the owner is an org admin (org-owner / org-admin). **Omitted = unknown**: do not send the teammate card; re-check on a later turn. |
| `events` | Array of `{event_type, occurred_at, agent_member_id?, meta?}`, oldest first — **the only source of "already sent / already declined"**. Already merged by the platform: your own `task_cards_sent`; the owner's `im_card_sent` / `im_card_second_sent` / `im_card_declined` reported by **any** of their Agents; the org's `partner_card_sent`; and `d1_activation` / `d3_im_connected` / `d7_first_delivery`. "`events` has X" below means an entry with `event_type` X. |

## Sending the cards (`cardKind`)

Every onboarding card goes into the owner DM (`comm.create_dm {participantId: owner_member_id}`, idempotent) as a `[CARD]{…}` body through `c4-send.js openmax '<owner DM id>'` (`references/comm-operations.md`), with **`cardKind`** — never `kind` for the family, which on a `[CARD]` means what the question is for. Every card, its text form and every onboarding report are done by the **owner DM's own thread** (on a multi-session Core each conversation has its own thread, SKILL.md "Session Groups and Sending"): it sends with that DM's `reply via` endpoint (or `c4-send.js openmax '<owner DM id>'`) and keeps the returned `message_id` / `action_ids` itself. The wake arrives in the System Member DM's thread, which only hands the opening off (§1 "Hand-off"). On an old Core there is one thread for everything: send directly.

| Card | Entry | `cardKind` | Options | `kind` / `askedOf` / `meta` (question cards only) |
| --- | --- | --- | --- | --- |
| Task cards | question `[CARD]` | `onboarding.task` | the 3 task titles, in the preset order (`{label: title}`) | `kind:"onboarding-task"`, `askedOf: owner_member_id`, `meta:{onboarding:<id>, cards:[{id, title, prompt}]}` (same order as the options) |
| IM card | question `[CARD]` | `onboarding.channel` | one option per `im_channels` entry — **every** entry, `visible:true` and `visible:false` alike — in the given order (`{label, icon?}`), then `{label:"都不用，就在这儿聊" / "None, let's just chat here", decline:true}` last | `kind:"onboarding-channel"`, `askedOf: owner_member_id`, `meta:{onboarding:<id>, trigger:"first"\|"second", channels:[…the im_channels entries…]}` |
| Teammate card | **display `[CARD]`** (no `kind` / `askedOf` — with them it is refused) | `onboarding.partner` | exactly one: `{label:"加入一位搭档" / "Add a teammate", behavior:"open_create_agent"}` | — (nothing is recorded; no answer ever comes back) |

- 🔴 **Every card has a non-empty `title` and `text`, and no `summary`** — on all three cards, leave the `summary` field out entirely (not an empty string; workspace-backlog#615: the product wants title + body only). These three kinds are the only ones cws-comm accepts without a `summary`; never add a source or date line here.
- Give the task and IM cards `kind` and `askedOf` (a question `[CARD]`) so that a click (an `<interaction-receipt/>`) can be decoded: keep the returned `message_id` / `action_ids`; `comm.answered` maps the clicked action back to the option index.
- `icon` is a slug (lowercase letters, digits, `_` / `-`, ≤ 32), never a URL: pass the channel's own slug from `im_channels` when the entry carries one, else omit `icon` (the client renders a placeholder). Never invent a slug from the label.
- 🔴 **`visible` on an `im_channels` entry is only the client's collapse hint — never a filter.** The first 5 come back `visible:true`, the rest `visible:false`; that tells the card renderer what to show before 「其他 N 个渠道」, and the card already collapses any list to 5 + that expander by itself. Always send **every** `im_channels` entry (true and false), in the given order, then 「都不用，就在这儿聊」: with 12 channels that is 13 options, and the owner sees 5 + 「其他 7 个渠道」, expanding to all 12. Do not copy `visible` into the option. A question `[CARD]` re-reads the list (with the `im_order` your `TZ` selects) and **refuse** an `onboarding.channel` card that leaves any channel out, adds or repeats one, or changes the order (nothing is sent; the error names the missing / extra channels or the first out-of-order position) — fix the options and send again; that refusal is not a "failed send" for the text-form fallback.
- `decline:true` goes on the 「都不用，就在这儿聊」 option only — at most one per card, never on the task or teammate card.
- The IM card's `trigger` (first / second push) has no card field; it lives only in `meta` and in the event you report.
- cws-comm allows up to 16 options on `onboarding.channel` (5 on the others). If `im_channels` + 「都不用，就在这儿聊」 would exceed that, send the first 15 channels in the given order plus 「都不用，就在这儿聊」 — do not reorder.
- 🔴 **The card words are fixed (PRD); never write your own, never add a source or a date.** Use exactly these, in the owner language; `{name}` is your own display name, read from `core.me {}` (`display_name`) when you build the card — it reflects a rename at first run and the name an Agent was bought with — shortened to the part after the last 「 · 」 (「运营助手 · 小张」 → 小张); with no 「 · 」 it is the whole display name (「销售测试1283」 → 销售测试1283). It is never `person` from `core.onboarding_preset` (the role's default persona, e.g. 大麦, which is not your name once you are renamed) and never a name from memory. No exception: every card's `title` and `text` both come from this table — the task card has no free-written line either (the 3 options already say what you can take off their plate).

  | Card | `title` | `text` |
  | --- | --- | --- |
  | Task cards | 你好 👋 我是{name}，已经上岗了 / Hi 👋 I'm {name}, and I'm on the job | 有什么工作，直接交代给我，也可以从下面选一件开始 / Hand me any work directly, or pick one below to start |
  | IM card, first push | 对了，你日常用哪个办公沟通工具？ / By the way, which chat app do you use for work? | 可以把我接入，以后可以常用渠道直接派任务、接收结果。 / Connect me there, and you can hand me tasks and get results right in that app. |
  | IM card, second push | 还是想再问下，你日常用哪个办公通讯渠道？ / One more time: which chat app do you use for work? | 把我接入渠道，我们随时沟通做任务。 / Connect me there, and we can work on tasks together anytime. |
  | Teammate card | 给{name}配一位搭档 / Get {name} a teammate | 让不同数字员工各有分工，既能分别处理工作，也能协作完成任务。新增一位搭档，逐步组建你的数字团队。 / Different digital employees can each take their own work and also work together. Add a teammate and build your digital team step by step. |

- **A send that fails** (the CLI exits non-zero / cws-comm refuses a field) → send the **text form** below instead, once. A transient auth failure (`status: 401`, a token being rotated) is not a failure here: `c4-send` (`[CARD]` and text alike) already re-acquires the token and re-send the same card a few times within ~2 s before exiting non-zero, so do not add a retry of your own — a non-zero exit, 401 included, means the card failed. Task cards: then report `task_cards_sent`. IM / teammate card: the push was already claimed before the card was tried (§3) — the text form goes out under that same claim; **do not report again**. Do not retry the card in a loop, and never send both a card and its text form for the same push.

## Text form (the permanent fallback)

Use the text form **whenever a card send fails** (error / rejected, e.g. an older cws-comm without the onboarding families). It is not a test path — the owner gets the same choice either way. Send it into the owner DM as plain text through `c4-send.js openmax` (the owner DM's thread sends it, as it sends the cards); the text form counts as shown, and its event is the same as the card's:

- **Task cards** — report `task_cards_sent` after the text form is sent, exactly as after the card.
- **IM card / teammate card** — `im_card_sent` / `im_card_second_sent` / `partner_card_sent` were already reported **before** the card was tried and came back `recorded:true` (the claim, §3). The text form is sent under that same claim: **do not report the event again**, and never fall back to the text form without that claim.

Never send both a card and its text form for the same push.

| Card | Text form |
| --- | --- |
| Task cards | The card's `title` and `text` (the fixed wording in "Sending the cards") as one paragraph, then the 3 task titles as a numbered list (1–3, in the preset order), then one line: reply with a number or a title to start. |
| IM card | The card's `title` and `text` (the fixed wording in "Sending the cards") as one paragraph, then **all** the channels from `im_channels` in the given order (`visible:false` ones included — `visible` is only the card's collapse hint), as one list (names only, `label`), then 「都不用，就在这儿聊」 as the last option; one line: reply with a channel name, or 「都不用」 if none. |
| Teammate card | The card's `title` and `text` (the fixed wording in "Sending the cards") as one paragraph, then the "add Agent" page: `core.frontend_url {path:"/agents"}`. No buttons to imitate, nothing to reply. |

A reply to a text form is handled under "Card clicks" exactly like the matching click.

## Flow

### 1. Wake → self-introduction + 3 task cards

**Hand-off (multi-session Core).** The opening — the task cards, their text form if the cards fail, and the `task_cards_sent` report with the `card_ids` — belongs entirely to the **owner DM's thread**. When the wake reaches you in the System Member DM's thread (`ZYLOS_SESSION_GROUP` is set and it is not the owner DM's group): do step 1's checks; if `events` has no `task_cards_sent`, get the owner DM id (`comm.create_dm {participantId: owner_member_id}`), find its thread (`scripts/session-group.js '<owner DM id>'`) and hand the opening off with one `internal` message to `openmax:dm-<owner DM id>` carrying everything it needs: that this is the onboarding opening, the onboarding record `id`, `owner_member_id`, the owner DM id, the owner language if known, and "run references/onboarding-lead.md §1 steps 1–5 in your DM". Then stop: send no card, text form or report yourself, and do not wait for a reply. The opening is **in flight** from then on; a later wake that still finds no `task_cards_sent` hands off again, which is harmless, because the owner DM's thread starts every hand-off with step 1 and does nothing once `task_cards_sent` is recorded (its messages are handled one at a time, so a second hand-off is read after the first has reported). If the `internal` send itself fails, nothing is in flight: report the failure in the log and let the next wake try again. On an old Core (one thread), or when you already are the owner DM's thread, run the steps yourself.

1. `core.onboarding_session {}` — **on every wake, every time**, including after a restart and when you remember having onboarded this owner. 404 or a mismatch (see "When to load") → stop.
   **Decide purely from `events`** — never from memory, a memory summary, state files or earlier conversation (after a restart your recollection of "cards sent / activated" may be wrong or from another run). `events` has `task_cards_sent` → the opening is done; do not send it again. `events` has **no** `task_cards_sent` → send the opening (steps 2–5) now, **even if you remember sending it** — in the owner DM's thread; in any other thread, hand it off instead (above).
2. `core.onboarding_preset {role: <role_key or "assistant">, industry: <industry, only when present>, lang: <owner language>}` → `cards` (3, each `id` / `title` / `prompt`, plus `title_en` / `prompt_en`), `person`, `role_label`. `person` is the role's default persona, not your name — the cards introduce you by `{name}` (your own display name, see "Sending the cards"). Use the English fields when the owner uses English and they are present. **Owner language** (`lang`: `zh` or `en`) = the language of the owner's messages in the DM; before they have written anything, `zh` if your timezone gives the CN order (§3), else `en`. Pass it to every onboarding call that returns labels. Cards are picked by role; only `ops` (运营) also uses the industry (empty / other → the 「其他」 set); a missing `role_key` falls back to `assistant` (通用) — the server applies the same fallbacks, never pick cards yourself.
3. The task card's `title` and `text` are both fixed (see "Sending the cards") — write nothing of your own on it. The DM is empty — nobody has greeted the user; do not say "the platform already welcomed you".
4. Send it as the task card (question `[CARD]`, `cardKind:"onboarding.task"`, the fixed `title` and `text` (no `summary`), the 3 titles as options — see "Sending the cards") into the owner DM — if the send fails, the task-card **text form**.
5. `core.onboarding_event {eventType:"task_cards_sent", meta:{card_ids:[…]}}` — reported by the thread that sent the cards (the owner DM's thread), with the ids it got back.

The wake message itself lives in a read-only system DM — never reply there. **No interview**: do not ask for their name, company, responsibilities or goals.

### 2. The owner's messages in the DM

- **First message from the owner** (a card click — an `<interaction-receipt/>` whose actor is the owner — counts) → `core.onboarding_event {eventType:"d1_activation"}` (idempotent, no need to query first).
- **A task-card click** arrives as an `<interaction-receipt/>` (posted in the read-only interaction-center DM; answer in the card's own conversation — the bridge already routes the reply there). Read the element, not the sentence: `comm.answered {cardMessageId, actionId, actorMemberId}` → act only when `actionable`; `optionIndex` picks the card in `question.meta.cards`, whose `prompt` is the owner's request. Then `comm.pending_clear {cardMessageId}` (receipts can be redelivered; a cleared one is a no-op). With the text form, the owner's reply of a list number (1–3) or a task title counts as that click: treat that card's full `prompt` (or `prompt_en`) as their request. Either way it is their **first task**: do it now and deliver the result in the DM. A task-card receipt is not a *new* task for New-Issue intake, but it **does start the owner's first task, exactly like a typed request** — including the IM first push (§3).
- **A typed message** → classify it normally: a work request becomes the first task; chat or a question gets a normal answer — do not force it into a task.
- **First task** → executed **directly in the DM**. No New-Issue intake, no Project / Issue / Blueprint — unless the owner explicitly asks for one, then the normal intake applies. Resource authorization, credentials and high-risk approvals still apply.
- **After delivering** a task, stop: deliverables go to the KnowledgeBase through the existing flow, and you **do not ask follow-up questions or suggest next steps**. This does **not** cover onboarding cards: a card that is due (§3) is always sent, right after your reply — it is not a "next step".
- What you learn along the way (how to address them, role, preferences) goes into that user's profile in your memory. Learn it from the work; never ask for it.

### 3. When a card is due

**On every owner turn in the DM while the record is not finished** — right after you reply, and when a task starts (for the first push) — **re-read `core.onboarding_session` and evaluate every row below from `events`.** Never skip the check because you remember a card being sent or not being due; a due card is always sent.

**Before sending any card, re-read `core.onboarding_session` and check `events`** (the only record of what was sent; never your memory) — a decline or a teammate card may have been recorded from another Agent of the same owner / org. That check only skips work early; it does not stop a sibling Agent of the same owner from deciding the same card at the same moment. **The report is the claim, so it comes first:**

1. **Claim** — `core.onboarding_event {eventType:"<event>"}` (`im_card_sent` / `im_card_second_sent` / `partner_card_sent`) **before** sending anything. cws-core records each of these exactly once in its scope (IM card: once per owner across all their Agents; teammate card: once per org) and, of concurrent reports, answers `recorded:true` to exactly one.
2. **`recorded:true`** → the push is yours: send the card now. If the card send fails, send its **text form** instead, once, under the same claim — **do not report again**.
3. **`recorded:false`** → another Agent (or an earlier turn of yours) already claimed this push: **do not send** the card or its text form, and say nothing about it.
4. **The report itself fails** (non-zero exit, 4xx / 5xx) → nothing was claimed: do not send this turn; re-evaluate on a later owner turn.

A claimed push whose card and text form both fail is not retried — the claim stands for it.

| Card | When | Due only if (all must hold) | Claim (report **before** sending) |
| --- | --- | --- | --- |
| IM card, first push (`trigger:first`) | the moment the **first task starts** executing — a task-card click or a typed work request (claim, send it on `recorded:true`, then carry on with the task) | `user_has_im_channel` is `false` (omitted = unknown → not due) · `events` has neither `im_card_sent` nor `im_card_declined` | `im_card_sent` |
| IM card, second push (`trigger:second`) | after your reply, once the DM has **≥ 20** messages | `user_has_im_channel` is still `false` (omitted → not due) · `events` has neither `im_card_declined` (user-level) nor `im_card_second_sent` | `im_card_second_sent` |
| Teammate card | after your reply, once the DM has **≥ 50** messages | the org still has exactly **1** Agent (you — see "Agent count" below) · `owner_is_org_admin` is `true` (omitted → not due) · `events` has no `partner_card_sent` (once per org) | `partner_card_sent` |

- **Only `im_card_declined` or `user_has_im_channel: true` cancel the second push.** An owner who clicked or typed a channel earlier without connecting it still gets the second push when it is due.
- **IM connected** = `user_has_im_channel` only (user-level, not per Agent). Never infer it from your own channels or from history. If the first push was not sent because the field was omitted, send it on the first later turn where it reads `false` (the other conditions still apply).
- **Agent count** — the platform does not give one; check it yourself: `core.member_list {kind:"agent", pageSize:2}` (active Agents of this org only, the default). Exactly one item, and it is you (`member_id` = the session's `agent_member_id`) → the org has 1 Agent. Two items → not due. Check it only while the teammate card is still due.
- **Message count** = cumulative messages in the owner DM, human + Agent, no time window, from `comm.get_messages {conversationId, limit:50}`. An approximation is fine (±1–2); check it only while one of the last two rows is still due, and stop counting once both are recorded.
- **IM channel order follows your own timezone** — not the user's IP, not the deployment edition. Your timezone: `TZ` in your environment, else the `TZ=` line of `~/zylos/.env`; unset counts as `UTC`. `Asia/Shanghai` or `Asia/Urumqi` → the **CN order**; anything else, `UTC` included → the **international order**. Fetch that order's list with `core.onboarding_profile_options {imOrder:"cn"|"intl", lang:"zh"|"en"}` → `im_channels`. Always pass both: without `imOrder` the server falls back to edition / geo for the order, and without `lang` the deployment edition picks the label language. Show each channel by its `label` (in `lang`); `label_zh` / `label_en` are always returned too, if you need the other language. Pass the list as given; never reorder, drop or add channels yourself — `visible:false` does **not** mean drop: it is only the card's 「5 + 其他 N 个渠道」 collapse hint, so every entry goes on the card and into the text form. The IM card lists them as options with 「都不用，就在这儿聊」 last (see "Sending the cards"); the text form lists them all.
- First `core.onboarding_event {eventType:"<event>"}` (the claim); only on `recorded:true` send the IM card (question `[CARD]`, `cardKind:"onboarding.channel"`, `meta.trigger`) or the teammate card (display `[CARD]`, `cardKind:"onboarding.partner"`) — if the send fails, the **text form**, without reporting again. `recorded:false` → send nothing.

### 4. Card clicks

| What arrives | Do |
| --- | --- |
| An IM-card receipt (`comm.answered` → `actionable`, `optionIndex` = a channel in `question.meta.channels`), a typed 「我要接{渠道}」 / "I'd like to connect {channel}" from the owner, or a channel name in reply to the IM text form | Feishu / Lark / DingTalk / WeCom → the in-chat connect flow (`references/channel-operations.md`, `channel.connect` with this message's `<message-context>`); on success `core.onboarding_event {eventType:"d3_im_connected"}`. Any other channel → give the link to your Agent page: `core.frontend_url {path:"/agents?id=<your member id>"}`. Do not invent another mechanism. |
| ↳ IM-card receipt specifically | Call `channel.connect` right away with the **receipt's own** `<message-context>`, copied verbatim — the bridge already points its `source-message-id` at the IM card itself, not the receipt. Core verifies the click (your card, the owner/admin who clicked, that option = that channel, clicked in the last 10 minutes) and treats it as the consent, so the QR arrives directly — there is **no** 「确认连接」 card. **Never ask the owner to type the channel name or 「我要接…」 first**: the click is enough. Tell them in one line the QR is on its way. |
| An IM-card receipt whose `optionIndex` is the `decline:true` option (the last one), or the owner's reply 「都不用」 / "none" to the IM text form | `core.onboarding_event {eventType:"im_card_declined"}` (applies to every Agent of this owner). Reply with exactly this one line: 「好，那我们就在这儿聊。以后想接到你常用的渠道，随时跟我说一声。」 / "Sure, let's keep chatting here. If you ever want me in your chat app, just tell me." — and **never bring IM up again** unless the owner does. |

After handling any onboarding-card receipt, `comm.pending_clear {cardMessageId}`. A receipt whose `comm.answered` is not `actionable` (unknown card, another member clicked, expired) → do nothing for onboarding. A receipt may never arrive (expired / recalled card): the owner can still type the task or the channel, handled as above.
| Teammate card click | (The text form has no click; the card was a display card, so nothing is pending.) Nothing reaches you (it opens the "add Agent" dialog in the web app). If the owner asks, help them add a teammate. |

## Events you report

`core.onboarding_event {eventType, occurredAt?, meta?}` → `POST /api/v1/onboarding/events` `{event_type, occurred_at?, meta?}` — idempotent, once-only enforced server-side; a repeat returns `recorded:false`. For the card pushes `im_card_sent` / `im_card_second_sent` / `partner_card_sent` the report is the **claim** made before sending (§3): `recorded:true` → send; `recorded:false` → already claimed, do not send. For every other event `recorded:false` just means nothing to do.

| eventType | Scope | When |
| --- | --- | --- |
| `d1_activation` | this onboarding | owner's first message in the DM |
| `task_cards_sent` | this Agent | after the opening self-intro + task cards are sent |
| `im_card_sent` | the owner (all their Agents; atomic claim) | **before** the IM card first push — send only on `recorded:true` |
| `im_card_second_sent` | the owner (all their Agents; atomic claim) | **before** the IM card second push — send only on `recorded:true` |
| `im_card_declined` | the owner (all their Agents) | after the 「都不用」 receipt or text reply |
| `partner_card_sent` | the org (atomic claim) | **before** the teammate card is sent — send only on `recorded:true` |
| `d3_im_connected` | this onboarding | after an IM channel is connected |
