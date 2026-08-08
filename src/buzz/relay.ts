/**
 * Minimal NIP-01/29/42 Buzz relay client for QM surface.
 * Uses nostr-tools for keys/signing; global WebSocket for transport.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type EventTemplate } from "nostr-tools";

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

const WSImpl: typeof globalThis.WebSocket = globalThis.WebSocket;

export function parseBotSecret(raw: string): Uint8Array {
  const s = raw.trim();
  if (s.startsWith("nsec")) {
    const decoded = nip19.decode(s);
    if (decoded.type !== "nsec") throw new Error("BUZZ_BOT_PRIVATE_KEY nsec decode failed");
    return decoded.data as Uint8Array;
  }
  if (/^[0-9a-f]{64}$/i.test(s)) {
    return Uint8Array.from(Buffer.from(s, "hex"));
  }
  throw new Error("BUZZ_BOT_PRIVATE_KEY must be nsec or 64-char hex");
}

export function pubkeyHexFromSecret(sk: Uint8Array): string {
  return getPublicKey(sk);
}

export function normalizeRelayWsUrl(url: string): string {
  const u = url.trim().replace(/\/$/, "");
  if (u.startsWith("https://")) return `wss://${u.slice("https://".length)}`;
  if (u.startsWith("http://")) return `ws://${u.slice("http://".length)}`;
  return u;
}

type Handler = {
  onEvent?: (ev: NostrEvent) => void;
  onNotice?: (msg: string) => void;
  onClose?: (code: number, reason: string) => void;
};

export class BuzzRelayClient {
  private ws: WebSocket | null = null;
  private sk: Uint8Array;
  readonly pubkey: string;
  private handlers: Handler;
  private relayUrl: string;
  private authChallenge: string | null = null;
  private authWaiters: Array<(c: string) => void> = [];
  private okWaiters: Array<(ok: { id: string; accepted: boolean; message: string }) => void> = [];
  private closed = false;

  constructor(relayUrl: string, privateKey: string, handlers: Handler = {}) {
    this.relayUrl = relayUrl;
    this.sk = parseBotSecret(privateKey);
    this.pubkey = pubkeyHexFromSecret(this.sk);
    this.handlers = handlers;
  }

  async connect(): Promise<void> {
    if (!WSImpl) throw new Error("WebSocket is not available in this runtime");
    const url = normalizeRelayWsUrl(this.relayUrl);
    await new Promise<void>((resolve, reject) => {
      const ws = new WSImpl(url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("buzz relay connect timeout")), 20_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("buzz relay websocket error"));
      });
      ws.addEventListener("message", (ev) => this.onMessage(String((ev as MessageEvent).data)));
      ws.addEventListener("close", (ev) => {
        const c = ev as CloseEvent;
        this.handlers.onClose?.(c.code, c.reason);
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg.length < 1) return;
    const type = msg[0];
    if (type === "AUTH" && typeof msg[1] === "string") {
      this.authChallenge = msg[1];
      for (const w of this.authWaiters.splice(0)) w(msg[1]);
      return;
    }
    if (type === "OK" && typeof msg[1] === "string") {
      const accepted = msg[2] === true;
      const message = typeof msg[3] === "string" ? msg[3] : "";
      const payload = { id: msg[1], accepted, message };
      for (const w of this.okWaiters.splice(0)) w(payload);
      return;
    }
    if (type === "EVENT" && msg[2] && typeof msg[2] === "object") {
      this.handlers.onEvent?.(msg[2] as NostrEvent);
      return;
    }
    if (type === "NOTICE" && typeof msg[1] === "string") {
      this.handlers.onNotice?.(msg[1]);
    }
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WSImpl.OPEN) throw new Error("buzz relay not connected");
    this.ws.send(JSON.stringify(payload));
  }

  private waitChallenge(ms: number): Promise<string> {
    if (this.authChallenge) return Promise.resolve(this.authChallenge);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for AUTH challenge")), ms);
      this.authWaiters.push((c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
  }

  private waitOk(ms: number): Promise<{ id: string; accepted: boolean; message: string }> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for AUTH OK")), ms);
      this.okWaiters.push((ok) => {
        clearTimeout(t);
        resolve(ok);
      });
    });
  }

  async authenticate(authTagJson?: string): Promise<void> {
    const challenge = await this.waitChallenge(15_000);
    const tags: string[][] = [
      ["relay", normalizeRelayWsUrl(this.relayUrl)],
      ["challenge", challenge],
    ];
    if (authTagJson) {
      try {
        const parsed = JSON.parse(authTagJson) as string[];
        if (Array.isArray(parsed) && parsed[0] === "auth") tags.push(parsed);
      } catch {
        /* ignore */
      }
    }
    const event = finalizeEvent(
      {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: "",
      },
      this.sk,
    );
    const okP = this.waitOk(15_000);
    this.send(["AUTH", event]);
    const ok = await okP;
    if (!ok.accepted) {
      throw new Error(`buzz NIP-42 AUTH rejected: ${ok.message || "unknown"}`);
    }
  }

  subscribe(subId: string, filter: Record<string, unknown>): void {
    this.send(["REQ", subId, filter]);
  }

  /** NIP-01 CLOSE — drop a live subscription. */
  closeSubscription(subId: string): void {
    try {
      this.send(["CLOSE", subId]);
    } catch {
      /* ignore if socket already down */
    }
  }

  async publish(template: EventTemplate): Promise<NostrEvent> {
    const event = finalizeEvent(template, this.sk);
    this.send(["EVENT", event]);
    return event as unknown as NostrEvent;
  }

  async publishChannelMessage(channelId: string, content: string, replyTo?: string): Promise<NostrEvent> {
    const tags: string[][] = [
      ["h", channelId],
      ["client", "qm-buzz-surface"],
    ];
    if (replyTo) tags.push(["e", replyTo, "", "reply"]);
    return this.publish({
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    });
  }

  async publishProfile(name: string, about?: string): Promise<NostrEvent> {
    return this.publish({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ name, display_name: name, ...(about ? { about } : {}) }),
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  get isClosed(): boolean {
    return this.closed || !this.ws || this.ws.readyState === WSImpl.CLOSED || this.ws.readyState === WSImpl.CLOSING;
  }

  /** True when socket can send (used by reconnect-safe publish). */
  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WSImpl.OPEN && !this.closed;
  }
}

/** Mutable holder so in-flight turns publish on the live socket after reconnect. */
export type BuzzRelayHolder = { current: BuzzRelayClient | null };

export async function publishViaHolder(
  holder: BuzzRelayHolder,
  channelId: string,
  content: string,
  replyTo?: string,
  attempts = 8,
): Promise<void> {
  let lastErr: Error | undefined;
  for (let i = 0; i < attempts; i++) {
    const relay = holder.current;
    if (relay?.isOpen) {
      try {
        await relay.publishChannelMessage(channelId, content, replyTo);
        return;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    await new Promise((r) => setTimeout(r, 500 + i * 400));
  }
  throw lastErr ?? new Error("buzz relay not connected");
}

export { generateSecretKey };
