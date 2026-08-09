import type { BuzzCoreClient } from "../api/buzz-core-client.ts";
import type { BuzzPluginConfig } from "./config.ts";
import {
  BUZZ_MEMBERSHIP_ADDED,
  BUZZ_MEMBERSHIP_REMOVED,
  isBuzzMembershipKind,
  membershipChannelIdFromTags,
} from "./conversation.ts";
import { createBuzzDeliveryPoller } from "./deliveries.ts";
import { createBuzzProactive, subscribeScoutReactions } from "./proactive.ts";
import { BuzzRelayClient, type BuzzRelayHolder, type NostrEvent } from "./relay.ts";
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
  let scout: ReturnType<typeof createBuzzProactive> | null = null;
  const logPrefix = `[buzz-plugin:${cfg.agentId}]`;
  /** Shared buffer for proactive scout (and optional history warm-up). */
  const recentByChannel = new Map<string, NostrEvent[]>();

  const runLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        let handler: ReturnType<typeof createBuzzTurnHandler> | null = null;

        // Public channels from env (stable across reconnect within a session object).
        const publicChannelIds = new Set(cfg.channelIds);
        // Discovered DM channel UUIDs → live kind:9 subscription id.
        const dmChannels = new Map<string, string>();
        // principalId (email) → last DM channel they wrote from (for approval alerts).
        const dmByPrincipal = new Map<string, string>();

        const dmRegistry = {
          isDmChannel(channelId: string): boolean {
            return dmChannels.has(channelId);
          },
          dmChannelForPrincipal(principalId: string): string | undefined {
            return dmByPrincipal.get(principalId);
          },
          rememberDmPrincipal(principalId: string, channelId: string): void {
            if (principalId && channelId) dmByPrincipal.set(principalId, channelId);
          },
        };

        const subscribeKind9 = (
          relay: BuzzRelayClient,
          channelId: string,
          label: string,
          /** How far back to request (seconds). Public channels use a short window; DM discovery catches up. */
          lookbackSec = 5,
        ): string => {
          const subId = `qm-buzz-${cfg.agentId}-${label}-${channelId.slice(0, 8)}`;
          relay.subscribe(subId, {
            kinds: [9],
            "#h": [channelId],
            since: Math.floor(Date.now() / 1000) - lookbackSec,
          });
          return subId;
        };

        const addDmChannel = (relay: BuzzRelayClient, channelId: string, reason: string): void => {
          if (!channelId || publicChannelIds.has(channelId) || dmChannels.has(channelId)) return;
          // Short lookback only: long windows re-fire entire DM history on every reconnect.
          // Membership history discovers which channels to watch; live kind:9 carries new msgs.
          const subId = subscribeKind9(relay, channelId, "dm", 30);
          dmChannels.set(channelId, subId);
          console.log(`${logPrefix} DM channel subscribed ${channelId.slice(0, 8)}… (${reason})`);
        };

        const removeDmChannel = (relay: BuzzRelayClient, channelId: string): void => {
          const subId = dmChannels.get(channelId);
          if (!subId) return;
          relay.closeSubscription(subId);
          dmChannels.delete(channelId);
          console.log(`${logPrefix} DM channel unsubscribed ${channelId.slice(0, 8)}…`);
        };

        const handleMembership = (relay: BuzzRelayClient, ev: NostrEvent): void => {
          const channelId = membershipChannelIdFromTags(ev.tags);
          if (!channelId) {
            console.warn(`${logPrefix} membership kind:${ev.kind} without #h; ignoring`);
            return;
          }
          if (ev.kind === BUZZ_MEMBERSHIP_ADDED) {
            addDmChannel(relay, channelId, "membership-added");
          } else if (ev.kind === BUZZ_MEMBERSHIP_REMOVED) {
            removeDmChannel(relay, channelId);
          }
        };

        const relay = new BuzzRelayClient(cfg.relayUrl, cfg.botPrivateKey, {
          onEvent: (ev) => {
            if (cfg.dmEnabled && isBuzzMembershipKind(ev.kind)) {
              const r = relayHolder.current;
              if (r) handleMembership(r, ev);
              return;
            }
            if (ev.kind === 7) {
              scout?.onKind7(ev);
              return;
            }
            if (ev.kind === 9) {
              scout?.onKind9(ev);
            }
            // Dedicated scout identity does not also run reactive turns.
            if (cfg.proactiveOnly) return;
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

        if (cfg.proactiveEnabled) {
          scout = createBuzzProactive({
            cfg,
            core,
            relayHolder,
            botPubkey: relay.pubkey,
            recentByChannel,
            handoffPubkey: cfg.proactiveHandoffPubkey,
            handoffName: cfg.proactiveHandoffName,
            siblingPubkeys: cfg.siblingPubkeys,
          });
        }

        if (!cfg.proactiveOnly) {
          handler = createBuzzTurnHandler({
            cfg,
            core,
            relayHolder,
            botPubkey: relay.pubkey,
            dmRegistry,
          });
        }

        console.log(`${logPrefix} connecting to ${cfg.relayUrl} as ${relay.pubkey.slice(0, 12)}…`);
        await relay.connect();
        await relay.authenticate(cfg.authTagJson);
        try {
          await relay.publishProfile(
            cfg.botName,
            cfg.about ??
              (cfg.proactiveOnly
                ? "Proactive scout — suggests follow-ups; react 👍 to execute"
                : "QM multiplayer ops agent (Buzz surface)"),
          );
        } catch (err) {
          console.warn(`${logPrefix} profile publish failed (non-fatal):`, (err as Error).message);
        }

        // Warm buffer: slightly longer lookback when scout is on.
        const lookback = cfg.proactiveEnabled ? 3_600 : 5;
        if (cfg.channelIds.length) {
          for (const channelId of cfg.channelIds) {
            subscribeKind9(relay, channelId, "ch", lookback);
            console.log(`${logPrefix} subscribed channel ${channelId}`);
          }
        } else {
          relay.subscribe(`qm-buzz-${cfg.agentId}-all`, {
            kinds: [9],
            since: Math.floor(Date.now() / 1000) - lookback,
          });
          console.log(`${logPrefix} subscribed all kind:9 (set BUZZ_CHANNELS to narrow)`);
        }

        if (cfg.proactiveEnabled) {
          subscribeScoutReactions(relay, cfg.agentId);
          scout?.start();
          console.log(
            `${logPrefix} scout on interval=${cfg.proactiveIntervalSec}s only=${cfg.proactiveOnly ? "yes" : "no"}`,
          );
        }

        // Buzz DMs are NIP-29 hidden channels. Discover via membership notifications
        // (kind:44100/44101, #p must match bot pubkey) then SEQ kind:9 per DM UUID.
        if (cfg.dmEnabled && !cfg.proactiveOnly) {
          relay.subscribe(`qm-buzz-${cfg.agentId}-membership`, {
            kinds: [BUZZ_MEMBERSHIP_ADDED, BUZZ_MEMBERSHIP_REMOVED],
            "#p": [relay.pubkey],
            // No `since`: pick up existing DM memberships on boot.
          });
          console.log(
            `${logPrefix} DM discovery on (membership 44100/44101 #p=${relay.pubkey.slice(0, 12)}…)`,
          );
        } else {
          console.log(
            `${logPrefix} DM discovery ${cfg.proactiveOnly ? "skipped (scout-only)" : "off (BUZZ_DM=0)"}`,
          );
        }

        // Scout-only agents do not claim channel deliveries (Brain owns recovery publishes).
        // Agent-scoped type prevents dual-bot double posts of the same run result.
        if (!cfg.proactiveOnly) {
          poller = createBuzzDeliveryPoller({
            core,
            deliveryType: `buzz:${cfg.agentId}`,
            relay: {
              publishChannelMessage: (channelId, content, replyTo, rootId) => {
                const r = relayHolder.current;
                if (!r?.isOpen) return Promise.reject(new Error("buzz relay not connected"));
                return r.publishChannelMessage(channelId, content, replyTo, rootId);
              },
            } as BuzzRelayClient,
          });
          poller.start();
        }
        console.log(
          `${logPrefix} live as @${cfg.botName} harness=${cfg.defaultHarnessId ?? "core-default"} dm=${cfg.dmEnabled ? "on" : "off"} proactive=${cfg.proactiveEnabled ? "on" : "off"} poller=${cfg.proactiveOnly ? "off" : "on"} (overrides: channel / [[harness:…]])`,
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
        scout?.stop();
        scout = null;
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
      scout?.stop();
      scout = null;
      poller?.stop();
      relayHolder.current?.close();
      relayHolder.current = null;
      console.log(`${logPrefix} stopped`);
    },
  };
}
