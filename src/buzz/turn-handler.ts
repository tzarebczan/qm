import type { BuzzCoreClient, BuzzTurnBody } from "../api/buzz-core-client.ts";
import { isHarnessId } from "../model/pi-models.ts";
import type { BuzzPluginConfig } from "./config.ts";
import { harnessOverrideFromText } from "./config.ts";
import {
  buzzDeliveryTarget,
  buzzThreadRef,
  channelIdFromTags,
  sessionRootEventId,
} from "./conversation.ts";
import { contentMentionsBot, resolveBuzzActor, tagsMentionPubkey } from "./identity.ts";
import { publishViaHolder, type BuzzRelayHolder, type NostrEvent } from "./relay.ts";

export function createBuzzTurnHandler(deps: {
  cfg: BuzzPluginConfig;
  core: BuzzCoreClient;
  relayHolder: BuzzRelayHolder;
  botPubkey: string;
}) {
  const seen = new Set<string>();
  const MAX_SEEN = 5_000;
  const logPrefix = `[buzz-plugin:${deps.cfg.agentId}]`;

  function remember(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > MAX_SEEN) {
      const first = seen.values().next().value;
      if (first) seen.delete(first);
    }
    return true;
  }

  function shouldHandle(ev: NostrEvent): boolean {
    if (ev.kind !== 9) return false;
    if (ev.pubkey === deps.botPubkey) return false;
    if (!remember(ev.id)) return false;
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

  async function safePublish(channelId: string, content: string, replyTo?: string): Promise<void> {
    try {
      await publishViaHolder(deps.relayHolder, channelId, content, replyTo);
    } catch (err) {
      console.error(`${logPrefix} publish failed:`, (err as Error).message);
    }
  }

  async function handleEvent(ev: NostrEvent): Promise<void> {
    if (!shouldHandle(ev)) return;

    const channelId = channelIdFromTags(ev.tags);
    if (!channelId) {
      console.warn(`${logPrefix} kind:9 without channel tag; ignoring`, ev.id.slice(0, 12));
      return;
    }

    const actor = resolveBuzzActor(deps.cfg, ev.pubkey);
    if (!actor) {
      console.warn(
        `${logPrefix} unmapped pubkey ${ev.pubkey.slice(0, 12)}… — set BUZZ_PRINCIPAL_MAP or BUZZ_ALLOW_UNMAPPED=1`,
      );
      return;
    }

    // Session isolation: root marker > reply marker > this event id (never bare first-e)
    const rootId = sessionRootEventId(ev.tags, ev.id);
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

    const body: BuzzTurnBody = {
      actor,
      conversation: {
        kind: "channel",
        threadRef,
        channelRef: channelId,
        channelName: channelId,
        audience: [actor],
      },
      text: cleanText,
      deliveryTarget,
      liveActor: true,
      origin: { kind: "human", messageTs: ev.id },
      gatewayContext: {
        location: "a Buzz channel",
        details: {
          channel_id: channelId,
          event_id: ev.id,
          thread_root: rootId,
          thread_ref: threadRef,
          author_pubkey: ev.pubkey,
          surface: "buzz",
          agent_id: deps.cfg.agentId,
        },
        instructions:
          "You are replying in Buzz (Nostr community chat) as @" +
          deps.cfg.botName +
          ". Keep replies concise. Markdown is fine. " +
          "This turn is ONLY for thread_ref=" +
          threadRef +
          " — do not mix in other Buzz threads or unrelated workstreams unless the user explicitly asks. " +
          "Users may set harness with [[harness:pi|opencode|codex|claude]].",
        botName: deps.cfg.botName,
      },
      ...(harnessId ? { harness: harnessId } : {}),
      ...(modelId ? { model: modelId } : {}),
      async: true,
    };

    console.log(
      `${logPrefix} turn from ${actor.externalId} ch=${channelId.slice(0, 8)}… thread=${rootId.slice(0, 12)}… harness=${harnessId ?? "default"}`,
    );

    let result;
    let runId: string | undefined;
    try {
      const queued = await deps.core.submitTurn(body);
      if (queued.status === "queued" && queued.runId) {
        runId = queued.runId;
        if (queued.steered) {
          console.log(`${logPrefix} steered into run ${runId.slice(0, 8)}… (same thread)`);
          return;
        }
        result = await deps.core.waitRun(queued.runId);
        if (result && (result.status === "ok" || result.status === "refused" || result.status === "failed")) {
          void deps.core.ackRunDelivery(queued.runId).catch((e) =>
            console.error(`${logPrefix} ack delivery failed:`, (e as Error).message),
          );
        }
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
    if (result.status === "silent") return;

    const replyText =
      result.status === "ok"
        ? (result.reply ?? "").trim() || "(no text reply)"
        : result.status === "refused"
          ? `Refused: ${result.reason ?? result.refusalKind ?? "policy"}`
          : `Failed: ${result.reason ?? result.status}`;

    await safePublish(channelId, replyText.slice(0, 60_000), ev.id);
  }

  return { handleEvent };
}
