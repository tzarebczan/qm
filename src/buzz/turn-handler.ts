import type { BuzzCoreClient, BuzzTurnBody } from "../api/buzz-core-client.ts";
import { isHarnessId } from "../model/pi-models.ts";
import type { BuzzPluginConfig } from "./config.ts";
import { harnessOverrideFromText } from "./config.ts";
import {
  buzzDeliveryTarget,
  buzzThreadRef,
  channelIdFromTags,
  nip10RootForReplyTo,
  sessionRootForBuzz,
} from "./conversation.ts";
import {
  contentMentionsBot,
  isAddressedToOtherOnly,
  referencedEventIds,
  resolveBuzzActor,
  tagsMentionPubkey,
} from "./identity.ts";
import { publishViaHolder, reactViaHolder, type BuzzRelayHolder, type NostrEvent } from "./relay.ts";
import { sanitizeBuzzOutbound } from "./sanitize.ts";

export type BuzzDmRegistry = {
  /** True when channelId is a discovered DM (membership 44100, not in BUZZ_CHANNELS). */
  isDmChannel(channelId: string): boolean;
  /** Best-effort DM channel for a QM principal (email / externalId). */
  dmChannelForPrincipal?(principalId: string): string | undefined;
  /** Remember which DM channel a principal last wrote from. */
  rememberDmPrincipal?(principalId: string, channelId: string): void;
};

type PendingBuzzApproval = {
  requestId: string;
  command: string;
  reason: string;
  purpose?: string;
  turn: BuzzTurnBody;
  actorId: string;
  originChannelId: string;
  createdAt: number;
};

function clipCmd(cmd: string, max = 400): string {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function formatApprovalNotice(
  approvals: Array<{ requestId: string; command: string; reason: string; purpose?: string; matched?: string }>,
  originHint: string,
): string {
  const lines: string[] = [
    "Approval needed before I can continue.",
    `Origin: ${originHint}`,
    "",
  ];
  for (const a of approvals) {
    lines.push(`Reason: ${a.reason}`);
    if (a.purpose) lines.push(`Why: ${a.purpose}`);
    if (a.matched) lines.push(`Triggered by: ${clipCmd(a.matched, 160)}`);
    lines.push(`Command: ${clipCmd(a.command, 800)}`);
    lines.push(`Id: ${a.requestId}`);
    lines.push("");
  }
  lines.push(
    "Reply here with: allow once | allow session | allow always | deny",
    "Or open https://qm.zarebczan.com and approve from the approval banner / that session.",
  );
  return lines.join("\n").trim();
}

/** Why we decided to handle this public-channel / DM event. */
export type BuzzHandleReason =
  | "dm"
  | "mention"
  | "reply_to_us"
  | "thread_followup"
  | "all_messages";

export function createBuzzTurnHandler(deps: {
  cfg: BuzzPluginConfig;
  core: BuzzCoreClient;
  relayHolder: BuzzRelayHolder;
  botPubkey: string;
  /** Optional DM registry from membership subscriptions. */
  dmRegistry?: BuzzDmRegistry;
}) {
  const seen = new Set<string>();
  /** Recent kind:9 ids we published — direct reply-to-bot without re-@mention. */
  const ourEventIds = new Set<string>();
  /** Thread roots (and parents) we joined — follow-ups in that tree may be for us. */
  const ourThreadRoots = new Set<string>();
  /** Pending command approvals awaiting a DM keyword reply (actorId → list). */
  const pendingByActor = new Map<string, PendingBuzzApproval[]>();
  const MAX_SEEN = 5_000;
  const MAX_OURS = 2_000;
  const MAX_THREADS = 1_000;
  const MAX_PENDING_AGE_MS = 6 * 60 * 60_000;
  const logPrefix = `[buzz-plugin:${deps.cfg.agentId}]`;
  const publicChannelIds = new Set(deps.cfg.channelIds);

  function prunePending(): void {
    const now = Date.now();
    for (const [actorId, list] of pendingByActor) {
      const next = list.filter((p) => now - p.createdAt < MAX_PENDING_AGE_MS);
      if (next.length) pendingByActor.set(actorId, next);
      else pendingByActor.delete(actorId);
    }
  }

  function rememberPending(
    actorId: string,
    items: PendingBuzzApproval[],
  ): void {
    prunePending();
    const cur = pendingByActor.get(actorId) ?? [];
    const byId = new Map(cur.map((p) => [p.requestId, p]));
    for (const item of items) byId.set(item.requestId, item);
    pendingByActor.set(actorId, [...byId.values()]);
  }

  function takePending(actorId: string): PendingBuzzApproval[] {
    prunePending();
    const list = pendingByActor.get(actorId) ?? [];
    pendingByActor.delete(actorId);
    return list;
  }

  function parseApprovalKeyword(
    content: string,
  ): { approved: boolean; scope?: "once" | "session" | "always" } | null {
    const t = content.trim().toLowerCase().replace(/[.!]+$/, "");
    if (/^(deny|reject|no|cancel)$/.test(t)) return { approved: false };
    if (/^(allow once|approve once|yes once|once)$/.test(t)) return { approved: true, scope: "once" };
    if (/^(allow session|approve session|session)$/.test(t)) return { approved: true, scope: "session" };
    if (/^(allow always|approve always|always|allow|approve|yes|lgtm|ok)$/.test(t))
      return { approved: true, scope: t === "allow" || t === "approve" || t === "yes" || t === "lgtm" || t === "ok" ? "once" : "always" };
    if (/^(allow for session)$/.test(t)) return { approved: true, scope: "session" };
    return null;
  }

  function remember(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > MAX_SEEN) {
      const first = seen.values().next().value;
      if (first) seen.delete(first);
    }
    return true;
  }

  function rememberId(set: Set<string>, id: string, max: number): void {
    const key = id.toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(key)) return;
    set.add(key);
    if (set.size > max) {
      const first = set.values().next().value;
      if (first) set.delete(first);
    }
  }

  function rememberOurs(id: string): void {
    rememberId(ourEventIds, id, MAX_OURS);
  }

  function rememberThread(...ids: Array<string | undefined>): void {
    for (const id of ids) {
      if (id) rememberId(ourThreadRoots, id, MAX_THREADS);
    }
  }

  function isDmChannel(channelId: string): boolean {
    if (!deps.cfg.dmEnabled) return false;
    if (deps.dmRegistry?.isDmChannel(channelId)) return true;
    if (publicChannelIds.size === 0) return false;
    return !publicChannelIds.has(channelId);
  }

  function isExplicitlyAddressed(ev: NostrEvent): boolean {
    if (tagsMentionPubkey(ev.tags, deps.botPubkey)) return true;
    return contentMentionsBot(deps.cfg, ev.content, deps.botPubkey);
  }

  function isReplyToOurPost(ev: NostrEvent): boolean {
    if (ourEventIds.size === 0) return false;
    for (const id of referencedEventIds(ev.tags)) {
      if (ourEventIds.has(id)) return true;
    }
    return false;
  }

  function isInOurThread(ev: NostrEvent): boolean {
    if (ourThreadRoots.size === 0 && ourEventIds.size === 0) return false;
    for (const id of referencedEventIds(ev.tags)) {
      if (ourThreadRoots.has(id) || ourEventIds.has(id)) return true;
    }
    return false;
  }

  /**
   * Decide whether to handle a channel message, and why.
   * Thread follow-ups without @ are allowed only in threads we already joined,
   * and only when the message is not clearly for someone else.
   */
  const siblingPubkeys = new Set(
    (deps.cfg.siblingPubkeys ?? [])
      .map((p) => p.toLowerCase())
      .filter((p) => /^[0-9a-f]{64}$/i.test(p)),
  );
  // Also ignore scout/executor handoff peer when configured.
  if (deps.cfg.proactiveHandoffPubkey) {
    siblingPubkeys.add(deps.cfg.proactiveHandoffPubkey.toLowerCase());
  }

  function isScoutCard(ev: NostrEvent): boolean {
    const c = ev.content || "";
    if (/^\*\*Scout\*\*/i.test(c)) return true;
    if (/^Scout\b/i.test(c) && /React \(anyone\)|React with emoji|proposal/i.test(c)) return true;
    if (ev.tags.some((t) => t[0] === "client" && t[1] === "qm-buzz-scout")) return true;
    return false;
  }

  /** Approved handoff from Scout — this is the only scout traffic Brain should work. */
  function isScoutHandoff(ev: NostrEvent): boolean {
    const c = ev.content || "";
    if (/\[Scout-approved work package\]/i.test(c)) return true;
    if (ev.tags.some((t) => t[0] === "client" && t[1] === "qm-buzz-scout-handoff")) return true;
    return false;
  }

  function isSiblingBot(ev: NostrEvent): boolean {
    // Handoff packages are from Scout but meant for us — never treat as "ignore sibling".
    if (isScoutHandoff(ev)) return false;
    if (siblingPubkeys.has(ev.pubkey.toLowerCase())) return true;
    if (ev.tags.some((t) => t[0] === "client" && /^qm-buzz-scout/i.test(t[1] || ""))) return true;
    if (isScoutCard(ev)) return true;
    return false;
  }

  function classifyHandle(ev: NostrEvent, isDm: boolean): BuzzHandleReason | null {
    if (ev.kind !== 9) return null;
    if (ev.pubkey === deps.botPubkey) return null;
    if (!remember(ev.id)) return null;

    // Proposal cards / scout noise: never wake Brain.
    if (isScoutCard(ev)) return null;
    if (isSiblingBot(ev) && !isScoutHandoff(ev)) return null;

    if (isDm) return "dm";

    // Approved handoff only — not "I'm looking at the card early"
    if (isScoutHandoff(ev)) return "mention";

    if (isExplicitlyAddressed(ev)) return "mention";

    // Direct reply to one of our posts → continue without re-@ (when enabled)
    if (deps.cfg.replyContinuity !== false && isReplyToOurPost(ev)) {
      if (isAddressedToOtherOnly(deps.cfg, ev.content, ev.tags, deps.botPubkey)) {
        console.log(
          `${logPrefix} skip reply-to-us (addressed to someone else) id=${ev.id.slice(0, 12)}…`,
        );
        return null;
      }
      // Casual one-liners under a bot post ("it'd be nice", "lol", "ok") stay silent.
      // Require a real question or enough substance to look like work.
      const body = (ev.content || "").trim();
      if (body.length < 24 && !/\?/.test(body)) {
        console.log(`${logPrefix} skip reply-to-us (too short/casual) id=${ev.id.slice(0, 12)}…`);
        return null;
      }
      return "reply_to_us";
    }

    // Same thread we already joined — OFF by default (multiplayer chatter).
    if (deps.cfg.threadFollowup && isInOurThread(ev)) {
      if (isAddressedToOtherOnly(deps.cfg, ev.content, ev.tags, deps.botPubkey)) {
        console.log(
          `${logPrefix} skip thread follow-up (for someone else) id=${ev.id.slice(0, 12)}…`,
        );
        return null;
      }
      // Do not monologue: short/empty follow-ups stay silent
      if ((ev.content || "").trim().length < 24) return null;
      return "thread_followup";
    }

    if (deps.cfg.allMessages) {
      if (isAddressedToOtherOnly(deps.cfg, ev.content, ev.tags, deps.botPubkey)) {
        console.log(`${logPrefix} skip all-messages (for someone else) id=${ev.id.slice(0, 12)}…`);
        return null;
      }
      return "all_messages";
    }

    return null;
  }

  function channelRuntime(channelId: string): { harnessId?: string; modelId?: string } {
    for (const row of deps.cfg.channelRuntime) {
      if (row.channel === channelId || row.channel.replace(/^#/, "") === channelId) {
        return {
          ...(row.harnessId ? { harnessId: row.harnessId } : {}),
          ...(row.modelId ? { modelId: row.modelId } : {}),
        };
      }
    }
    return {};
  }

  async function safePublish(
    channelId: string,
    content: string,
    replyTo?: string,
    rootId?: string,
  ): Promise<boolean> {
    try {
      // Flat-ish threads: never nest under our own prior bot post (stops deep click trees
      // and self-chains). Prefer thread root when parent would be us.
      let parent = replyTo?.trim();
      let root = rootId?.trim() || parent;
      if (parent && ourEventIds.has(parent.toLowerCase()) && root) {
        parent = root;
      }
      // When parent is the thread root, single reply-marker (root === parent) is enough.
      if (parent && root && parent.toLowerCase() === root.toLowerCase()) {
        root = parent;
      }
      const published = await publishViaHolder(deps.relayHolder, channelId, content, parent, root);
      rememberOurs(published.id);
      // Remember human/root for continuity, not every bot post as a new nest parent preference
      rememberThread(root, parent);
      console.log(
        `${logPrefix} published kind:9 id=${published.id.slice(0, 12)}… ch=${channelId.slice(0, 8)}… replyTo=${parent?.slice(0, 12) ?? "-"}… root=${root?.slice(0, 12) ?? "-"}… chars=${content.length}`,
      );
      return true;
    } catch (err) {
      console.error(`${logPrefix} publish failed:`, (err as Error).message);
      return false;
    }
  }

  async function ackSeen(targetEventId: string): Promise<void> {
    try {
      await reactViaHolder(deps.relayHolder, targetEventId, "👀");
      console.log(`${logPrefix} ack reaction 👀 on ${targetEventId.slice(0, 12)}…`);
    } catch (err) {
      console.warn(`${logPrefix} ack reaction failed:`, (err as Error).message);
    }
  }

  function gatewayInstructions(opts: {
    isDm: boolean;
    reason: BuzzHandleReason;
    threadRef: string;
    scoutHandoff: boolean;
  }): string {
    const bot = deps.cfg.botName;
    if (opts.scoutHandoff) {
      return (
        `You are @${bot} executing a Scout-approved work package. ` +
        `Emoji approval already happened — do not ask for go-ahead. ` +
        `Do ONLY the listed items. One short status reply when done (bullets ok). ` +
        `If an item is impossible (missing API/UI-only), one line skip + reason; do not essay or pre-check unapproved card items. ` +
        `Do not reply to yourself again after that unless a human asks. ` +
        `Do not engage bare Scout proposal cards (waiting for reactions) — only [Scout-approved work package] jobs. ` +
        `ASCII punctuation only. thread_ref=${opts.threadRef}`
      );
    }

    const base = opts.isDm
      ? `You are replying in a Buzz direct message as @${bot}. This is a private 1:1 conversation — reply to every message without waiting for an @mention. `
      : `You are replying in Buzz (Nostr community chat) as @${bot}. `;

    const triage =
      opts.reason === "thread_followup" || opts.reason === "all_messages"
        ? `THREAD TRIAGE (no explicit @${bot}): If human-to-human or not for you, stay silent. ` +
          `If it continues your work or asks you, reply briefly. ` +
          `Do NOT reply to your own prior messages unless a human points out a serious factual error you must correct. `
        : opts.reason === "reply_to_us"
          ? `Human replied to you. Answer if it continues work; stay silent if not for you. Do not stack multiple follow-up posts. `
          : "";

    return (
      base +
      triage +
      "Scout proposal cards (emoji menus) are not work orders — ignore them until a [Scout-approved work package] arrives. " +
      "Keep replies concise (prefer under ~12 lines). One post per turn. " +
      "This turn is ONLY for thread_ref=" +
      opts.threadRef +
      ". " +
      "ASCII punctuation only (hyphen -, arrows as ->, ellipsis as ...). " +
      "Users may set harness with [[harness:pi|opencode|codex|claude]]."
    );
  }

  async function handleEvent(ev: NostrEvent): Promise<void> {
    const channelId = channelIdFromTags(ev.tags);
    if (ev.kind === 9 && !channelId) {
      console.warn(`${logPrefix} kind:9 without channel tag; ignoring`, ev.id.slice(0, 12));
      return;
    }
    if (!channelId) return;

    const isDm = isDmChannel(channelId);
    const reason = classifyHandle(ev, isDm);
    if (!reason) return;

    const actor = resolveBuzzActor(deps.cfg, ev.pubkey);
    if (!actor) {
      console.warn(
        `${logPrefix} unmapped pubkey ${ev.pubkey.slice(0, 12)}… — set BUZZ_PRINCIPAL_MAP or BUZZ_ALLOW_UNMAPPED=1`,
      );
      return;
    }

    if (isDm) {
      deps.dmRegistry?.rememberDmPrincipal?.(actor.externalId, channelId);
    }

    // DM keyword resolve for pending command approvals (allow once / session / always / deny)
    if (isDm) {
      const decision = parseApprovalKeyword(ev.content || "");
      if (decision) {
        const pending = takePending(actor.externalId);
        if (pending.length) {
          void ackSeen(ev.id);
          console.log(
            `${logPrefix} resolving ${pending.length} approval(s) via DM keyword for ${actor.externalId}`,
          );
          for (const item of pending) {
            try {
              const approvedBody: BuzzTurnBody = {
                ...item.turn,
                approval: {
                  requestId: item.requestId,
                  approved: decision.approved,
                  ...(decision.approved && decision.scope ? { scope: decision.scope } : {}),
                },
              };
              const queued = await deps.core.submitTurn(approvedBody);
              let resolved = queued;
              if (queued.status === "queued" && queued.runId) {
                resolved = (await deps.core.waitRun(queued.runId)) ?? queued;
              }
              const note = decision.approved
                ? `Approved (${decision.scope ?? "once"}): ${clipCmd(item.command, 120)}`
                : `Denied: ${clipCmd(item.command, 120)}`;
              await safePublish(channelId, note, ev.id, sessionRootForBuzz(ev.tags, ev.id, { isDm, channelId }));
              if (resolved?.status === "ok" && (resolved.reply ?? "").trim()) {
                await safePublish(
                  channelId,
                  sanitizeBuzzOutbound((resolved.reply ?? "").trim()).slice(0, 60_000),
                  ev.id,
                  sessionRootForBuzz(ev.tags, ev.id, { isDm, channelId }),
                );
              } else if (resolved && resolved.status !== "ok" && resolved.status !== "silent") {
                await safePublish(
                  channelId,
                  `After approval: ${resolved.reason ?? resolved.status}`,
                  ev.id,
                  sessionRootForBuzz(ev.tags, ev.id, { isDm, channelId }),
                );
              }
            } catch (err) {
              console.error(`${logPrefix} approval resolve failed:`, (err as Error).message);
              await safePublish(
                channelId,
                `Could not apply approval: ${(err as Error).message}`,
                ev.id,
                sessionRootForBuzz(ev.tags, ev.id, { isDm, channelId }),
              );
            }
          }
          return;
        }
      }
    }

    const scoutHandoff = isScoutHandoff(ev);

    // 👀: DMs + explicit @mentions + direct reply to our post (working ack).
    // No eyes on scout handoff spam or thread followups.
    if (!scoutHandoff && (reason === "dm" || reason === "mention" || reason === "reply_to_us")) {
      void ackSeen(ev.id);
    }

    const rootId = sessionRootForBuzz(ev.tags, ev.id, { isDm, channelId });
    const nip10Root = nip10RootForReplyTo(ev.tags, ev.id);

    // Do NOT join Scout card threads for follow-up memory (stops monologue under cards).
    // Handoff is one-shot work; still remember the human source msg only if present.
    if (scoutHandoff) {
      // ephemeral session: do not expand ourThreadRoots to the card
    } else if (reason === "mention" || reason === "reply_to_us" || reason === "dm") {
      rememberThread(nip10Root, rootId, ev.id);
    }

    const { cleanText, harnessId: textHarness, modelId: textModel } = harnessOverrideFromText(ev.content.trim());
    if (!cleanText.trim()) return;

    const chRt = channelRuntime(channelId);
    const harnessId = textHarness ?? chRt.harnessId ?? deps.cfg.defaultHarnessId;
    const modelId = textModel ?? chRt.modelId ?? deps.cfg.defaultModelId;

    if (harnessId && !isHarnessId(harnessId)) {
      await safePublish(
        channelId,
        `Unknown harness \`${harnessId}\`. Valid: pi, opencode, codex, claude, mock. Example: \`[[harness:codex]] …\``,
        ev.id,
        nip10Root,
      );
      return;
    }

    const threadRef = buzzThreadRef(channelId, rootId);
    const deliveryTarget = buzzDeliveryTarget(channelId, ev.id, nip10Root);
    const conversationKind = isDm ? "dm" : "channel";

    const body: BuzzTurnBody = {
      actor,
      conversation: {
        kind: conversationKind,
        threadRef,
        channelRef: channelId,
        channelName: isDm ? "dm" : channelId,
        audience: [actor],
      },
      text: cleanText,
      deliveryTarget,
      liveActor: true,
      origin: { kind: "human", messageTs: ev.id },
      gatewayContext: {
        location: isDm ? "a Buzz direct message" : "a Buzz channel",
        details: {
          channel_id: channelId,
          event_id: ev.id,
          thread_root: rootId,
          thread_ref: threadRef,
          author_pubkey: ev.pubkey,
          surface: "buzz",
          agent_id: deps.cfg.agentId,
          conversation_kind: conversationKind,
          handle_reason: reason,
        },
        instructions: gatewayInstructions({ isDm, reason, threadRef, scoutHandoff }),
        botName: deps.cfg.botName,
      },
      ...(harnessId ? { harness: harnessId } : {}),
      ...(modelId ? { model: modelId } : {}),
      async: true,
    };

    console.log(
      `${logPrefix} turn from ${actor.externalId} ${isDm ? "dm" : "ch"}=${channelId.slice(0, 8)}… thread=${rootId.slice(0, 24)} reason=${reason} harness=${harnessId ?? "default"}`,
    );

    let result;
    let runId: string | undefined;
    try {
      const queued = await deps.core.submitTurn(body);
      if (queued.status === "queued" && queued.runId) {
        runId = queued.runId;
        if (queued.steered) {
          console.log(`${logPrefix} steered into run ${runId.slice(0, 8)}… (same thread; no separate reply)`);
          return;
        }
        console.log(`${logPrefix} waiting run ${runId.slice(0, 8)}…`);
        result = await deps.core.waitRun(queued.runId);
      } else {
        result = queued;
      }
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`${logPrefix} turn failed:`, msg, runId ? `run=${runId}` : "");
      if ((err as { code?: string }).code === "run_stalled" && runId) {
        try {
          const late = await deps.core.waitRun(runId).catch(() => null);
          if (late && late.status !== "silent") {
            result = late;
          }
        } catch {
          /* ignore */
        }
      }
      if (!result) {
        // Only surface errors when we were clearly engaged (not ambiguous follow-up)
        if (reason === "mention" || reason === "reply_to_us" || reason === "dm") {
          await safePublish(
            channelId,
            `I couldn't finish that turn (${msg}). If this persists, say "retry" in this same thread.`,
            ev.id,
            nip10Root,
          );
        } else {
          console.log(`${logPrefix} suppress exception channel post reason=${reason}: ${msg.slice(0, 120)}`);
        }
        // Own the delivery key so the recovery poller does not double-post.
        if (runId) void deps.core.ackRunDelivery(runId).catch(() => {});
        return;
      }
    }

    if (!result) return;
    if (result.status === "silent") {
      console.log(`${logPrefix} run silent (no channel post) run=${runId?.slice(0, 8) ?? "-"} reason=${reason}`);
      if (runId) void deps.core.ackRunDelivery(runId).catch(() => {});
      return;
    }

    const explicitEngagement = reason === "mention" || reason === "reply_to_us" || reason === "dm";

    // Command-policy / strict-tool pause — alert requester via Buzz DM + thread pointer.
    const pendingList =
      result.status === "pending_approval" || (result.pendingApprovals?.length ?? 0) > 0
        ? (result.pendingApprovals ?? [])
        : [];
    if (pendingList.length) {
      const originHint = isDm
        ? "your DM"
        : `channel thread ${channelId.slice(0, 8)}…`;
      const notice = formatApprovalNotice(
        pendingList.map((a) => ({
          requestId: a.requestId,
          command: a.command,
          reason: a.reason,
          ...(a.purpose ? { purpose: a.purpose } : {}),
          ...(a.matched ? { matched: a.matched } : {}),
        })),
        originHint,
      );
      // Resume with the same turn request (minus async) so approval binding matches.
      const { async: _asyncDrop, ...turnSnapshot } = body as BuzzTurnBody & { async?: boolean };
      void _asyncDrop;
      rememberPending(
        actor.externalId,
        pendingList.map((a) => ({
          requestId: a.requestId,
          command: a.command,
          reason: a.reason,
          ...(a.purpose ? { purpose: a.purpose } : {}),
          turn: turnSnapshot,
          actorId: actor.externalId,
          originChannelId: channelId,
          createdAt: Date.now(),
        })),
      );

      // Thread pointer (always, when we were engaged or the pause is blocking).
      if (explicitEngagement || pendingList.some((a) => a.blocksInput !== false)) {
        const short = pendingList
          .map((a) => `${a.reason}: ${clipCmd(a.command, 100)}`)
          .join(" | ");
        await safePublish(
          channelId,
          sanitizeBuzzOutbound(
            `Paused for approval (${short}). I DMed you details — reply allow once / allow session / allow always / deny, or approve in the web UI.`,
          ).slice(0, 60_000),
          ev.id,
          nip10Root,
        );
      }

      // Dedicated DM with full command text.
      const dmChannel =
        deps.dmRegistry?.dmChannelForPrincipal?.(actor.externalId) ??
        (isDm ? channelId : undefined);
      if (dmChannel && (!isDm || dmChannel !== channelId)) {
        await safePublish(dmChannel, sanitizeBuzzOutbound(notice).slice(0, 60_000));
      } else if (isDm) {
        // Already in their DM — send the full notice as a second message if the pointer was short.
        await safePublish(channelId, sanitizeBuzzOutbound(notice).slice(0, 60_000), ev.id, nip10Root);
      } else {
        console.warn(
          `${logPrefix} no DM channel known for ${actor.externalId} — approval details only in thread. ` +
            `User must DM the bot once so membership is learned.`,
        );
        // Fall back: full notice in the channel thread so they are not blocked silently.
        await safePublish(channelId, sanitizeBuzzOutbound(notice).slice(0, 60_000), ev.id, nip10Root);
      }

      if (runId) void deps.core.ackRunDelivery(runId).catch(() => {});
      return;
    }

    // Non-ok: one channel post max. Live wait path posts + acks so the recovery
    // poller does not also emit "Failed:" + "I couldn't finish".
    if (result.status !== "ok") {
      const detail = result.status === "refused"
        ? (result.reason ?? result.refusalKind ?? "policy")
        : (result.reason ?? result.status);
      if (!explicitEngagement) {
        console.log(
          `${logPrefix} suppress non-ok channel post reason=${reason} status=${result.status} detail=${String(detail).slice(0, 120)}`,
        );
        if (runId) void deps.core.ackRunDelivery(runId).catch(() => {});
        return;
      }
      const replyText =
        result.status === "refused"
          ? `Refused: ${detail}`
          : `I couldn't finish that turn: ${detail}`;
      const ok = await safePublish(
        channelId,
        sanitizeBuzzOutbound(replyText).slice(0, 60_000),
        ev.id,
        nip10Root,
      );
      if (runId) {
        void deps.core.ackRunDelivery(runId).catch((e) =>
          console.error(`${logPrefix} ack delivery failed:`, (e as Error).message),
        );
      }
      if (!ok) {
        console.error(`${logPrefix} failure post missed for run ${runId?.slice(0, 8) ?? "-"}…`);
      }
      return;
    }

    const replyText = (result.reply ?? "").trim() || "(no text reply)";

    // Model sometimes "soft-silents" with empty-ish refusals on triage — treat short noop as silent
    if (
      (reason === "thread_followup" || reason === "all_messages") &&
      /^(noop|n\/a|silent|no reply|nothing to (add|say)|not for me)\.?$/i.test(replyText.trim())
    ) {
      console.log(`${logPrefix} triage soft-silent run=${runId?.slice(0, 8) ?? "-"}`);
      if (runId) {
        void deps.core.ackRunDelivery(runId).catch(() => {});
      }
      return;
    }

    const ok = await safePublish(
      channelId,
      sanitizeBuzzOutbound(replyText).slice(0, 60_000),
      ev.id,
      nip10Root,
    );
    if (ok && runId) {
      void deps.core.ackRunDelivery(runId).catch((e) =>
        console.error(`${logPrefix} ack delivery failed:`, (e as Error).message),
      );
    } else if (!ok && runId) {
      console.error(`${logPrefix} left delivery pending for run ${runId.slice(0, 8)}… (publish failed)`);
    }
  }

  return { handleEvent };
}
