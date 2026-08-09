/**
 * Durable scout state: cards + per-channel cursors/held items.
 * Default path: $DATA_DIR/buzz-scout/cards.json
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScoutCard, ScoutProposal } from "./proactive.ts";

export type ChannelScoutState = {
  /** Fingerprint of human msg ids last judged (skip re-judge if unchanged). */
  lastFingerprint?: string;
  lastJudgeAt?: number;
  /** Soft proposals not worth a channel ping yet. */
  held?: ScoutProposal[];
  heldSince?: number;
};

export type ScoutStoreSnapshot = {
  version: 2;
  updatedAt: number;
  cards: ScoutCard[];
  channels?: Record<string, ChannelScoutState>;
};

export function defaultScoutStorePath(): string {
  const data = process.env.DATA_DIR?.trim() || process.env.BUZZ_SCOUT_DATA?.trim() || "/data";
  return process.env.BUZZ_SCOUT_STORE?.trim() || join(data, "buzz-scout", "cards.json");
}

export function loadScoutState(path = defaultScoutStorePath()): {
  cards: Map<string, ScoutCard>;
  channels: Map<string, ChannelScoutState>;
} {
  const cards = new Map<string, ScoutCard>();
  const channels = new Map<string, ChannelScoutState>();
  try {
    if (!existsSync(path)) return { cards, channels };
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ScoutStoreSnapshot & { version?: number };
    if (!parsed || !Array.isArray(parsed.cards)) return { cards, channels };
    const cutoff = Date.now() - 14 * 24 * 3600_000;
    for (const c of parsed.cards) {
      if (!c?.cardEventId || !c.channelId || !Array.isArray(c.proposals)) continue;
      if ((c.createdAt ?? 0) < cutoff && c.status !== "open" && c.status !== "partial") continue;
      mapCard(cards, c);
    }
    if (parsed.channels && typeof parsed.channels === "object") {
      for (const [ch, st] of Object.entries(parsed.channels)) {
        if (!ch || !st) continue;
        channels.set(ch, {
          ...(st.lastFingerprint ? { lastFingerprint: st.lastFingerprint } : {}),
          ...(st.lastJudgeAt ? { lastJudgeAt: st.lastJudgeAt } : {}),
          ...(Array.isArray(st.held) ? { held: st.held } : {}),
          ...(st.heldSince ? { heldSince: st.heldSince } : {}),
        });
      }
    }
  } catch (err) {
    console.warn("[buzz-scout] store load failed:", (err as Error).message);
  }
  return { cards, channels };
}

function mapCard(map: Map<string, ScoutCard>, c: ScoutCard): void {
  map.set(c.cardEventId.toLowerCase(), {
    ...c,
    cardEventId: c.cardEventId.toLowerCase(),
    status:
      c.status === "executed" || c.status === "dismissed" || c.status === "partial" || c.status === "held"
        ? c.status
        : "open",
  });
}

/** @deprecated use loadScoutState */
export function loadScoutCards(path = defaultScoutStorePath()): Map<string, ScoutCard> {
  return loadScoutState(path).cards;
}

export function saveScoutState(
  cards: Map<string, ScoutCard>,
  channels: Map<string, ChannelScoutState>,
  path = defaultScoutStorePath(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const list = [...cards.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500);
    const chObj: Record<string, ChannelScoutState> = {};
    for (const [k, v] of channels) chObj[k] = v;
    const snap: ScoutStoreSnapshot = {
      version: 2,
      updatedAt: Date.now(),
      cards: list,
      channels: chObj,
    };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    console.warn("[buzz-scout] store save failed:", (err as Error).message);
  }
}

export function saveScoutCards(cards: Map<string, ScoutCard>, path = defaultScoutStorePath()): void {
  const { channels } = loadScoutState(path);
  saveScoutState(cards, channels, path);
}
