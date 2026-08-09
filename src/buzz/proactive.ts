/**
 * Proactive scout for Buzz channels (dedicated Egg-Scout identity or combined).
 *
 * Flow:
 *  1. Buffer kind:9; scan on interval or command
 *  2. Judge → proposals with kinds + multi-emoji legend
 *  3. Persist card to disk; post card
 *  4. Anyone reacts kind:7 → approve / dismiss / by-index / by-kind
 *  5. Handoff: @Egg-Brain with full context (two-bot), or self-execute (combined)
 */
import type { BuzzCoreClient, BuzzTurnBody } from "../api/buzz-core-client.ts";
import type { BuzzPluginConfig } from "./config.ts";
import { channelIdFromTags } from "./conversation.ts";
import { contentMentionsBot, tagsMentionPubkey } from "./identity.ts";
import {
  deleteMessageViaHolder,
  publishViaHolder,
  reactViaHolder,
  type BuzzRelayClient,
  type BuzzRelayHolder,
  type NostrEvent,
} from "./relay.ts";
import { sanitizeBuzzOutbound } from "./sanitize.ts";
import {
  defaultScoutStorePath,
  loadScoutState,
  saveScoutState,
  type ChannelScoutState,
} from "./scout-store.ts";

export type ProposalKind = "general" | "crm" | "research" | "reply" | "outreach";
export type ProposalPriority = "high" | "normal" | "low";

export type ScoutProposal = {
  id: string;
  title: string;
  action: string;
  context: string;
  kind: ProposalKind;
  /** high = always channel; low = hold unless forced/aged */
  priority?: ProposalPriority;
  sourceEventId?: string;
  /** Index emoji 1️⃣… */
  emoji: string;
  /** True after this item was executed (partial cards). */
  done?: boolean;
};

export type ScoutCard = {
  cardEventId: string;
  channelId: string;
  createdAt: number;
  proposals: ScoutProposal[];
  /** Anyone in the community may react (no ACL). */
  status: "open" | "executed" | "dismissed" | "partial" | "held";
};

const INDEX_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣"] as const;

const KIND_META: Record<
  ProposalKind,
  { emoji: string; label: string }
> = {
  general: { emoji: "⚡", label: "general" },
  crm: { emoji: "📇", label: "CRM" },
  research: { emoji: "🔍", label: "research" },
  reply: { emoji: "💬", label: "reply" },
  outreach: { emoji: "📨", label: "outreach" },
};

const APPROVE_ALL = expandSkin("👍", ["✅", "✔", "☑️", "💯", ":+1:", ":thumbsup:"]);
const DISMISS = expandSkin("👎", [
  "❌",
  "✖️",
  "✖",
  "❎",
  "🚫",
  "x",
  "X",
  ":-1:",
  ":thumbsdown:",
  ":x:",
  ":no_entry:",
]);
const RESCAN = new Set(["🔄", "🔃", "🔁", ":arrows_counterclockwise:"]);

function expandSkin(base: string, extra: string[]): Set<string> {
  const tones = ["", "🏻", "🏼", "🏽", "🏾", "🏿"];
  const s = new Set<string>(extra);
  for (const t of tones) s.add(base + t);
  return s;
}

function normalizeEmoji(raw: string): string {
  // strip VS16 / ZWJ noise for matching simple cases
  return raw.trim().replace(/\uFE0F/g, "");
}

function emojiMatches(set: Set<string>, raw: string): boolean {
  const e = normalizeEmoji(raw);
  if (set.has(raw.trim()) || set.has(e)) return true;
  for (const x of set) {
    if (normalizeEmoji(x) === e) return true;
  }
  return false;
}

function indexFromEmoji(raw: string): number | null {
  const e = raw.trim();
  const i = INDEX_EMOJI.indexOf(e as (typeof INDEX_EMOJI)[number]);
  if (i >= 0) return i;
  // some clients send keycap forms without variation
  const alt = ["1\u20e3", "2\u20e3", "3\u20e3", "4\u20e3", "5\u20e3", "6\u20e3", "7\u20e3", "8\u20e3"];
  const j = alt.indexOf(e);
  return j >= 0 ? j : null;
}

function kindFromEmoji(raw: string): ProposalKind | null {
  const e = normalizeEmoji(raw);
  for (const [kind, meta] of Object.entries(KIND_META) as [ProposalKind, { emoji: string }][]) {
    if (normalizeEmoji(meta.emoji) === e || raw.trim() === meta.emoji) return kind;
  }
  return null;
}

function parseKind(raw: unknown): ProposalKind {
  const s = String(raw ?? "general").toLowerCase();
  if (s === "crm" || s === "crm_update" || s === "pipeline") return "crm";
  if (s === "research" || s === "lookup" || s === "investigate") return "research";
  if (s === "reply" || s === "message" || s === "respond") return "reply";
  if (s === "outreach" || s === "email" || s === "contact") return "outreach";
  return "general";
}

/** Explicit human scan request only — never match prose like "follow-ups" mid-reply. */
export function isScoutCommand(
  content: string,
  cfg: BuzzPluginConfig,
  botPubkey: string,
  tags: string[][],
): boolean {
  const text = content.trim();
  if (/\[\[scout:(scan|now|rescan)\]\]/i.test(text)) return true;

  const addressed =
    tagsMentionPubkey(tags, botPubkey) || contentMentionsBot(cfg, text, botPubkey);

  // Must be a deliberate scan phrase (not "execute these follow-ups" from the Brain).
  const explicitScan =
    /\bscout\s+(scan|rescan|now)\b/i.test(text) ||
    /\b(scan|rescan)\s+(the\s+)?(channel|room|here)\b/i.test(text) ||
    /\bproactive\s+scan\b/i.test(text) ||
    /\bsuggest\s+follow-?ups\b/i.test(text) ||
    /^\/?(scan|rescan)\s*$/i.test(text);

  if (cfg.proactiveOnly) {
    // @Egg-Scout alone or with explicit scan language
    if (addressed && (explicitScan || text.length < 80)) return true;
    return explicitScan;
  }
  if (!addressed) return false;
  return explicitScan;
}

function formatCard(botName: string, proposals: ScoutProposal[], scanned: number): string {
  const kindsUsed = new Set(proposals.map((p) => p.kind));
  const lines: string[] = [
    `**Scout** (@${botName}) — ${proposals.length} proposal${proposals.length === 1 ? "" : "s"} (~${scanned} msgs)`,
    // Do NOT name the executor bot here (keyword match would wake it).
    `_React with emoji to approve. Do not @ the executor on this card._`,
    "",
  ];
  for (const p of proposals) {
    const km = KIND_META[p.kind];
    const done = p.done ? " ~~done~~" : "";
    lines.push(`${p.emoji} ${km.emoji} **${p.title}** \`${km.label}\`${done}`);
    lines.push(`   ${p.action}`);
    if (p.context.trim()) lines.push(`   _${p.context.trim().slice(0, 220)}_`);
    lines.push("");
  }
  lines.push("**React (anyone):**");
  lines.push("• 1️⃣… — run that item");
  const kindLine = [...kindsUsed].map((k) => `${KIND_META[k].emoji} all ${KIND_META[k].label}`).join(" · ");
  if (kindLine) lines.push(`• By type: ${kindLine}`);
  lines.push("• 👍 / ✅ — run **all** open items");
  lines.push("• 👎 / ❌ — dismiss card");
  lines.push("• 🔄 — rescan channel now");
  return lines.join("\n").trim();
}

function parsePriority(raw: unknown, kind: ProposalKind): ProposalPriority {
  const s = String(raw ?? "").toLowerCase();
  if (s === "high" || s === "urgent" || s === "p0") return "high";
  if (s === "low" || s === "soft" || s === "minor" || s === "nit") return "low";
  if (s === "normal" || s === "medium") return "normal";
  // defaults by kind
  if (kind === "reply" || kind === "research") return "low";
  if (kind === "crm" || kind === "outreach") return "normal";
  return "normal";
}

function parseProposalsJson(raw: string, max: number): ScoutProposal[] {
  const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(raw);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]) as { proposals?: unknown[] } | unknown[];
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.proposals) ? parsed.proposals : [];
    const out: ScoutProposal[] = [];
    for (let i = 0; i < list.length && out.length < max; i++) {
      const row = list[i] as Record<string, unknown>;
      if (!row || typeof row !== "object") continue;
      const title = String(row.title ?? row.name ?? "").trim();
      const action = String(row.action ?? row.do ?? row.task ?? "").trim();
      if (!title || !action) continue;
      const kind = parseKind(row.kind ?? row.type ?? row.category);
      const priority = parsePriority(row.priority ?? row.urgency, kind);
      const src =
        typeof row.source_event_id === "string" && /^[0-9a-f]{64}$/i.test(row.source_event_id)
          ? row.source_event_id.toLowerCase()
          : typeof row.sourceEventId === "string" && /^[0-9a-f]{64}$/i.test(row.sourceEventId)
            ? row.sourceEventId.toLowerCase()
            : undefined;
      out.push({
        id: `p${out.length + 1}`,
        title: title.slice(0, 120),
        action: action.slice(0, 500),
        context: String(row.context ?? row.why ?? row.evidence ?? "").trim().slice(0, 400),
        kind,
        priority,
        emoji: INDEX_EMOJI[out.length] ?? "➡️",
        ...(src ? { sourceEventId: src } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Channel-worthy vs hold (token/noise control). */
export function splitMaterial(
  proposals: ScoutProposal[],
  opts?: { force?: boolean },
): { channel: ScoutProposal[]; hold: ScoutProposal[] } {
  if (opts?.force) return { channel: proposals, hold: [] };
  const channel: ScoutProposal[] = [];
  const hold: ScoutProposal[] = [];
  for (const p of proposals) {
    const pri = p.priority ?? "normal";
    if (pri === "high") {
      channel.push(p);
      continue;
    }
    if (pri === "low") {
      hold.push(p);
      continue;
    }
    // normal: channel if crm/outreach or meaty action; else hold
    if (
      (p.kind === "crm" || p.kind === "outreach") &&
      (p.action.length >= 40 || (p.context?.length ?? 0) >= 40)
    ) {
      channel.push(p);
    } else if (p.action.length >= 120) {
      channel.push(p);
    } else {
      hold.push(p);
    }
  }
  // Single normal item alone is still a channel ping only if substantial
  if (channel.length === 1 && (channel[0]!.priority ?? "normal") !== "high") {
    const only = channel[0]!;
    if (only.action.length < 80 && only.kind !== "crm" && only.kind !== "outreach") {
      hold.push(only);
      return { channel: [], hold };
    }
  }
  return { channel, hold };
}

function fingerprintMessages(messages: NostrEvent[]): string {
  return messages
    .map((m) => m.id)
    .slice(-30)
    .join(",");
}

function selectFromReaction(card: ScoutCard, emojiRaw: string): {
  selected: ScoutProposal[];
  dismiss?: boolean;
  rescan?: boolean;
  mode: string;
} {
  if (emojiMatches(DISMISS, emojiRaw)) return { selected: [], dismiss: true, mode: "dismiss" };
  if (RESCAN.has(emojiRaw.trim()) || RESCAN.has(normalizeEmoji(emojiRaw))) {
    return { selected: [], rescan: true, mode: "rescan" };
  }
  const open = () => card.proposals.filter((p) => !p.done);
  if (emojiMatches(APPROVE_ALL, emojiRaw)) {
    return { selected: open(), mode: "all" };
  }
  const idx = indexFromEmoji(emojiRaw);
  if (idx !== null) {
    const p = card.proposals[idx];
    if (p && !p.done) return { selected: [p], mode: `index:${idx + 1}` };
    return { selected: [], mode: "index-miss" };
  }
  const kind = kindFromEmoji(emojiRaw);
  if (kind) {
    return {
      selected: open().filter((p) => p.kind === kind),
      mode: `kind:${kind}`,
    };
  }
  return { selected: [], mode: "unknown" };
}

export function createBuzzProactive(deps: {
  cfg: BuzzPluginConfig;
  core: BuzzCoreClient;
  relayHolder: BuzzRelayHolder;
  botPubkey: string;
  recentByChannel: Map<string, NostrEvent[]>;
  /** Egg-Brain (or executor) pubkey hex for @handoff. */
  handoffPubkey?: string;
  handoffName?: string;
  /** Other bot pubkeys to exclude from buffer/judge (anti-loop). */
  siblingPubkeys?: string[];
}): {
  onKind9(ev: NostrEvent): void;
  onKind7(ev: NostrEvent): void;
  start(): void;
  stop(): void;
  scanNow(channelId: string, trigger?: NostrEvent, force?: boolean): Promise<void>;
} {
  const logPrefix = `[buzz-scout:${deps.cfg.agentId}]`;
  const storePath = defaultScoutStorePath();
  const loaded = loadScoutState(storePath);
  const cards = loaded.cards;
  const channelState = loaded.channels;
  console.log(
    `${logPrefix} loaded ${cards.size} card(s), ${channelState.size} ch-state from ${storePath}`,
  );

  const MAX_CARDS = 400;
  const MAX_RECENT = 80;
  /** Min gap between auto cards per channel (ms). */
  const CARD_COOLDOWN_MS = Math.max(
    60_000,
    Number(process.env.BUZZ_SCOUT_CARD_COOLDOWN_SEC || 45 * 60) * 1000,
  );
  /** Held soft items flush to channel after this age (ms). Default 12h. */
  const HELD_FLUSH_MS = Math.max(
    3_600_000,
    Number(process.env.BUZZ_SCOUT_HELD_FLUSH_SEC || 12 * 3600) * 1000,
  );
  /** Min new human msgs before spending a judge turn (scheduled). */
  const MIN_NEW_FOR_JUDGE = Math.max(1, Number(process.env.BUZZ_SCOUT_MIN_NEW || 2));
  /** Optional DM channel UUID for soft digests (else hold until flush). */
  const softDmChannel = process.env.BUZZ_SCOUT_DM_CHANNEL?.trim() || "";
  let timer: NodeJS.Timeout | null = null;
  /** Per-channel scan locks (don't block other channels). */
  const scanningCh = new Set<string>();
  let stopped = false;
  const principal =
    deps.cfg.defaultPrincipalId?.trim() ||
    deps.cfg.principalMap[0]?.principalId ||
    "scout@local";
  const handoffName = deps.handoffName?.trim() || deps.cfg.proactiveHandoffName || "Egg-Brain";
  const handoffPubkey = (deps.handoffPubkey || deps.cfg.proactiveHandoffPubkey || "").toLowerCase();
  const ignorePubkeys = new Set<string>(
    [deps.botPubkey, handoffPubkey, ...(deps.siblingPubkeys ?? [])]
      .map((p) => p.toLowerCase())
      .filter((p) => /^[0-9a-f]{64}$/i.test(p)),
  );

  function isBotTraffic(ev: NostrEvent): boolean {
    if (ignorePubkeys.has(ev.pubkey.toLowerCase())) return true;
    // Scout/brain surface tags
    if (ev.tags.some((t) => t[0] === "client" && /qm-buzz/i.test(t[1] || ""))) return true;
    return false;
  }

  function openCardFor(channelId: string): ScoutCard | undefined {
    for (const c of cards.values()) {
      if (c.channelId === channelId && (c.status === "open" || c.status === "partial")) return c;
    }
    return undefined;
  }

  function lastCardAt(channelId: string): number {
    let max = 0;
    for (const c of cards.values()) {
      if (c.channelId === channelId && c.createdAt > max) max = c.createdAt;
    }
    return max;
  }

  function persist(): void {
    if (cards.size > MAX_CARDS) {
      const sorted = [...cards.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
      cards.clear();
      for (const [k, v] of sorted.slice(0, MAX_CARDS)) cards.set(k, v);
    }
    saveScoutState(cards, channelState, storePath);
  }

  function rememberCard(card: ScoutCard): void {
    cards.set(card.cardEventId.toLowerCase(), card);
    persist();
  }

  function chState(channelId: string): ChannelScoutState {
    let st = channelState.get(channelId);
    if (!st) {
      st = {};
      channelState.set(channelId, st);
    }
    return st;
  }

  function humanMessages(channelId: string): NostrEvent[] {
    return (deps.recentByChannel.get(channelId) ?? []).filter(
      (m) => !ignorePubkeys.has(m.pubkey.toLowerCase()),
    );
  }

  function bufferMessage(ev: NostrEvent): void {
    if (ev.kind !== 9) return;
    if (isBotTraffic(ev)) return; // never feed bot chatter into scout
    const ch = channelIdFromTags(ev.tags);
    if (!ch) return;
    if (deps.cfg.channelIds.length && !deps.cfg.channelIds.includes(ch)) return;
    const list = deps.recentByChannel.get(ch) ?? [];
    if (list.some((e) => e.id === ev.id)) return;
    list.push(ev);
    list.sort((a, b) => a.created_at - b.created_at);
    while (list.length > MAX_RECENT) list.shift();
    deps.recentByChannel.set(ch, list);
  }

  async function judge(channelId: string, messages: NostrEvent[]): Promise<ScoutProposal[]> {
    // Cap context hard — judge burns tokens.
    const lines = messages
      .filter((m) => !ignorePubkeys.has(m.pubkey.toLowerCase()))
      .filter((m) => !/^\*\*Scout\*\*/i.test(m.content || ""))
      .filter((m) => !/\[Scout approved/i.test(m.content || ""))
      .slice(-24)
      .map((m) => {
        const text = (m.content || "").replace(/\n/g, " ").slice(0, 180);
        return `[${m.id}] ${m.pubkey.slice(0, 8)}: ${text}`;
      });
    if (!lines.length) return [];

    const prompt =
      "Egg-Scout. Human channel msgs only. " +
      `Max ${deps.cfg.proactiveMaxProposals} proposals. Prefer [] unless action is clearly worth a human's time. ` +
      "Each: title, action, context, kind (general|crm|research|reply|outreach), priority (high|normal|low), optional source_event_id. " +
      "priority=low for nits/FYI; high only if time-sensitive or blocked work. " +
      "Skip chatter, bots, permission loops, re-scouting. " +
      'JSON only: {"proposals":[...]}. Empty ok.\n\n' +
      lines.join("\n");

    const body: BuzzTurnBody = {
      actor: { externalId: principal, displayName: `${deps.cfg.botName} scout` },
      conversation: {
        kind: "channel",
        threadRef: `buzz-scout:${channelId}:judge`,
        channelRef: channelId,
        channelName: channelId,
        audience: [{ externalId: principal }],
      },
      text: prompt,
      liveActor: false,
      origin: { kind: "automation", screenData: "buzz-scout-judge" },
      gatewayContext: {
        location: "Buzz scout judgment",
        details: { surface: "buzz", agent_id: deps.cfg.agentId, scout: "judge", channel_id: channelId },
        instructions:
          "Internal scout only. JSON proposals or empty. Be stingy — silence preferred. No tools.",
        botName: deps.cfg.botName,
      },
      async: true,
    };

    try {
      const queued = await deps.core.submitTurn(body);
      let result = queued;
      if (queued.status === "queued" && queued.runId) {
        result = (await deps.core.waitRun(queued.runId)) ?? queued;
      }
      if (result.status === "silent") return [];
      return parseProposalsJson((result.reply ?? "").trim(), deps.cfg.proactiveMaxProposals);
    } catch (err) {
      console.error(`${logPrefix} judge failed:`, (err as Error).message);
      return [];
    }
  }

  /** Post @Egg-Brain work package so reactive Brain executes (two-bot path). */
  async function handoffToExecutor(
    card: ScoutCard,
    selected: ScoutProposal[],
    reactorPubkey: string,
  ): Promise<void> {
    const brief = selected
      .map(
        (p, i) =>
          `${i + 1}. [${p.kind}] ${p.title}\n   Action: ${p.action}\n   Context: ${p.context || "(none)"}` +
          (p.sourceEventId ? `\n   Source: ${p.sourceEventId}` : ""),
      )
      .join("\n\n");

    // Marker line is intentional — Brain must only treat this as work, not proposal cards.
    const mention = handoffName.startsWith("@") ? handoffName : `@${handoffName}`;
    const content =
      `${mention} [Scout-approved work package]\n\n` +
      `Approver ${reactorPubkey.slice(0, 12)}… · card ${card.cardEventId.slice(0, 12)}\n\n` +
      `Do ONLY the approved items below. One short status reply when finished. ` +
      `Do not pre-check other card items. Do not ask for go-ahead (emoji already approved). ` +
      `If an item is impossible (no API), say so in one line and skip it — do not essay.\n\n` +
      `${brief}`;

    const replyTo = selected[0]?.sourceEventId ?? card.cardEventId;
    const pTags =
      handoffPubkey && /^[0-9a-f]{64}$/i.test(handoffPubkey) ? [handoffPubkey] : undefined;
    await publishViaHolder(
      deps.relayHolder,
      card.channelId,
      sanitizeBuzzOutbound(content),
      replyTo,
      replyTo,
      8,
      pTags,
      "qm-buzz-scout-handoff",
    );
    console.log(
      `${logPrefix} handoff → ${handoffName} items=${selected.length} card=${card.cardEventId.slice(0, 12)}…`,
    );
  }

  async function selfExecute(card: ScoutCard, selected: ScoutProposal[]): Promise<void> {
    const brief = selected
      .map(
        (p, i) =>
          `${i + 1}. [${p.kind}] ${p.title}\n   Action: ${p.action}\n   Context: ${p.context || "(none)"}`,
      )
      .join("\n\n");
    const replyTo = selected[0]?.sourceEventId ?? card.cardEventId;
    const text =
      `[Scout approved — execute]\n\n${brief}\n\n` +
      `Do the work with tools when possible. Reply with status. Concise.`;

    const body: BuzzTurnBody = {
      actor: { externalId: principal, displayName: `${deps.cfg.botName}` },
      conversation: {
        kind: "channel",
        threadRef: `buzz:${card.channelId}:${replyTo}`,
        channelRef: card.channelId,
        channelName: card.channelId,
        audience: [{ externalId: principal }],
      },
      text,
      deliveryTarget: `buzz:${card.channelId}:reply:${replyTo}`,
      liveActor: true,
      origin: { kind: "automation", screenData: "buzz-scout-execute" },
      gatewayContext: {
        location: "Buzz scout-approved follow-up",
        details: {
          surface: "buzz",
          agent_id: deps.cfg.agentId,
          scout: "execute",
          channel_id: card.channelId,
          card_event_id: card.cardEventId,
        },
        instructions: `You are @${deps.cfg.botName} executing scout-approved items. Use tools. Clear status reply. ASCII punctuation.`,
        botName: deps.cfg.botName,
      },
      async: true,
      ...(deps.cfg.defaultHarnessId ? { harness: deps.cfg.defaultHarnessId } : {}),
      ...(deps.cfg.defaultModelId ? { model: deps.cfg.defaultModelId } : {}),
    };

    const queued = await deps.core.submitTurn(body);
    let result = queued;
    let runId: string | undefined;
    if (queued.status === "queued" && queued.runId) {
      runId = queued.runId;
      if (queued.steered) {
        console.log(`${logPrefix} execute steered ${runId.slice(0, 8)}…`);
        return;
      }
      result = (await deps.core.waitRun(runId)) ?? queued;
    }
    if (result.status === "silent") return;
    const replyText =
      result.status === "ok"
        ? (result.reply ?? "").trim() || "(done)"
        : `Scout execute ${result.status}: ${result.reason ?? ""}`;
    await publishViaHolder(
      deps.relayHolder,
      card.channelId,
      sanitizeBuzzOutbound(replyText).slice(0, 60_000),
      replyTo,
      replyTo,
    );
    if (runId) void deps.core.ackRunDelivery(runId).catch(() => {});
  }

  async function executeSelected(
    card: ScoutCard,
    selected: ScoutProposal[],
    reactorPubkey: string,
  ): Promise<void> {
    if (!selected.length) return;
    try {
      await reactViaHolder(deps.relayHolder, card.cardEventId, "⚡");
    } catch {
      /* non-fatal */
    }

    try {
      if (handoffPubkey || deps.cfg.proactiveHandoff) {
        await handoffToExecutor(card, selected, reactorPubkey);
      } else {
        await selfExecute(card, selected);
      }
      for (const p of selected) p.done = true;
      const remaining = card.proposals.some((p) => !p.done);
      card.status = remaining ? "partial" : "executed";
      rememberCard(card);
    } catch (err) {
      console.error(`${logPrefix} execute failed:`, (err as Error).message);
      try {
        await publishViaHolder(
          deps.relayHolder,
          card.channelId,
          `Scout could not run approved items: ${(err as Error).message}`,
          card.cardEventId,
          card.cardEventId,
        );
      } catch {
        /* ignore */
      }
    }
  }

  async function postChannelCard(
    channelId: string,
    proposals: ScoutProposal[],
    scanned: number,
  ): Promise<void> {
    // re-index emojis 1..n
    const numbered = proposals.map((p, i) => ({
      ...p,
      id: `p${i + 1}`,
      emoji: INDEX_EMOJI[i] ?? "➡️",
    }));
    const content = formatCard(deps.cfg.botName, numbered, scanned);
    const published = await publishViaHolder(
      deps.relayHolder,
      channelId,
      sanitizeBuzzOutbound(content),
      undefined,
      undefined,
      8,
      undefined,
      "qm-buzz-scout",
    );
    rememberCard({
      cardEventId: published.id.toLowerCase(),
      channelId,
      createdAt: Date.now(),
      proposals: numbered,
      status: "open",
    });
    console.log(`${logPrefix} card ${published.id.slice(0, 12)}… n=${numbered.length}`);
  }

  async function maybeDmHeld(channelId: string, held: ScoutProposal[]): Promise<void> {
    if (!softDmChannel || !held.length) return;
    const lines = held.slice(0, 6).map(
      (p, i) => `${i + 1}. [${p.kind}/${p.priority ?? "low"}] ${p.title}\n   ${p.action.slice(0, 160)}`,
    );
    const text =
      `Scout soft hold (${channelId.slice(0, 8)}…) — not worth a channel ping yet:\n\n` +
      lines.join("\n\n") +
      `\n\nReply \`@Egg-Scout scan\` in-channel if you want these raised publicly.`;
    try {
      await publishViaHolder(deps.relayHolder, softDmChannel, sanitizeBuzzOutbound(text));
      console.log(`${logPrefix} soft DM digest n=${held.length}`);
    } catch (err) {
      console.warn(`${logPrefix} soft DM failed:`, (err as Error).message);
    }
  }

  async function scanNow(
    channelId: string,
    trigger?: NostrEvent,
    force = false,
  ): Promise<void> {
    if (scanningCh.has(channelId)) {
      console.log(`${logPrefix} skip ch=${channelId.slice(0, 8)}… already scanning`);
      return;
    }
    scanningCh.add(channelId);
    try {
      const open = openCardFor(channelId);
      if (open) {
        // Quiet: no channel spam. Log only. Command gets 🔎 only.
        console.log(
          `${logPrefix} quiet: open card ${open.cardEventId.slice(0, 12)}… ch=${channelId.slice(0, 8)}`,
        );
        if (trigger) {
          try {
            await reactViaHolder(deps.relayHolder, trigger.id, "📌");
          } catch {
            /* ignore */
          }
        }
        return;
      }

      const lastAt = lastCardAt(channelId);
      if (!force && lastAt && Date.now() - lastAt < CARD_COOLDOWN_MS) {
        console.log(`${logPrefix} quiet: cooldown ch=${channelId.slice(0, 8)}`);
        return;
      }

      const messages = humanMessages(channelId);
      if (messages.length < 1) {
        console.log(`${logPrefix} quiet: no human msgs ch=${channelId.slice(0, 8)}`);
        return;
      }

      const fp = fingerprintMessages(messages);
      const st = chState(channelId);
      const held = [...(st.held ?? [])];
      const heldAge = st.heldSince ? Date.now() - st.heldSince : 0;
      const unchanged = st.lastFingerprint === fp;

      // No new human activity → do not spend a judge turn (unless forced command).
      if (!force && unchanged) {
        // Aged holds may still flush without re-judging
        if (held.length && heldAge >= HELD_FLUSH_MS) {
          console.log(`${logPrefix} flush aged holds n=${held.length} ch=${channelId.slice(0, 8)}`);
          await postChannelCard(channelId, held, messages.length);
          st.held = [];
          st.heldSince = undefined;
          persist();
        } else {
          console.log(`${logPrefix} quiet: no new activity ch=${channelId.slice(0, 8)}`);
        }
        return;
      }

      // Scheduled: need enough *new* traffic vs last fingerprint
      if (!force && st.lastFingerprint) {
        const prev = new Set(st.lastFingerprint.split(",").filter(Boolean));
        const newCount = messages.filter((m) => !prev.has(m.id)).length;
        if (newCount < MIN_NEW_FOR_JUDGE && held.length === 0) {
          console.log(
            `${logPrefix} quiet: only ${newCount} new msg(s) ch=${channelId.slice(0, 8)} (need ${MIN_NEW_FOR_JUDGE})`,
          );
          return;
        }
      }

      if (trigger) {
        try {
          await reactViaHolder(deps.relayHolder, trigger.id, "🔎");
        } catch {
          /* ignore */
        }
      }

      console.log(
        `${logPrefix} judge ch=${channelId.slice(0, 8)}… n=${messages.length} force=${force}`,
      );
      const proposals = await judge(channelId, messages);
      st.lastFingerprint = fp;
      st.lastJudgeAt = Date.now();

      const merged = [...held, ...proposals];
      // de-dupe by title
      const seenTitle = new Set<string>();
      const unique: ScoutProposal[] = [];
      for (const p of merged) {
        const k = p.title.toLowerCase();
        if (seenTitle.has(k)) continue;
        seenTitle.add(k);
        unique.push(p);
      }

      if (!unique.length) {
        st.held = [];
        st.heldSince = undefined;
        persist();
        console.log(`${logPrefix} quiet: empty judge ch=${channelId.slice(0, 8)}`);
        return;
      }

      const { channel: toPost, hold: toHold } = splitMaterial(unique, { force });
      // Age flush: if holds are old and we have any channel-worthy, or force, etc.
      let postList = toPost;
      let holdList = toHold;
      if (!force && !postList.length && holdList.length && heldAge >= HELD_FLUSH_MS) {
        postList = holdList;
        holdList = [];
      }

      st.held = holdList.slice(0, 12);
      if (holdList.length && !st.heldSince) st.heldSince = Date.now();
      if (!holdList.length) st.heldSince = undefined;
      persist();

      if (holdList.length) {
        console.log(`${logPrefix} holding ${holdList.length} soft item(s) ch=${channelId.slice(0, 8)}`);
        // Occasional soft DM (not channel) when holds stack and we have a DM target
        if (holdList.length >= 3 || heldAge >= HELD_FLUSH_MS / 2) {
          await maybeDmHeld(channelId, holdList);
        }
      }

      if (!postList.length) {
        console.log(`${logPrefix} quiet: nothing channel-worthy ch=${channelId.slice(0, 8)}`);
        return;
      }

      await postChannelCard(channelId, postList.slice(0, deps.cfg.proactiveMaxProposals), messages.length);
    } finally {
      scanningCh.delete(channelId);
    }
  }

  /** Dedupe reaction events (live + catch-up REQ). */
  const seenReactions = new Set<string>();
  const MAX_SEEN_REACT = 4_000;
  let reactPollTimer: NodeJS.Timeout | null = null;

  function reactionEmoji(ev: NostrEvent): string {
    const raw = (ev.content || "").trim();
    if (raw) return raw;
    // Some clients put shortcode / emoji in tags
    for (const t of ev.tags) {
      if (t[0] === "emoji" && t[1]) return `:${t[1]}:`;
      if (t[0] === "reaction" && t[1]) return t[1];
    }
    return "";
  }

  function openCardIds(): string[] {
    return [...cards.values()]
      .filter((c) => c.status === "open" || c.status === "partial")
      .map((c) => c.cardEventId);
  }

  /** Re-REQ reactions on open cards so missed live events (👎 after blip) still apply. */
  function pollOpenCardReactions(): void {
    const relay = deps.relayHolder.current;
    if (!relay?.isOpen) return;
    const ids = openCardIds();
    if (!ids.length) return;
    const subId = `qm-buzz-${deps.cfg.agentId}-card-react`;
    try {
      relay.closeSubscription(subId);
    } catch {
      /* ignore */
    }
    // Chunk if many cards (relay filter size)
    const chunk = ids.slice(0, 40);
    relay.subscribe(subId, {
      kinds: [7],
      "#e": chunk,
      limit: 200,
    });
    // quiet — no log every 45s
  }

  async function ackDismiss(card: ScoutCard, already: boolean): Promise<void> {
    // Delete the card message (NIP-09 kind:5, self-authored only). No channel chatter.
    try {
      await deleteMessageViaHolder(
        deps.relayHolder,
        card.channelId,
        card.cardEventId,
        already ? "already closed" : "dismissed",
      );
      console.log(`${logPrefix} deleted card ${card.cardEventId.slice(0, 12)}…`);
    } catch (err) {
      console.warn(
        `${logPrefix} delete card failed ${card.cardEventId.slice(0, 12)}…:`,
        (err as Error).message,
      );
      // Fallback: react so the human still sees something if delete is rejected
      try {
        await reactViaHolder(deps.relayHolder, card.cardEventId, "🙈");
      } catch {
        /* ignore */
      }
    }
  }

  async function onReaction(ev: NostrEvent): Promise<void> {
    if (ev.kind !== 7) return;
    if (ev.pubkey === deps.botPubkey) return;
    if (ignorePubkeys.has(ev.pubkey.toLowerCase())) return; // ignore Brain 👀 etc.

    if (seenReactions.has(ev.id)) return;
    seenReactions.add(ev.id);
    if (seenReactions.size > MAX_SEEN_REACT) {
      const first = seenReactions.values().next().value;
      if (first) seenReactions.delete(first);
    }

    const target = ev.tags.find((t) => t[0] === "e" && t[1])?.[1]?.toLowerCase();
    if (!target) return;

    const card = cards.get(target);
    const emoji = reactionEmoji(ev);

    if (!card) {
      // Only log actionable-looking emojis so noise stays low
      if (emoji && (emojiMatches(DISMISS, emoji) || emojiMatches(APPROVE_ALL, emoji) || indexFromEmoji(emoji) !== null)) {
        console.log(
          `${logPrefix} reaction ${emoji} on unknown target ${target.slice(0, 12)}… (not a tracked card — react on the **Scout** root message)`,
        );
      }
      return;
    }

    // Already closed: still acknowledge dismiss so the human gets feedback
    if (card.status === "dismissed" || card.status === "executed") {
      if (emojiMatches(DISMISS, emoji) || emojiMatches(APPROVE_ALL, emoji)) {
        console.log(
          `${logPrefix} reaction ${emoji} on closed card ${target.slice(0, 12)}… status=${card.status}`,
        );
        if (emojiMatches(DISMISS, emoji)) await ackDismiss(card, true);
      }
      return;
    }

    const { selected, dismiss, rescan, mode } = selectFromReaction(card, emoji);
    console.log(
      `${logPrefix} reaction ${emoji} mode=${mode} from ${ev.pubkey.slice(0, 12)}… card=${target.slice(0, 12)}… status=${card.status}`,
    );

    if (dismiss) {
      card.status = "dismissed";
      rememberCard(card);
      await ackDismiss(card, false);
      return;
    }
    if (rescan) {
      if (card.status === "open" || card.status === "partial") {
        card.status = "dismissed";
        rememberCard(card);
      }
      await scanNow(card.channelId, undefined, true);
      return;
    }
    if (mode === "unknown") {
      // Ignore Brain 👀 and other noise on open cards
      return;
    }
    if (!selected.length) {
      console.log(`${logPrefix} reaction ${emoji} matched nothing actionable on card`);
      return;
    }
    await executeSelected(card, selected, ev.pubkey);
  }

  function onKind9(ev: NostrEvent): void {
    bufferMessage(ev);
    if (isBotTraffic(ev)) return;
    if (!isScoutCommand(ev.content || "", deps.cfg, deps.botPubkey, ev.tags)) return;
    const ch = channelIdFromTags(ev.tags);
    if (!ch) return;
    void scanNow(ch, ev, true).catch((e) =>
      console.error(`${logPrefix} command scan:`, (e as Error).message),
    );
  }

  function onKind7(ev: NostrEvent): void {
    void onReaction(ev).catch((e) => console.error(`${logPrefix} reaction:`, (e as Error).message));
  }

  async function scheduledTick(): Promise<void> {
    pollOpenCardReactions();
    // Only touch channels with human buffer traffic (or aged holds)
    const channels =
      deps.cfg.channelIds.length > 0 ? deps.cfg.channelIds : [...deps.recentByChannel.keys()];
    for (const ch of channels) {
      if (stopped) return;
      const humans = humanMessages(ch);
      const st = channelState.get(ch);
      const hasHolds = (st?.held?.length ?? 0) > 0;
      if (!humans.length && !hasHolds) continue;
      try {
        await scanNow(ch, undefined, false);
      } catch (err) {
        console.error(`${logPrefix} scheduled ${ch.slice(0, 8)}:`, (err as Error).message);
      }
    }
  }

  return {
    onKind9,
    onKind7,
    start() {
      stopped = false;
      const sec = deps.cfg.proactiveIntervalSec;
      if (sec > 0) {
        timer = setInterval(() => void scheduledTick(), sec * 1000);
        timer.unref();
        setTimeout(() => void scheduledTick(), Math.min(120_000, sec * 1000));
        console.log(`${logPrefix} interval ${sec}s store=${storePath}`);
      } else {
        console.log(`${logPrefix} command-only store=${storePath}`);
      }
      // Catch-up reactions often (missed live 👎/❌ after reconnects)
      pollOpenCardReactions();
      reactPollTimer = setInterval(() => pollOpenCardReactions(), 45_000);
      reactPollTimer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (reactPollTimer) clearInterval(reactPollTimer);
      reactPollTimer = null;
      persist();
    },
    scanNow,
  };
}

export function subscribeScoutReactions(relay: BuzzRelayClient, agentId: string): void {
  // Broad live feed + periodic #e catch-up on open cards (see pollOpenCardReactions)
  relay.subscribe(`qm-buzz-${agentId}-reactions`, {
    kinds: [7],
    since: Math.floor(Date.now() / 1000) - 3_600,
  });
}
