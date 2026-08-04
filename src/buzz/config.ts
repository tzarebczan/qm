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
  /** Owner-attested NIP-OA auth tag JSON (optional) */
  authTagJson?: string;
  reconnectMs: number;
  /** When true, reply to every channel message (noisy; default false) */
  allMessages: boolean;
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

export function buzzPluginConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuzzPluginConfig | null {
  const relayUrl = env.BUZZ_RELAY_URL?.trim();
  const botPrivateKey = env.BUZZ_BOT_PRIVATE_KEY?.trim();
  if (!relayUrl || !botPrivateKey) return null;

  const channelIds = (env.BUZZ_CHANNELS ?? env.BUZZ_CHANNEL_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    relayUrl,
    botPrivateKey,
    channelIds,
    principalMap: parsePrincipalMap(env.BUZZ_PRINCIPAL_MAP),
    ...(env.BUZZ_DEFAULT_PRINCIPAL?.trim()
      ? { defaultPrincipalId: env.BUZZ_DEFAULT_PRINCIPAL.trim() }
      : {}),
    allowUnmapped: env.BUZZ_ALLOW_UNMAPPED === "1",
    botName: env.BUZZ_BOT_NAME?.trim() || "QM",
    mentionKeywords: (env.BUZZ_MENTION_KEYWORDS ?? "qm")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    channelRuntime: parseChannelRuntime(env.BUZZ_CHANNEL_RUNTIME),
    ...(env.BUZZ_AUTH_TAG?.trim() ? { authTagJson: env.BUZZ_AUTH_TAG.trim() } : {}),
    reconnectMs: Math.max(1_000, Number(env.BUZZ_RECONNECT_MS) || 5_000),
    allMessages: env.BUZZ_ALL_MESSAGES === "1",
  };
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
