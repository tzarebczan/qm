import type { BuzzCoreClient } from "../api/buzz-core-client.ts";
import type { BuzzPluginConfig } from "./config.ts";
import { createBuzzDeliveryPoller } from "./deliveries.ts";
import { BuzzRelayClient } from "./relay.ts";
import { createBuzzTurnHandler } from "./turn-handler.ts";

export { buzzPluginConfigFromEnv, type BuzzPluginConfig } from "./config.ts";

export async function startBuzzPlugin(
  cfg: BuzzPluginConfig,
  core: BuzzCoreClient,
): Promise<{ stop(): Promise<void> }> {
  let stopped = false;
  let client: BuzzRelayClient | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let poller: { start(): void; stop(): void } | null = null;

  const runLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        let handler: ReturnType<typeof createBuzzTurnHandler> | null = null;
        const relay = new BuzzRelayClient(cfg.relayUrl, cfg.botPrivateKey, {
          onEvent: (ev) => {
            if (!handler) return;
            void handler.handleEvent(ev).catch((err) =>
              console.error("[buzz-plugin] event handler error:", (err as Error).message),
            );
          },
          onNotice: (msg) => console.log("[buzz-plugin] notice:", msg),
          onClose: (code, reason) => {
            console.warn(`[buzz-plugin] relay closed (${code}) ${reason}`);
          },
        });
        client = relay;
        handler = createBuzzTurnHandler({
          cfg,
          core,
          relay,
          botPubkey: relay.pubkey,
        });

        console.log(`[buzz-plugin] connecting to ${cfg.relayUrl} as ${relay.pubkey.slice(0, 12)}…`);
        await relay.connect();
        await relay.authenticate(cfg.authTagJson);
        try {
          await relay.publishProfile(cfg.botName, "QM multiplayer ops agent (Buzz surface)");
        } catch (err) {
          console.warn("[buzz-plugin] profile publish failed (non-fatal):", (err as Error).message);
        }

        if (cfg.channelIds.length) {
          for (const channelId of cfg.channelIds) {
            // NIP-29 channel messages often use h tag; filter by kind + since
            relay.subscribe(`qm-buzz-${channelId.slice(0, 8)}`, {
              kinds: [9],
              "#h": [channelId],
              since: Math.floor(Date.now() / 1000) - 5,
            });
            console.log(`[buzz-plugin] subscribed channel ${channelId}`);
          }
        } else {
          // Broad subscribe — filter in handler (requires relay to allow)
          relay.subscribe("qm-buzz-all", {
            kinds: [9],
            since: Math.floor(Date.now() / 1000) - 5,
          });
          console.log("[buzz-plugin] subscribed all kind:9 (set BUZZ_CHANNELS to narrow)");
        }

        poller = createBuzzDeliveryPoller({ core, relay });
        poller.start();
        console.log(`[buzz-plugin] live as @${cfg.botName} (harness follows core / [[harness:…]] overrides)`);

        // Stay until closed
        await new Promise<void>((resolve) => {
          const prev = relay;
          const check = setInterval(() => {
            if (stopped || prev.isClosed) {
              clearInterval(check);
              resolve();
            }
          }, 2_000);
          check.unref();
        });
      } catch (err) {
        console.error("[buzz-plugin] session error:", (err as Error).message);
      } finally {
        poller?.stop();
        poller = null;
        client?.close();
        client = null;
      }
      if (stopped) break;
      console.log(`[buzz-plugin] reconnecting in ${cfg.reconnectMs}ms…`);
      await new Promise((r) => setTimeout(r, cfg.reconnectMs));
    }
  };

  void runLoop();

  return {
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      poller?.stop();
      client?.close();
      console.log("[buzz-plugin] stopped");
    },
  };
}
