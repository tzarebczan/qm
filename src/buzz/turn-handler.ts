import type { BuzzCoreClient, BuzzTurnBody } from "../api/buzz-core-client.ts";
import { isHarnessId } from "../model/pi-models.ts";
import type { BuzzPluginConfig } from "./config.ts";
import { harnessOverrideFromText } from "./config.ts";
import {
  buzzDeliveryTarget,
  buzzThreadRef,
  channelIdFromTags,
  sessionRootForBuzz,
} from "./conversation.ts";
import { contentMentionsBot, resolveBuzzActor, tagsMentionPubkey } from "./identity.ts";
import { publishViaHolder, reactViaHolder, type BuzzRelayHolder, type NostrEvent } from "./relay.ts";
import { sanitizeBuzzOutbound } from "./sanitize.ts";

export type BuzzDmRegistry = {
  /** True when channelId is a discovered DM (membership 44100, not in BUZZ_CHANNELS). */
  isDmChannel(channelId: string): boolean;
};

export function createBuzzTurnHandler(deps: {
  cfg: BuzzPluginConfig;
  core: BuzzCoreClient;
  relayHolder: BuzzRelayHolder;
  botPubkey: string;
  /** Optional DM registry from membership subscriptions. */
  dmRegistry?: BuzzDmRegistry;
}) {
  const seen = new Set<string>();
  const MAX_SEEN = 5_000;
  const logPrefix = `[buzz-plugin:${deps.cfg.agentId}]`;
  const publicChannelIds = new Set(deps.cfg.channelIds);

  function remember(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > MAX_SEEN) {
      const first = seen.values().next().value;
      if (first) seen.delete(first);
    }
    return true;
  }

  function isDmChannel(channelId: string): boolean {
    if (!deps.cfg.dmEnabled) return false;
    // Explicit registry from membership is authoritative.
    if (deps.dmRegistry?.isDmChannel(channelId)) return true;
    // Fallback: subscribed via empty BUZZ_CHANNELS (all kind:9) or race before registry —
    // any channel not in the configured public list is treated as DM when DMs are on.
    if (publicChannelIds.size === 0) return false;
    return !publicChannelIds.has(channelId);
  }

  function shouldHandle(ev: NostrEvent, isDm: boolean): boolean {
    if (ev.kind !== 9) return false;
    if (ev.pubkey === deps.botPubkey) return false;
    if (!remember(ev.id)) return false;
    // DMs: every human message is addressed to the bot (no @mention required).
    if (isDm) return true;
    if (deps.cfg.allMessages) return true;
    if (tagsMentionPubkey(ev.tags, deps.botPubkey)) return true;
    return contentMentionsBot(deps.cfg, ev.content, deps.botPubkey);
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

  async function safePublish(channelId: string, content: string, replyTo?: string): Promise<boolean> {
    try {
      const published = await publishViaHolder(deps.relayHolder, channelId, content, replyTo);
      console.log(
        `${logPrefix} published kind:9 id=${published.id.slice(0, 12)}… ch=${channelId.slice(0, 8)}… replyTo=${replyTo?.slice(0, 12) ?? "-"}… chars=${content.length}`,
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

  async function handleEvent(ev: NostrEvent): Promise<void> {
    const channelId = channelIdFromTags(ev.tags);
    if (ev.kind === 9 && !channelId) {
      console.warn(`${logPrefix} kind:9 without channel tag; ignoring`, ev.id.slice(0, 12));
      return;
    }
    if (!channelId) return;

    const isDm = isDmChannel(channelId);
    if (!shouldHandle(ev, isDm)) return;

    const actor = resolveBuzzActor(deps.cfg, ev.pubkey);
    if (!actor) {
      console.warn(
        `${logPrefix} unmapped pubkey ${ev.pubkey.slice(0, 12)}… — set BUZZ_PRINCIPAL_MAP or BUZZ_ALLOW_UNMAPPED=1`,
      );
      return;
    }

<<<<<<< HEAD
    // Immediate "seen" ack (Desktop ACP used to do this). Non-fatal if relay rejects.
    void ackSeen(ev.id);

=======
>>>>>>> d38955f (feat(buzz): DM support via NIP-29 membership channels)
    // Session isolation: root marker > reply marker > DM channel session | this event id
    const rootId = sessionRootForBuzz(ev.tags, ev.id, { isDm, channelId });
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
      );
      return;
    }

    const threadRef = buzzThreadRef(channelId, rootId);
    const deliveryTarget = buzzDeliveryTarget(channelId, ev.id);
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
        },
        instructions:
          (isDm
            ? "You are replying in a Buzz direct message as @" +
              deps.cfg.botName +
              ". This is a private 1:1 conversation — reply to every message without waiting for an @mention. "
            : "You are replying in Buzz (Nostr community chat) as @" +
              deps.cfg.botName +
              ". ") +
          "Keep replies concise. Markdown is fine. " +
          "This turn is ONLY for thread_ref=" +
          threadRef +
          " - do not mix in other Buzz threads or unrelated workstreams unless the user explicitly asks. " +
          "Use only plain ASCII punctuation (hyphen -, arrows as ->, ellipsis as ...). " +
          "Do not use em dashes, smart quotes, or special Unicode bullets. " +
          "Users may set harness with [[harness:pi|opencode|codex|claude]].",
        botName: deps.cfg.botName,
      },
      ...(harnessId ? { harness: harnessId } : {}),
      ...(modelId ? { model: modelId } : {}),
      async: true,
    };

    console.log(
      `${logPrefix} turn from ${actor.externalId} ${isDm ? "dm" : "ch"}=${channelId.slice(0, 8)}… thread=${rootId.slice(0, 24)} harness=${harnessId ?? "default"}`,
    );

    let result;
    let runId: string | undefined;
    try {
      const queued = await deps.core.submitTurn(body);
      if (queued.status === "queued" && queued.runId) {
        runId = queued.runId;
        if (queued.steered) {
          // Another in-flight turn on this thread owns the wait/publish path.
          // Do NOT ack delivery here — the owner (or delivery poller) must publish.
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
      // On stall, delivery poller may still have the result — nudge claim + brief wait
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
        await safePublish(
          channelId,
          `I couldn't complete that turn (${msg}). If this persists, say "retry" in this same thread.`,
          ev.id,
        );
        return;
      }
    }

    if (!result) return;
    if (result.status === "silent") {
      console.log(`${logPrefix} run silent (no channel post) run=${runId?.slice(0, 8) ?? "-"}`);
      return;
    }

    const replyText =
      result.status === "ok"
        ? (result.reply ?? "").trim() || "(no text reply)"
        : result.status === "refused"
          ? `Refused: ${result.reason ?? result.refusalKind ?? "policy"}`
          : `Failed: ${result.reason ?? result.status}`;

    // Publish first, then ack run delivery key so a failed post can still be recovered by the poller.
    const ok = await safePublish(channelId, sanitizeBuzzOutbound(replyText).slice(0, 60_000), ev.id);
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
