import assert from "node:assert/strict";
import { test } from "node:test";
import { buzzPluginConfigFromEnv, harnessOverrideFromText } from "../src/buzz/config.ts";
import {
  buzzDeliveryTarget,
  buzzThreadRef,
  channelIdFromTags,
  parseBuzzDeliveryTarget,
  rootEventIdFromTags,
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
