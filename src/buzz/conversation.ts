/** Thread / delivery target encoding for Buzz surface. */

export function buzzThreadRef(channelId: string, rootEventId?: string): string {
  const root = rootEventId?.trim() || "root";
  return `buzz:${channelId}:${root}`;
}

export function buzzDeliveryTarget(channelId: string, replyToEventId?: string): string {
  return replyToEventId?.trim()
    ? `buzz:${channelId}:reply:${replyToEventId}`
    : `buzz:${channelId}`;
}

export function parseBuzzDeliveryTarget(
  target: string,
): { channelId: string; replyToEventId?: string } | null {
  if (!target.startsWith("buzz:")) return null;
  const rest = target.slice("buzz:".length);
  const reply = rest.match(/^([^:]+):reply:([0-9a-f]{64})$/i);
  if (reply) return { channelId: reply[1]!, replyToEventId: reply[2]!.toLowerCase() };
  const channelOnly = rest.match(/^([^:]+)$/);
  if (channelOnly) return { channelId: channelOnly[1]! };
  // buzz:channel:rootEvent — treat as channel + optional thread root for delivery as reply
  const parts = rest.split(":");
  if (parts.length >= 1 && parts[0]) {
    return {
      channelId: parts[0],
      ...(parts[1] && parts[1] !== "root" && /^[0-9a-f]{64}$/i.test(parts[1])
        ? { replyToEventId: parts[1].toLowerCase() }
        : {}),
    };
  }
  return null;
}

/**
 * Resolve QM session root for a Buzz message.
 *
 * Prefer NIP-10 `e` tags with marker "root". If only a "reply" marker exists,
 * use that event id (one-hop thread). Do **not** fall back to the first bare
 * `e` tag — that joins unrelated threads when clients omit markers.
 *
 * @param eventId this message's id (used when no structured thread tags)
 */
export function rootEventIdFromTags(tags: string[][], eventId?: string): string | undefined {
  const eTags = tags.filter((t) => t[0] === "e" && t[1]);
  const root = eTags.find((t) => t[3] === "root" || t[2] === "root");
  if (root?.[1]) return root[1];
  const reply = eTags.find((t) => t[3] === "reply" || t[2] === "reply");
  if (reply?.[1]) return reply[1];
  // Unmarked e tags: ignore for session identity (prevents cross-thread bleed)
  if (eventId?.trim()) return eventId.trim();
  return undefined;
}

/** Session root for turn handling — always returns a concrete id. */
export function sessionRootEventId(tags: string[][], eventId: string): string {
  return rootEventIdFromTags(tags, eventId) ?? eventId;
}

/**
 * Session root for Buzz turns.
 * Public channels: NIP-10 root / reply marker, else this event id (one session per message).
 * DMs: same NIP-10 rules, but unthreaded messages share one stable session per DM channel
 * so follow-ups keep memory without requiring @mention or reply tags.
 */
export function sessionRootForBuzz(
  tags: string[][],
  eventId: string,
  opts: { isDm: boolean; channelId: string },
): string {
  const eTags = tags.filter((t) => t[0] === "e" && t[1]);
  const root = eTags.find((t) => t[3] === "root" || t[2] === "root");
  if (root?.[1]) return root[1];
  const reply = eTags.find((t) => t[3] === "reply" || t[2] === "reply");
  if (reply?.[1]) return reply[1];
  if (opts.isDm) return `dm-session:${opts.channelId}`;
  return eventId;
}

export function channelIdFromTags(tags: string[][]): string | undefined {
  // NIP-29: ["h", channel-uuid] or ["g", channel-uuid]
  for (const t of tags) {
    if ((t[0] === "h" || t[0] === "g") && t[1]) return t[1];
  }
  return undefined;
}

/** kind:44100/44101 membership — channel UUID from #h. */
export function membershipChannelIdFromTags(tags: string[][]): string | undefined {
  for (const t of tags) {
    if (t[0] === "h" && t[1]) return t[1];
  }
  return undefined;
}

/** NIP-29 membership notification kinds (relay-signed). */
export const BUZZ_MEMBERSHIP_ADDED = 44100;
export const BUZZ_MEMBERSHIP_REMOVED = 44101;

export function isBuzzMembershipKind(kind: number): boolean {
  return kind === BUZZ_MEMBERSHIP_ADDED || kind === BUZZ_MEMBERSHIP_REMOVED;
}
