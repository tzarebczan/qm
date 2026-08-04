import type { BuzzCoreClient } from "../api/buzz-core-client.ts";
import { parseBuzzDeliveryTarget } from "./conversation.ts";
import type { BuzzRelayClient } from "./relay.ts";

/** Recovery poller: post undelivered run results to Buzz channels. */
export function createBuzzDeliveryPoller(deps: {
  core: BuzzCoreClient;
  relay: BuzzRelayClient;
}): { start(): void; stop(): void } {
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const batch = await deps.core.claimDeliveries("buzz", 30_000);
      for (const d of batch) {
        try {
          const parsed = parseBuzzDeliveryTarget(d.destination.target);
          if (!parsed) {
            await deps.core.ackDelivery(d.id);
            continue;
          }
          const text = (d.text ?? "").trim();
          if (text) {
            await deps.relay.publishChannelMessage(parsed.channelId, text, parsed.replyToEventId);
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
