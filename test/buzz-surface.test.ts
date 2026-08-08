import assert from "node:assert/strict";
import { test } from "node:test";
import { buzzPluginConfigFromEnv, buzzPluginConfigsFromEnv, harnessOverrideFromText } from "../src/buzz/config.ts";
import {
  buzzDeliveryTarget,
  buzzThreadRef,
  channelIdFromTags,
  parseBuzzDeliveryTarget,
  rootEventIdFromTags,
  sessionRootEventId,
} from "../src/buzz/conversation.ts";
import { contentMentionsBot, resolveBuzzActor, tagsMentionPubkey } from "../src/buzz/identity.ts";

test("harnessOverrideFromText strips directive and parses model", () => {
  const r = harnessOverrideFromText("[[harness:codex model:gpt-5.6-sol]] do the thing");
  assert.equal(r.harnessId, "codex");
  assert.equal(r.modelId, "gpt-5.6-sol");
  assert.equal(r.cleanText, "do the thing");
});

test("harnessOverrideFromText no-op without directive", () => {
  const r = harnessOverrideFromText("hello qm");
  assert.equal(r.harnessId, undefined);
  assert.equal(r.cleanText, "hello qm");
});

test("buzz thread and delivery encoding round-trips", () => {
  const tr = buzzThreadRef("chan-uuid", "abc");
  assert.equal(tr, "buzz:chan-uuid:abc");
  const dt = buzzDeliveryTarget("chan-uuid", "deadbeef".repeat(8));
  const parsed = parseBuzzDeliveryTarget(dt);
  assert.ok(parsed);
  assert.equal(parsed!.channelId, "chan-uuid");
  assert.equal(parsed!.replyToEventId, "deadbeef".repeat(8));
});

test("channel and root tags", () => {
  const tags = [
    ["h", "channel-1"],
    ["e", "rootid", "", "root"],
    ["p", "pubkey1"],
  ];
  assert.equal(channelIdFromTags(tags), "channel-1");
  assert.equal(rootEventIdFromTags(tags), "rootid");
  assert.equal(tagsMentionPubkey(tags, "pubkey1"), true);
});

test("session root ignores bare e tags (prevents cross-thread bleed)", () => {
  const bare = [
    ["h", "ch"],
    ["e", "unrelated-parent"],
  ];
  assert.equal(sessionRootEventId(bare, "this-event-id"), "this-event-id");
  const replyOnly = [
    ["h", "ch"],
    ["e", "parent-msg", "", "reply"],
  ];
  assert.equal(sessionRootEventId(replyOnly, "child-id"), "parent-msg");
  const withRoot = [
    ["e", "true-root", "", "root"],
    ["e", "parent", "", "reply"],
  ];
  assert.equal(sessionRootEventId(withRoot, "child"), "true-root");
});

test("buzzPluginConfigsFromEnv multi-agent JSON", () => {
  const agents = buzzPluginConfigsFromEnv({
    BUZZ_RELAY_URL: "wss://x",
    BUZZ_CHANNELS: "chan-1",
    BUZZ_AGENTS_JSON: JSON.stringify([
      { id: "qm", name: "QM", privateKey: "0".repeat(64), defaultHarness: "pi", mentionKeywords: ["qm"] },
      {
        id: "qm-grok",
        name: "QM-Grok",
        privateKey: "1".repeat(64),
        defaultHarness: "codex",
        mentionKeywords: ["qm-grok", "grok"],
      },
    ]),
  });
  assert.equal(agents.length, 2);
  assert.equal(agents[0]!.botName, "QM");
  assert.equal(agents[0]!.defaultHarnessId, "pi");
  assert.equal(agents[1]!.agentId, "qm-grok");
  assert.equal(agents[1]!.defaultHarnessId, "codex");
});

test("principal map resolves email", () => {
  const cfg = buzzPluginConfigFromEnv({
    BUZZ_RELAY_URL: "wss://my-brain.communities.buzz.xyz",
    BUZZ_BOT_PRIVATE_KEY: "0".repeat(64),
    BUZZ_PRINCIPAL_MAP: "aabbccdd".padEnd(64, "0") + ":you@example.com;Tom",
  });
  assert.ok(cfg);
  const actor = resolveBuzzActor(cfg!, "aabbccdd".padEnd(64, "0"));
  assert.equal(actor?.externalId, "you@example.com");
  assert.equal(actor?.displayName, "Tom");
});

test("principal map accepts npub keys", async () => {
  const { nip19 } = await import("nostr-tools");
  const hex = "aabbccdd".padEnd(64, "0");
  const npub = nip19.npubEncode(hex);
  const cfg = buzzPluginConfigFromEnv({
    BUZZ_RELAY_URL: "wss://x",
    BUZZ_BOT_PRIVATE_KEY: "0".repeat(64),
    BUZZ_PRINCIPAL_MAP: `${npub}:you@example.com`,
  });
  assert.ok(cfg);
  const actor = resolveBuzzActor(cfg!, hex);
  assert.equal(actor?.externalId, "you@example.com");
});

test("unmapped pubkey fails closed unless allow", () => {
  const cfg = buzzPluginConfigFromEnv({
    BUZZ_RELAY_URL: "wss://x",
    BUZZ_BOT_PRIVATE_KEY: "1".repeat(64),
  });
  assert.equal(resolveBuzzActor(cfg!, "f".repeat(64)), null);
  const open = buzzPluginConfigFromEnv({
    BUZZ_RELAY_URL: "wss://x",
    BUZZ_BOT_PRIVATE_KEY: "1".repeat(64),
    BUZZ_ALLOW_UNMAPPED: "1",
    BUZZ_DEFAULT_PRINCIPAL: "you@example.com",
  });
  assert.equal(resolveBuzzActor(open!, "f".repeat(64))?.externalId, "you@example.com");
});

test("contentMentionsBot keywords", () => {
  const cfg = buzzPluginConfigFromEnv({
    BUZZ_RELAY_URL: "wss://x",
    BUZZ_BOT_PRIVATE_KEY: "1".repeat(64),
    BUZZ_BOT_NAME: "QM",
    BUZZ_MENTION_KEYWORDS: "qm,lab-sandbox",
  })!;
  assert.equal(contentMentionsBot(cfg, "hey @QM status", "aa"), true);
  assert.equal(contentMentionsBot(cfg, "check lab-sandbox please", "aa"), true);
  assert.equal(contentMentionsBot(cfg, "hello world", "aa"), false);
});

test("buzzPluginConfigFromEnv null without keys", () => {
  assert.equal(buzzPluginConfigFromEnv({}), null);
});

test("sanitizeBuzzOutbound replaces fancy punctuation", async () => {
  const { sanitizeBuzzOutbound } = await import("../src/buzz/sanitize.ts");
  const raw = "Status — demo \u2192 next\u2026 \u201Cquote\u201D \u00B7 bullet";
  const out = sanitizeBuzzOutbound(raw);
  assert.equal(out.includes("—"), false);
  assert.equal(out.includes("\u2192"), false);
  assert.match(out, /Status - demo/);
  assert.match(out, /->/);
  assert.match(out, /\.\.\./);
});

test("dmEnabled defaults on; BUZZ_DM=0 disables", () => {
  const on = buzzPluginConfigFromEnv({
    BUZZ_RELAY_URL: "wss://x",
    BUZZ_BOT_PRIVATE_KEY: "1".repeat(64),
  })!;
  assert.equal(on.dmEnabled, true);
  const off = buzzPluginConfigFromEnv({
    BUZZ_RELAY_URL: "wss://x",
    BUZZ_BOT_PRIVATE_KEY: "1".repeat(64),
    BUZZ_DM: "0",
  })!;
  assert.equal(off.dmEnabled, false);
});

test("sessionRootForBuzz shares unthreaded DM session per channel", async () => {
  const { sessionRootForBuzz, membershipChannelIdFromTags, isBuzzMembershipKind } = await import(
    "../src/buzz/conversation.ts"
  );
  const tags = [["h", "dm-uuid-1"]];
  const a = sessionRootForBuzz(tags, "event-a", { isDm: true, channelId: "dm-uuid-1" });
  const b = sessionRootForBuzz(tags, "event-b", { isDm: true, channelId: "dm-uuid-1" });
  assert.equal(a, "dm-session:dm-uuid-1");
  assert.equal(b, a);
  const ch = sessionRootForBuzz(tags, "event-c", { isDm: false, channelId: "dm-uuid-1" });
  assert.equal(ch, "event-c");
  const threaded = sessionRootForBuzz(
    [
      ["h", "dm-uuid-1"],
      ["e", "root-ev", "", "root"],
    ],
    "child",
    { isDm: true, channelId: "dm-uuid-1" },
  );
  assert.equal(threaded, "root-ev");
  assert.equal(membershipChannelIdFromTags([["p", "pk"], ["h", "chan-x"]]), "chan-x");
  assert.equal(isBuzzMembershipKind(44100), true);
  assert.equal(isBuzzMembershipKind(9), false);
});
