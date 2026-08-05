import type { BuzzCoreClient } from "../api/buzz-core-client.ts";
import type { BuzzPluginConfig } from "./config.ts";
import { createBuzzDeliveryPoller } from "./deliveries.ts";
import { BuzzRelayClient, type BuzzRelayHolder } from "./relay.ts";
import { createBuzzTurnHandler } from "./turn-handler.ts";

export {
  buzzPluginConfigFromEnv,
  buzzPluginConfigsFromEnv,
  type BuzzPluginConfig,
} from "./config.ts";

export async function startBuzzPlugin(
  cfg: BuzzPluginConfig,
  core: BuzzCoreClient,
): Promise<{ stop(): Promise<void> }> {
  let stopped = false;
  const relayHolder: BuzzRelayHolder = { current: null };
  let reconnectTimer: NodeJS.Timeout | null = null;
  let poller: { start(): void; stop(): void } | null = null;
  const logPrefix = `[buzz-plugin:${cfg.agentId}]`;

  const runLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        let handler: ReturnType<typeof createBuzzTurnHandler> | null = null;
        const relay = new BuzzRelayClient(cfg.relayUrl, cfg.botPrivateKey, {
          onEvent: (ev) => {
            if (!handler) return;
            void handler.handleEvent(ev).catch((err) =>
              console.error(`${logPrefix} event handler error:`, (err as Error).message),
            );
          },
          onNotice: (msg) => console.log(`${logPrefix} notice:`, msg),
          onClose: (code, reason) => {
            console.warn(`${logPrefix} relay closed (${code}) ${reason}`);
          },
        });
        relayHolder.current = relay;
        handler = createBuzzTurnHandler({
          cfg,
          core,
          relayHolder,
          botPubkey: relay.pubkey,
        });

        console.log(`${logPrefix} connecting to ${cfg.relayUrl} as ${relay.pubkey.slice(0, 12)}…`);
        await relay.connect();
        await relay.authenticate(cfg.authTagJson);
        try {
          await relay.publishProfile(
            cfg.botName,
            cfg.about ?? "QM multiplayer ops agent (Buzz surface)",
          );
        } catch (err) {
          console.warn(`${logPrefix} profile publish failed (non-fatal):`, (err as Error).message);
        }

        if (cfg.channelIds.length) {
          for (const channelId of cfg.channelIds) {
            relay.subscribe(`qm-buzz-${cfg.agentId}-${channelId.slice(0, 8)}`, {
              kinds: [9],
              "#h": [channelId],
              since: Math.floor(Date.now() / 1000) - 5,
            });
            console.log(`${logPrefix} subscribed channel ${channelId}`);
          }
        } else {
          relay.subscribe(`qm-buzz-${cfg.agentId}-all`, {
            kinds: [9],
            since: Math.floor(Date.now() / 1000) - 5,
          });
          console.log(`${logPrefix} subscribed all kind:9 (set BUZZ_CHANNELS to narrow)`);
        }

        poller = createBuzzDeliveryPoller({
          core,
          relay: {
            publishChannelMessage: (channelId, content, replyTo) => {
              const r = relayHolder.current;
              if (!r?.isOpen) return Promise.reject(new Error("buzz relay not connected"));
              return r.publishChannelMessage(channelId, content, replyTo);
            },
          } as BuzzRelayClient,
        });
        poller.start();
        console.log(
          `${logPrefix} live as @${cfg.botName} harness=${cfg.defaultHarnessId ?? "core-default"} (overrides: channel / [[harness:…]])`,
        );

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
        console.error(`${logPrefix} session error:`, (err as Error).message);
      } finally {
        poller?.stop();
        poller = null;
        if (relayHolder.current) {
          relayHolder.current.close();
          relayHolder.current = null;
        }
      }
      if (stopped) break;
      console.log(`${logPrefix} reconnecting in ${cfg.reconnectMs}ms…`);
      await new Promise((r) => setTimeout(r, cfg.reconnectMs));
    }
  };

  void runLoop();

  return {
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      poller?.stop();
      relayHolder.current?.close();
      relayHolder.current = null;
      console.log(`${logPrefix} stopped`);
    },
  };
}
