# Buzz × QM — first-class surface (vs Slack)

## Roles (keep them separate)

| System | Job |
|--------|-----|
| **QM** (`lab-sandbox`, org `tz`) | Company brain: turns, memory, skills, sandboxes, crons, projects, admin |
| **Buzz desktop** (`my-brain` workspace) | Human+agent chat: channels, DMs, personas, Nostr relay identity |
| **Slack** (optional, not configured here) | Same *surface* role as Buzz — inbound mentions → QM turns → outbound replies |

Slack is a **QM surface plugin**: events in, agent turns, delivery out.  
Buzz today is **not** wired that way. The `examples/qm-ops` pack only installs a **persona** that *talks about* the lab; it does not run QM’s orchestrator.

First-class means: **@QM in Buzz is the same agent as web/admin**, with shared memory, projects, and crons — not a separate LLM chat with a pasted prompt.

## Target architecture

```
Buzz desktop (my-brain community / relay)
        │  Nostr WS (NIP-29 channel msgs, mentions)
        ▼
  QM Buzz surface  (new plugin, peer of Slack)
        │  POST /v1/turns  (actor = mapped Buzz pubkey → email principal)
        │  delivery → kind:9 / DM
        ▼
  QM core (kimi-k3 / Zen, sandboxes, Ops project, org SOUL)
```

| Concern | Slack (existing) | Buzz (first-class) |
|---------|------------------|--------------------|
| Transport | Socket Mode / Events API | Relay WebSocket + NIP-42 auth |
| Identity | Slack user id → directory | npub → mapped principal (`you@example.com`) |
| Thread model | channel + thread_ts | channel UUID + reply tags |
| Continuable in web UI | Slack sessions read-only | Same (surface ≠ `web:`) unless we add bridge |
| Delivery | chat.postMessage | `messages send` / kind 9 publish |
| Mentions | @bot | @QM + p-tags |

## Phased rollout

### Phase 0 — persona-only (optional soft UX)

1. Install pack `buzz/examples/qm-ops` into **my-brain** (or paste persona).
2. Use **QM web** for durable multiplayer work until the surface is deployed.
3. Persona-only is a **second brain** unless the surface below is live.

### Phase 1–2 — bridges (optional sidecars)

Outbound digests via `buzz-cli` and HTTP `/v1/turns` sidecars remain valid for
hosts that cannot rebuild core. Prefer Phase 3 when you control the core image.

### Phase 3 — **implemented** (in-tree Buzz surface)

Code lives under `src/buzz/*` + `src/api/buzz-core-client.ts` (see `docs/BUZZ-SURFACE.md`).

- Boot beside core when `BUZZ_RELAY_URL` + `BUZZ_BOT_PRIVATE_KEY` are set.
- Mentions → `app.turn({ surface: "buzz", harness?, model? })` → kind:9 reply.
- **Harness-agnostic:** default = org/core `HARNESS`; override per channel
  (`BUZZ_CHANNEL_RUNTIME`) or per message (`[[harness:codex]] …`).
  Supported harness ids: `pi`, `opencode`, `codex`, `claude`, `mock`.
- Delivery recovery poller claims `type: "buzz"`.
- Not yet: directory sync, Blossom files, admin “install Buzz” UI.

## Identity mapping (my-brain)

| Buzz | QM |
|------|-----|
| Your desktop npub | `you@example.com` |
| @QM bot npub | service principal `qm@tz` or act as gmail with bot key |
| Channel `#ops` | project **Ops** `group:web-project-5f0e10b9-…` (optional link) |
| Channel `#general` | org ambient or separate project |

Store mapping in `/srv/lab/qm/buzz-map.json` (not committed secrets).

## What not to do

- Don’t expect Slack-shaped env (`SLACK_BOT_TOKEN`) to do anything for Buzz.
- Don’t put Zen API keys in Buzz personas; keep model billing in QM core.
- Don’t use playground Guest sessions for durable ops (already disabled).

## my-brain workspace checklist

- [ ] Relay URL for my-brain noted (`BUZZ_RELAY_URL=…`)
- [ ] Channels `#ops` / `#general` exist; bot key admitted
- [ ] `BUZZ_PRINCIPAL_MAP` maps your npub/hex → `you@example.com`
- [ ] Core image built from `feat/buzz-surface` (or later main) with Buzz env
- [ ] @QM in Buzz produces a QM turn (shared memory / Ops) — not persona-only
- [ ] Optional: pack `qm-ops` for soft persona fallback when surface is down
- [ ] Later: polish + upstream PR (do not open until reviewed)

## Related

- QM UI: https://lab.taile80474.ts.net/ (Google SSO)
- Ops project + morning fleet cron (owner gmail)
- Pack: `buzz/examples/qm-ops`
