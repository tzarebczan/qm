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
  if (name && (lower.includes(`@${name}`) || lower.includes(name))) {
    // keyword alone is weak; require @name or keyword from list with word boundary for short names
    if (lower.includes(`@${name}`)) return true;
  }
  for (const kw of cfg.mentionKeywords) {
    if (!kw) continue;
    if (kw.length <= 2) {
      if (new RegExp(`\\b${escapeRe(kw)}\\b`, "i").test(content)) return true;
    } else if (lower.includes(kw)) return true;
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
