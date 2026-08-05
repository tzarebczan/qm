/** Buzz surface configuration (env-driven, peer of Slack plugin config). */

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
  about?: string;
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
          return {
            agentId,
            relayUrl,
            botPrivateKey,
            ...shared,
            channelIds,
            botName,
            mentionKeywords,
            ...(row.defaultHarness?.trim() ? { defaultHarnessId: row.defaultHarness.trim().toLowerCase() } : {}),
            ...(row.defaultModel?.trim() ? { defaultModelId: row.defaultModel.trim() } : {}),
            ...(row.authTag?.trim() ? { authTagJson: row.authTag.trim() } : {}),
            ...(row.about?.trim() ? { about: row.about.trim() } : {}),
          } satisfies BuzzPluginConfig;
        })
        .filter((c): c is BuzzPluginConfig => !!c);
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
