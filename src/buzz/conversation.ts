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

export function rootEventIdFromTags(tags: string[][]): string | undefined {
  // NIP-10 style: e tags — first "root" marker or first e tag
  const eTags = tags.filter((t) => t[0] === "e" && t[1]);
  const root = eTags.find((t) => t[3] === "root" || t[2] === "root");
  if (root?.[1]) return root[1];
  return eTags[0]?.[1];
}

export function channelIdFromTags(tags: string[][]): string | undefined {
  // NIP-29: ["h", channel-uuid] or ["g", channel-uuid]
  for (const t of tags) {
    if ((t[0] === "h" || t[0] === "g") && t[1]) return t[1];
  }
  return undefined;
}
