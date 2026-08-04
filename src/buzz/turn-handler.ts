import type { BuzzCoreClient, BuzzTurnBody } from "../api/buzz-core-client.ts";
import { isHarnessId } from "../model/pi-models.ts";
import type { BuzzPluginConfig } from "./config.ts";
import { harnessOverrideFromText } from "./config.ts";
import {
  buzzDeliveryTarget,
  buzzThreadRef,
  channelIdFromTags,
  rootEventIdFromTags,
} from "./conversation.ts";
import { contentMentionsBot, resolveBuzzActor, tagsMentionPubkey } from "./identity.ts";
import type { BuzzRelayClient, NostrEvent } from "./relay.ts";

export function createBuzzTurnHandler(deps: {
  cfg: BuzzPluginConfig;
  core: BuzzCoreClient;
  relay: BuzzRelayClient;
  botPubkey: string;
}) {
  const seen = new Set<string>();
  const MAX_SEEN = 5_000;

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

  async function handleEvent(ev: NostrEvent): Promise<void> {
    if (!shouldHandle(ev)) return;

    const channelId = channelIdFromTags(ev.tags);
    if (!channelId) {
      console.warn("[buzz-plugin] kind:9 without channel tag; ignoring", ev.id.slice(0, 12));
      return;
    }

    const actor = resolveBuzzActor(deps.cfg, ev.pubkey);
    if (!actor) {
      console.warn(
        `[buzz-plugin] unmapped pubkey ${ev.pubkey.slice(0, 12)}… — set BUZZ_PRINCIPAL_MAP or BUZZ_ALLOW_UNMAPPED=1`,
      );
      return;
    }

    const rootId = rootEventIdFromTags(ev.tags) ?? ev.id;
    const { cleanText, harnessId: textHarness, modelId: textModel } = harnessOverrideFromText(ev.content.trim());
    if (!cleanText.trim()) return;

    const chRt = channelRuntime(channelId);
    const harnessId = textHarness ?? chRt.harnessId;
    const modelId = textModel ?? chRt.modelId;

    if (harnessId && !isHarnessId(harnessId)) {
      await deps.relay
        .publishChannelMessage(
          channelId,
          `Unknown harness \`${harnessId}\`. Valid: pi, opencode, codex, claude, mock. Example: \`[[harness:codex]] …\``,
          ev.id,
        )
        .catch(() => undefined);
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
          author_pubkey: ev.pubkey,
          surface: "buzz",
        },
        instructions:
          "You are replying in Buzz (Nostr community chat). Keep replies concise. Markdown is fine. " +
          "Do not invent Slack conventions. Users may set harness with [[harness:pi|opencode|codex|claude]].",
        botName: deps.cfg.botName,
      },
      ...(harnessId ? { harness: harnessId } : {}),
      ...(modelId ? { model: modelId } : {}),
      async: true,
    };

    console.log(
      `[buzz-plugin] turn from ${actor.externalId} ch=${channelId.slice(0, 8)}… harness=${harnessId ?? "default"}`,
    );

    let result;
    try {
      const queued = await deps.core.submitTurn(body);
      if (queued.status === "queued" && queued.runId) {
        if (queued.steered) return;
        result = await deps.core.waitRun(queued.runId);
        if (result && (result.status === "ok" || result.status === "refused" || result.status === "failed")) {
          void deps.core.ackRunDelivery(queued.runId).catch((e) =>
            console.error("[buzz-plugin] ack delivery failed:", (e as Error).message),
          );
        }
      } else {
        result = queued;
      }
    } catch (err) {
      console.error("[buzz-plugin] turn failed:", (err as Error).message);
      await deps.relay
        .publishChannelMessage(
          channelId,
          `I couldn't complete that turn (${(err as Error).message}). Try again in a moment.`,
          ev.id,
        )
        .catch(() => undefined);
      return;
    }

    if (!result) return;
    if (result.status === "silent") return;

    const replyText =
      result.status === "ok"
        ? (result.reply ?? "").trim() || "(no text reply)"
        : result.status === "refused"
          ? `Refused: ${result.reason ?? result.refusalKind ?? "policy"}`
          : `Failed: ${result.reason ?? result.status}`;

    try {
      await deps.relay.publishChannelMessage(channelId, replyText.slice(0, 60_000), ev.id);
    } catch (err) {
      console.error("[buzz-plugin] publish reply failed:", (err as Error).message);
    }
  }

  return { handleEvent };
}
