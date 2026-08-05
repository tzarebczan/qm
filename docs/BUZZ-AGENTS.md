# Multi-agent Buzz bots (same QM brain)

One QM core, multiple Nostr bot identities. Each bot can default to a different **harness** (`pi` | `opencode` | `codex` | `claude` | `mock`). Sessions stay isolated by `buzz:<channel>:<threadRoot>`.

## Pattern

| Bot | Mention | Default harness | Notes |
|-----|---------|-----------------|-------|
| **QM** | `@QM`, keyword `qm` | `pi` (kimi via Zen) | General ops |
| **QM-Grok** | `@QM-Grok` | *planned* `grok` CLI harness | Not in core yet — use multi-bot + harness when available |
| **QM-Codex** | `@QM-Codex` | `codex` | Needs Codex binary + login in core runtime |
| **QM-Claude** | `@QM-Claude` | `claude` | Needs Claude Code binary + login in core runtime |

Brain = same org SOUL, Ops, portfolio, memory. Difference = **runtime/harness** + **Buzz identity**.

## Env: multi-bot (`BUZZ_AGENTS_JSON`)

```bash
BUZZ_RELAY_URL=wss://my-brain.communities.buzz.xyz
BUZZ_CHANNELS=<ops-uuid>,<general-uuid>,<agents-uuid>
BUZZ_ALLOW_UNMAPPED=1
BUZZ_DEFAULT_PRINCIPAL=you@example.com
# Optional shared principal map…
# BUZZ_PRINCIPAL_MAP=hex:email

BUZZ_AGENTS_JSON='[
  {
    "id": "qm",
    "name": "QM",
    "privateKey": "nsec1…",
    "authTag": "[\"auth\",…]",
    "mentionKeywords": ["qm"],
    "defaultHarness": "pi",
    "about": "Lab ops brain (pi/kimi)"
  },
  {
    "id": "qm-codex",
    "name": "QM-Codex",
    "privateKey": "nsec1…",
    "authTag": "[\"auth\",…]",
    "mentionKeywords": ["qm-codex", "codex"],
    "defaultHarness": "codex",
    "about": "Same QM brain, Codex harness"
  }
]'
```

Legacy single-bot (`BUZZ_BOT_PRIVATE_KEY` + `BUZZ_BOT_NAME`) still works.

Per message override (any bot): `[[harness:codex]] …`

## Thread isolation

- Session key: `buzz:<channelId>:<rootEventId>`
- Root = NIP-10 `e` tag with marker **root**, else **reply**, else **this message id**
- Bare unmarked `e` tags are **ignored** (old bug joined unrelated threads)

## Stall / reconnect recovery

- Wait-run tracks status/lease progress (not only first token)
- Publish retries across relay reconnects
- Delivery poller still claims `type: buzz` after WS blips

## Subscription harnesses in Docker core

Stock image has no `claude` / `codex` / `grok` binaries. To use subscription CLIs:

1. Install CLIs on host (or lab-agents) and **mount** into core, or bake into custom image
2. Set `CLAUDE_BIN` / `CODEX_BIN` (and process env for auth) per QM config
3. Approve harnesses in org runtime if gated

**Grok Build CLI** is not a first-class QM harness yet (`HARNESS_IDS` has no `grok`). Multi-bot + pattern is ready; a `grok` harness adapter is the next coding task.

## Setup checklist for a new bot (e.g. QM-Grok)

1. Create agent in Buzz Desktop (or generate nsec) → admit to my-brain + channels
2. Copy nsec + auth tag into `BUZZ_AGENTS_JSON`
3. Distinct `mentionKeywords` so bots do not all fire
4. `defaultHarness` only if that harness works in the core container
5. Recreate core / restart with new env
6. Desktop Play **off** for those agents if lab surface owns them
