import { createHash } from "node:crypto";
import { nip19 } from "nostr-tools";
import type { ActorAssertion } from "../types.ts";
import type { BuzzPluginConfig, BuzzPrincipalMapEntry } from "./config.ts";

/** Normalize hex or npub to lowercase 64-char hex (or lowercased raw if undecodable). */
export function normalizePubkey(raw: string): string {
  const s = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (s.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(s);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      /* fall through */
    }
  }
  return s.toLowerCase();
}

export function buildPrincipalIndex(entries: BuzzPrincipalMapEntry[]): Map<string, BuzzPrincipalMapEntry> {
  const map = new Map<string, BuzzPrincipalMapEntry>();
  for (const e of entries) {
    map.set(normalizePubkey(e.pubkey), e);
  }
  return map;
}

export function resolveBuzzActor(
  cfg: BuzzPluginConfig,
  authorPubkey: string,
  displayNameHint?: string,
): ActorAssertion | null {
  const index = buildPrincipalIndex(cfg.principalMap);
  const hit = index.get(normalizePubkey(authorPubkey));
  if (hit) {
    return {
      externalId: hit.principalId,
      ...(hit.displayName || displayNameHint
        ? { displayName: hit.displayName ?? displayNameHint }
        : {}),
    };
  }
  if (cfg.allowUnmapped && cfg.defaultPrincipalId) {
    return {
      externalId: cfg.defaultPrincipalId,
      ...(displayNameHint ? { displayName: displayNameHint } : {}),
    };
  }
  if (cfg.allowUnmapped) {
    // Stable synthetic principal — internal but not mapped to email admin
    const short = createHash("sha256").update(authorPubkey).digest("hex").slice(0, 12);
    return {
      externalId: `buzz:${short}`,
      displayName: displayNameHint ?? `buzz-${short}`,
    };
  }
  return null;
}

export function contentMentionsBot(cfg: BuzzPluginConfig, content: string, botPubkeyHex: string): boolean {
  const lower = content.toLowerCase();
  const name = cfg.botName.toLowerCase();
  // Prefer explicit @Name so bare words like "bot" in prose do not fire.
  if (name && lower.includes(`@${name}`)) return true;
  for (const kw of cfg.mentionKeywords) {
    if (!kw) continue;
    if (kw.length <= 2) {
      if (new RegExp(`\\b${escapeRe(kw)}\\b`, "i").test(content)) return true;
    } else if (lower.includes(kw)) {
      return true;
    }
  }
  // p-tag mention of bot is checked by caller via tags
  void botPubkeyHex;
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tagsMentionPubkey(tags: string[][], pubkeyHex: string): boolean {
  const want = pubkeyHex.toLowerCase();
  return tags.some((t) => t[0] === "p" && t[1]?.toLowerCase() === want);
}

/** Leading @token in message body (display mention), if any. */
export function leadingAtName(content: string): string | undefined {
  const m = content.trim().match(/^@([A-Za-z0-9_.-]{1,64})\b/);
  return m?.[1]?.toLowerCase();
}

function botNameTokens(cfg: BuzzPluginConfig): Set<string> {
  const out = new Set<string>();
  const push = (s: string) => {
    const t = s.trim().toLowerCase();
    if (!t) return;
    out.add(t);
    out.add(t.replace(/\s+/g, "-"));
    out.add(t.replace(/[\s-]+/g, ""));
  };
  push(cfg.botName);
  push(cfg.agentId);
  for (const kw of cfg.mentionKeywords) push(kw);
  return out;
}

export function isBotAtName(cfg: BuzzPluginConfig, name: string): boolean {
  const tokens = botNameTokens(cfg);
  const n = name.trim().toLowerCase();
  if (tokens.has(n)) return true;
  if (tokens.has(n.replace(/-/g, ""))) return true;
  return false;
}

/**
 * Message is clearly for another human, not the bot:
 * - has p-tag(s) for others and none for the bot, and content does not @bot
 * - OR starts with @Someone who is not the bot
 */
export function isAddressedToOtherOnly(
  cfg: BuzzPluginConfig,
  content: string,
  tags: string[][],
  botPubkeyHex: string,
): boolean {
  if (contentMentionsBot(cfg, content, botPubkeyHex)) return false;
  if (tagsMentionPubkey(tags, botPubkeyHex)) return false;

  const lead = leadingAtName(content);
  if (lead && !isBotAtName(cfg, lead)) return true;

  const pOthers = tags.filter(
    (t) => t[0] === "p" && t[1] && t[1].toLowerCase() !== botPubkeyHex.toLowerCase(),
  );
  if (pOthers.length > 0) return true;

  return false;
}

/** Event ids referenced by NIP-10 e-tags (root/reply/any). */
export function referencedEventIds(tags: string[][]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (t[0] === "e" && t[1] && /^[0-9a-f]{64}$/i.test(t[1])) out.push(t[1].toLowerCase());
  }
  return out;
}
