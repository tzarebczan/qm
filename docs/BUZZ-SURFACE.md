# Buzz surface (first-class, harness-agnostic)

In-process QM surface peer of Slack. Buzz messages become core turns; core picks harness (pi / opencode / codex / claude / mock).

## Enable

```bash
# required
BUZZ_RELAY_URL=wss://my-brain.communities.buzz.xyz
BUZZ_BOT_PRIVATE_KEY=<nsec or 64-hex>

# channels (UUIDs from Buzz)
BUZZ_CHANNELS=<ops-channel-uuid>,<general-uuid>

# map Nostr authors → QM principals (email)
BUZZ_PRINCIPAL_MAP=<your-pubkey-hex>:you@example.com;Tom

# optional
BUZZ_BOT_NAME=QM
BUZZ_MENTION_KEYWORDS=qm,lab-sandbox,deploy
BUZZ_CHANNEL_RUNTIME=<ops-uuid>:pi,<other-uuid>:codex
BUZZ_AUTH_TAG='["auth",...]'   # NIP-OA if required by relay
BUZZ_ALLOW_UNMAPPED=0
BUZZ_ALL_MESSAGES=0            # 1 = reply to every message in subscribed channels
# BUZZ_DM=0                    # default on: discover Buzz DMs (NIP-29 hidden channels via kind:44100)
```

## Direct messages (DMs)

Buzz Desktop DMs are **NIP-29 channel-type DMs** (kind:9 + `#h` = DM UUID, metadata kind:39000 with `hidden`), not only NIP-17 gift wraps.

When `BUZZ_DM` is enabled (default):

1. Subscribe membership `kinds:[44100,44101]` with `#p` = bot pubkey  
2. On add: SEQ kind:9 for that channel UUID (24h lookback)  
3. Every human message in a DM is a turn (`conversation.kind = "dm"`) — no @mention required  
4. Replies publish kind:9 on the same DM channel  

Set `BUZZ_DM=0` to disable. Gift-wrap kind:1059 is not handled yet.

## Harness selection

| Source | How |
|--------|-----|
| Default | Core `HARNESS` / org scope runtime (same as web & Slack) |
| Per channel | `BUZZ_CHANNEL_RUNTIME=channelId:codex` or `channelId:pi:kimi-k3` |
| Per message | Prefix `[[harness:codex]] …` or `[[harness:pi model:kimi-k3]] …` |

Surfaces never force a harness unless the user/channel opts in.

## Behavior

1. Connect WebSocket → NIP-42 AUTH → optional kind:0 profile  
2. Subscribe kind:9 on `BUZZ_CHANNELS`  
3. (DM) Subscribe membership 44100/44101; dynamic kind:9 per DM channel  
4. Channel: @bot / keywords / p-tag → turn; DM: every message → turn (`kind: "dm"`)  
5. Publish reply kind:9 with e-tag reply  
6. Delivery poller claims `type: "buzz"` for recovery copies  

## Thread refs

- Session: `buzz:<channelId>:<rootEventId>`  
- Continuable in web UI: **no** (same as Slack — not `web:`)  

## Upstream notes

- Code under `src/buzz/*`, `src/api/buzz-core-client.ts`  
- Boot in `src/index.ts` via generic reconciler  
- Orchestrator labels surface “Buzz” for conversation mode  
- No Google/Slack dependency  

## Lab deploy

Stock `ghcr.io` core image does **not** include this until you build/push an image from this branch. Options:

1. Build custom core image from this tree and set env on recreate  
2. Run local `npm start` with Buzz env for dev  
3. Later: extract sidecar that only uses HTTP `/v1/turns` if preferred  

## Security

- Never commit bot nsec  
- Map only trusted pubkeys to org principals  
- Prefer `BUZZ_ALLOW_UNMAPPED=0`  
