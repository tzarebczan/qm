import type { BuzzCoreClient } from "../api/buzz-core-client.ts";
import { parseBuzzDeliveryTarget } from "./conversation.ts";
import type { BuzzRelayClient } from "./relay.ts";
import { sanitizeBuzzOutbound } from "./sanitize.ts";

/** Recovery poller: post undelivered run results to Buzz channels. */
export function createBuzzDeliveryPoller(deps: {
  core: BuzzCoreClient;
  /** Live relay or thin proxy — must support publishChannelMessage. */
  relay: Pick<BuzzRelayClient, "publishChannelMessage">;
  /**
   * Delivery type to claim. Prefer agent-scoped `buzz:<agentId>` so multi-bot
   * surfaces do not double-publish. Falls back to plain `buzz` for legacy rows.
   */
  deliveryType: string;
}): { start(): void; stop(): void } {
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  const types = Array.from(
    new Set([deps.deliveryType, deps.deliveryType.startsWith("buzz:") ? "buzz" : deps.deliveryType]),
  );

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const batch: Awaited<ReturnType<BuzzCoreClient["claimDeliveries"]>> = [];
      for (const type of types) {
        const part = await deps.core.claimDeliveries(type, 30_000);
        batch.push(...part);
      }
      for (const d of batch) {
        try {
          const parsed = parseBuzzDeliveryTarget(d.destination.target);
          if (!parsed) {
            await deps.core.ackDelivery(d.id);
            continue;
          }
          const text = sanitizeBuzzOutbound((d.text ?? "").trim());
          if (text) {
            // Prefer flat attachment under thread root when both are set.
            let replyTo = parsed.replyToEventId;
            let root = parsed.rootEventId ?? replyTo;
            if (replyTo && root && replyTo !== root) {
              // Keep root+reply for true nested human context; ok as-is.
            } else if (replyTo && !root) {
              root = replyTo;
            }
            await deps.relay.publishChannelMessage(parsed.channelId, text, replyTo, root);
          }
          await deps.core.ackDelivery(d.id);
        } catch (err) {
          console.error("[buzz-plugin] delivery failed:", d.id, (err as Error).message);
        }
      }
    } catch (err) {
      console.error("[buzz-plugin] delivery poll error:", (err as Error).message);
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      void tick();
      timer = setInterval(() => void tick(), 60_000);
      timer.unref();
      deps.core.onDeliveryEnqueued(() => void tick());
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
