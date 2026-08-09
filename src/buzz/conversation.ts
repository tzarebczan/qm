/** Thread / delivery target encoding for Buzz surface. */

export function buzzThreadRef(channelId: string, rootEventId?: string): string {
  const root = rootEventId?.trim() || "root";
  return `buzz:${channelId}:${root}`;
}

export function buzzDeliveryTarget(
  channelId: string,
  replyToEventId?: string,
  rootEventId?: string,
): string {
  if (!replyToEventId?.trim()) return `buzz:${channelId}`;
  const parent = replyToEventId.trim().toLowerCase();
  const root = rootEventId?.trim().toLowerCase();
  if (root && root !== parent && /^[0-9a-f]{64}$/i.test(root)) {
    return `buzz:${channelId}:reply:${parent}:root:${root}`;
  }
  return `buzz:${channelId}:reply:${parent}`;
}

export function parseBuzzDeliveryTarget(
  target: string,
): { channelId: string; replyToEventId?: string; rootEventId?: string } | null {
  if (!target.startsWith("buzz:")) return null;
  const rest = target.slice("buzz:".length);
  // buzz:channel:reply:parent:root:rootId
  const withRoot = rest.match(/^([^:]+):reply:([0-9a-f]{64}):root:([0-9a-f]{64})$/i);
  if (withRoot) {
    return {
      channelId: withRoot[1]!,
      replyToEventId: withRoot[2]!.toLowerCase(),
      rootEventId: withRoot[3]!.toLowerCase(),
    };
  }
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
/** NIP-10 marker is index 3 (`["e", id, relay, marker]`). Index 2 only if it is exactly root/reply (no relay URL). */
function eTagMarker(t: string[]): string | undefined {
  if (t[3] === "root" || t[3] === "reply") return t[3];
  // Some clients omit the empty relay field: ["e", id, "root"]
  if ((t[2] === "root" || t[2] === "reply") && t.length === 3) return t[2];
  return undefined;
}

export function rootEventIdFromTags(tags: string[][], eventId?: string): string | undefined {
  const eTags = tags.filter((t) => t[0] === "e" && t[1]);
  const root = eTags.find((t) => eTagMarker(t) === "root" && t[1]);
  if (root?.[1]) return root[1];
  const reply = eTags.find((t) => eTagMarker(t) === "reply" && t[1]);
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
  const fromTags = rootEventIdFromTags(tags, undefined);
  if (fromTags) return fromTags;
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

/**
 * Thread root event id for a NIP-10 reply we will post *to* this message.
 * Prefer explicit root marker; else the message's reply parent (depth-1 threads);
 * else the message itself (top-level → our reply treats it as root).
 */
export function nip10RootForReplyTo(tags: string[][], eventId: string): string {
  // Prefer explicit root marker; else reply-parent (depth-1: parent is root);
  // else this event is the thread root for our outbound reply.
  const fromTags = rootEventIdFromTags(tags, undefined);
  return fromTags ?? eventId;
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
