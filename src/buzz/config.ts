/** Buzz surface configuration (env-driven, peer of Slack plugin config). */

import { getPublicKey } from "nostr-tools";
import { parseBotSecret } from "./relay.ts";

export interface BuzzPrincipalMapEntry {
  /** Hex or npub public key */
  pubkey: string;
  /** QM principal id (usually email) */
  principalId: string;
  displayName?: string;
}

export interface BuzzChannelRuntime {
  /** Channel UUID or #name */
  channel: string;
  harnessId?: string;
  modelId?: string;
}

export interface BuzzPluginConfig {
  /** Stable id for multi-bot (e.g. qm, qm-grok) */
  agentId: string;
  relayUrl: string;
  botPrivateKey: string;
  /** Channel UUIDs to subscribe (empty = all kind:9 the bot can see after join) */
  channelIds: string[];
  /** Map author pubkey → QM principal */
  principalMap: BuzzPrincipalMapEntry[];
  /** Default principal when pubkey unmapped and BUZZ_ALLOW_UNMAPPED=1 */
  defaultPrincipalId?: string;
  allowUnmapped: boolean;
  botName: string;
  /** Case-insensitive content triggers in addition to @botName */
  mentionKeywords: string[];
  /** Optional per-channel harness/model overrides */
  channelRuntime: BuzzChannelRuntime[];
  /** Default harness for this bot when message/channel does not override */
  defaultHarnessId?: string;
  defaultModelId?: string;
  /** Owner-attested NIP-OA auth tag JSON (optional) */
  authTagJson?: string;
  reconnectMs: number;
  /** When true, reply to every channel message (noisy; default false) */
  allMessages: boolean;
  /**
   * When true, continue threads the bot already joined without a fresh @mention.
   * Default **false** — multiplayer chatter stays silent unless @mentioned or a
   * direct reply to the bot's own post. Set BUZZ_THREAD_FOLLOWUP=1 to re-enable.
   */
  threadFollowup: boolean;
  /**
   * When true (default), a direct reply to one of our posts can continue without @.
   * Set BUZZ_REPLY_CONTINUITY=0 to require @ for every channel turn.
   */
  replyContinuity: boolean;
  /**
   * When true (default), discover Buzz DM channels via kind:44100 membership
   * notifications and reply to every message in those channels without @mention.
   * Set BUZZ_DM=0 to disable.
   */
  dmEnabled: boolean;
  about?: string;
  /**
   * Proactive scout: scan channel traffic on an interval / command, post
   * follow-up proposals, execute when humans react (👍). Same brain as the
   * reactive bot; can later be a second Nostr identity with role=proactive.
   * BUZZ_PROACTIVE=1
   */
  proactiveEnabled: boolean;
  /** Seconds between automatic channel scans (0 = command-only). Default 1800. */
  proactiveIntervalSec: number;
  /** Max proposals per scan card. */
  proactiveMaxProposals: number;
  /**
   * When true, this agent only runs proactive scout (no reactive turn-handler).
   * Use for a dedicated Egg-Scout identity. BUZZ_PROACTIVE_ONLY=1
   */
  proactiveOnly: boolean;
  /** When true, approvals @mention handoff agent instead of self-executing. */
  proactiveHandoff: boolean;
  /** Hex pubkey of executor bot (Egg-Brain) for p-tag / routing. */
  proactiveHandoffPubkey?: string;
  /** Display name for @mention handoff (default Egg-Brain). */
  proactiveHandoffName?: string;
  /**
   * Sibling bot pubkeys (hex) to ignore for reactive turns / scout buffering.
   * Prevents Egg-Brain ↔ Egg-Scout loops. BUZZ_SIBLING_PUBKEYS=hex,hex
   */
  siblingPubkeys: string[];
}

function parsePrincipalMap(raw: string | undefined): BuzzPrincipalMapEntry[] {
  if (!raw?.trim()) return [];
  // Formats:
  //   hex:email,hex:email
  //   or JSON array
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as BuzzPrincipalMapEntry[];
      return parsed.filter((e) => e?.pubkey && e?.principalId);
    } catch {
      return [];
    }
  }
  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const colon = part.indexOf(":");
      if (colon <= 0) return null;
      // email may contain no colons usually; hex:email
      // support npub1...:email — take last colon for principal if multiple?
      // hex is 64 chars, so first :
      const pubkey = part.slice(0, colon).trim();
      const rest = part.slice(colon + 1).trim();
      const semi = rest.indexOf(";");
      if (semi >= 0) {
        return {
          pubkey,
          principalId: rest.slice(0, semi).trim(),
          displayName: rest.slice(semi + 1).trim() || undefined,
        };
      }
      return { pubkey, principalId: rest };
    })
    .filter((e): e is BuzzPrincipalMapEntry => !!e?.pubkey && !!e?.principalId);
}

function parseChannelRuntime(raw: string | undefined): BuzzChannelRuntime[] {
  if (!raw?.trim()) return [];
  // channel:harness or channel:harness:model
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const parts = p.split(":");
      if (parts.length < 2) return null;
      const channel = parts[0]!.trim();
      const harnessId = parts[1]!.trim() || undefined;
      const modelId = parts[2]?.trim() || undefined;
      return { channel, ...(harnessId ? { harnessId } : {}), ...(modelId ? { modelId } : {}) };
    })
    .filter((e): e is BuzzChannelRuntime => !!e?.channel);
}

function sharedFromEnv(env: Record<string, string | undefined>) {
  const channelIds = (env.BUZZ_CHANNELS ?? env.BUZZ_CHANNEL_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    channelIds,
    principalMap: parsePrincipalMap(env.BUZZ_PRINCIPAL_MAP),
    ...(env.BUZZ_DEFAULT_PRINCIPAL?.trim()
      ? { defaultPrincipalId: env.BUZZ_DEFAULT_PRINCIPAL.trim() }
      : {}),
    allowUnmapped: env.BUZZ_ALLOW_UNMAPPED === "1",
    channelRuntime: parseChannelRuntime(env.BUZZ_CHANNEL_RUNTIME),
    reconnectMs: Math.max(1_000, Number(env.BUZZ_RECONNECT_MS) || 5_000),
    allMessages: env.BUZZ_ALL_MESSAGES === "1",
    // Off by default: human↔human replies in a thread we once joined stay silent.
    threadFollowup: env.BUZZ_THREAD_FOLLOWUP === "1" || env.BUZZ_THREAD_FOLLOWUP === "true",
    // On by default: reply-to-our-post continues work without re-@.
    replyContinuity: env.BUZZ_REPLY_CONTINUITY !== "0" && env.BUZZ_REPLY_CONTINUITY !== "false",
    // Default on: Buzz Desktop DMs are NIP-29 channels (hidden), not gift-wraps.
    dmEnabled: env.BUZZ_DM !== "0" && env.BUZZ_DM !== "false",
    proactiveEnabled: env.BUZZ_PROACTIVE === "1" || env.BUZZ_PROACTIVE === "true",
    proactiveIntervalSec: Math.max(0, Number(env.BUZZ_PROACTIVE_INTERVAL_SEC) || 1_800),
    proactiveMaxProposals: Math.max(1, Math.min(8, Number(env.BUZZ_PROACTIVE_MAX) || 4)),
    proactiveOnly: env.BUZZ_PROACTIVE_ONLY === "1" || env.BUZZ_PROACTIVE_ONLY === "true",
    proactiveHandoff: env.BUZZ_SCOUT_HANDOFF === "1" || env.BUZZ_SCOUT_HANDOFF === "true",
    ...(env.BUZZ_SCOUT_HANDOFF_PUBKEY?.trim()
      ? { proactiveHandoffPubkey: env.BUZZ_SCOUT_HANDOFF_PUBKEY.trim().toLowerCase() }
      : {}),
    ...(env.BUZZ_SCOUT_HANDOFF_NAME?.trim()
      ? { proactiveHandoffName: env.BUZZ_SCOUT_HANDOFF_NAME.trim() }
      : {}),
    siblingPubkeys: (env.BUZZ_SIBLING_PUBKEYS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{64}$/i.test(s)),
  };
}

/**
 * Single-bot config (legacy). Prefer {@link buzzPluginConfigsFromEnv} for multi-agent.
 */
export function buzzPluginConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuzzPluginConfig | null {
  const all = buzzPluginConfigsFromEnv(env);
  return all[0] ?? null;
}

/**
 * One or more Buzz agents sharing the same QM brain, different Nostr identities
 * and optional default harness (pi | opencode | codex | claude | mock).
 *
 * Modes:
 * 1. BUZZ_AGENTS_JSON — JSON array of agents (see docs/BUZZ-SURFACE.md)
 * 2. Legacy single bot: BUZZ_RELAY_URL + BUZZ_BOT_PRIVATE_KEY
 */
export function buzzPluginConfigsFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuzzPluginConfig[] {
  const relayUrl = env.BUZZ_RELAY_URL?.trim();
  const shared = sharedFromEnv(env);
  const multi = env.BUZZ_AGENTS_JSON?.trim();
  if (multi) {
    if (!relayUrl) return [];
    try {
      const parsed = JSON.parse(multi) as Array<{
        id?: string;
        name?: string;
        privateKey?: string;
        authTag?: string;
        mentionKeywords?: string[] | string;
        defaultHarness?: string;
        defaultModel?: string;
        about?: string;
        channels?: string[];
        proactive?: boolean;
        proactiveOnly?: boolean;
        role?: string;
        handoff?: boolean;
        handoffPubkey?: string;
        handoffName?: string;
      }>;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((row, i) => {
          const botPrivateKey = row.privateKey?.trim();
          if (!botPrivateKey) return null;
          const botName = row.name?.trim() || `QM-${i + 1}`;
          const agentId = (row.id || botName).trim().toLowerCase().replace(/\s+/g, "-");
          const mentionKeywords = Array.isArray(row.mentionKeywords)
            ? row.mentionKeywords.map((s) => String(s).toLowerCase())
            : typeof row.mentionKeywords === "string"
              ? row.mentionKeywords
                  .split(",")
                  .map((s) => s.trim().toLowerCase())
                  .filter(Boolean)
              : [botName.toLowerCase(), agentId];
          const channelIds = row.channels?.length ? row.channels.map((c) => c.trim()).filter(Boolean) : shared.channelIds;
          const role = (row.role ?? "").toLowerCase();
          const proactiveOnly =
            row.proactiveOnly === true || role === "proactive" || role === "scout";
          // Scout agents always enable proactive; reactive agents default off unless explicit.
          const proactiveEnabled = proactiveOnly
            ? true
            : row.proactive === true
              ? true
              : row.proactive === false
                ? false
                : shared.proactiveEnabled && !proactiveOnly
                  ? shared.proactiveEnabled
                  : false;
          const handoff =
            row.handoff === true || (proactiveOnly && shared.proactiveHandoff);
          return {
            agentId,
            relayUrl,
            botPrivateKey,
            ...shared,
            channelIds,
            botName,
            mentionKeywords,
            proactiveEnabled: proactiveOnly ? true : proactiveEnabled,
            proactiveOnly,
            proactiveHandoff: handoff,
            ...(row.handoffPubkey?.trim()
              ? { proactiveHandoffPubkey: row.handoffPubkey.trim().toLowerCase() }
              : shared.proactiveHandoffPubkey
                ? { proactiveHandoffPubkey: shared.proactiveHandoffPubkey }
                : {}),
            ...(row.handoffName?.trim()
              ? { proactiveHandoffName: row.handoffName.trim() }
              : shared.proactiveHandoffName
                ? { proactiveHandoffName: shared.proactiveHandoffName }
                : {}),
            ...(row.defaultHarness?.trim() ? { defaultHarnessId: row.defaultHarness.trim().toLowerCase() } : {}),
            ...(row.defaultModel?.trim() ? { defaultModelId: row.defaultModel.trim() } : {}),
            ...(row.authTag?.trim() ? { authTagJson: row.authTag.trim() } : {}),
            ...(row.about?.trim() ? { about: row.about.trim() } : {}),
          } satisfies BuzzPluginConfig;
        })
        .filter((c): c is BuzzPluginConfig => !!c)
        .map((c, _i, all) => {
          // Each agent ignores every other multi-bot pubkey (anti loop).
          const siblings = new Set(c.siblingPubkeys);
          for (const other of all) {
            if (other.agentId === c.agentId) continue;
            try {
              siblings.add(getPublicKey(parseBotSecret(other.botPrivateKey)));
            } catch {
              /* ignore bad keys */
            }
          }
          if (c.proactiveHandoffPubkey) siblings.add(c.proactiveHandoffPubkey.toLowerCase());
          return { ...c, siblingPubkeys: [...siblings] };
        });
    } catch {
      console.error("[buzz-plugin] BUZZ_AGENTS_JSON parse failed");
      return [];
    }
  }

  const botPrivateKey = env.BUZZ_BOT_PRIVATE_KEY?.trim();
  if (!relayUrl || !botPrivateKey) return [];

  const botName = env.BUZZ_BOT_NAME?.trim() || "QM";
  return [
    {
      agentId: (env.BUZZ_AGENT_ID || botName).trim().toLowerCase().replace(/\s+/g, "-"),
      relayUrl,
      botPrivateKey,
      ...shared,
      botName,
      mentionKeywords: (env.BUZZ_MENTION_KEYWORDS ?? "qm")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      ...(env.BUZZ_DEFAULT_HARNESS?.trim()
        ? { defaultHarnessId: env.BUZZ_DEFAULT_HARNESS.trim().toLowerCase() }
        : {}),
      ...(env.BUZZ_DEFAULT_MODEL?.trim() ? { defaultModelId: env.BUZZ_DEFAULT_MODEL.trim() } : {}),
      ...(env.BUZZ_AUTH_TAG?.trim() ? { authTagJson: env.BUZZ_AUTH_TAG.trim() } : {}),
      about: env.BUZZ_BOT_ABOUT?.trim() || "QM multiplayer ops agent (Buzz surface)",
    },
  ];
}

export function harnessOverrideFromText(text: string): {
  cleanText: string;
  harnessId?: string;
  modelId?: string;
} {
  // [[harness:codex]] or [[harness:pi model:kimi-k3]]
  const re = /^\[\[harness:([a-z0-9_-]+)(?:\s+model:([^\]]+))?\]\]\s*/i;
  const m = text.match(re);
  if (!m) return { cleanText: text };
  return {
    cleanText: text.slice(m[0].length),
    harnessId: m[1]!.toLowerCase(),
    ...(m[2]?.trim() ? { modelId: m[2].trim() } : {}),
  };
}
