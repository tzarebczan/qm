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
  private authChallenge: string | null = null;
  private authWaiters: Array<(c: string) => void> = [];
  private closed = false;

  constructor(
    private relayUrl: string,
    privateKey: string,
    handlers: Handler = {},
  ) {
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
    this.send(["AUTH", event]);
  }

  subscribe(subId: string, filter: Record<string, unknown>): void {
    this.send(["REQ", subId, filter]);
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
    return this.closed || !this.ws || this.ws.readyState === WSImpl.CLOSED;
  }
}

export { generateSecretKey };
