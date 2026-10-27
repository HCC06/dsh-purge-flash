#!/usr/bin/env node
// Exercise the host Messages serializer without network or real credentials.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { makeProxyAdapter } from "../lib/adapter.js";
import { normalizeConfig } from "../lib/config.js";

assert.ok(process.env.CORDIS_PATH);
const file = process.env.CORDIS_PATH.replace(/\/cordis\/lib\/index\.js$/, "/dsh-llm-deepseek/lib/index.js");
const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(file).href);
const connection = resolveAdapterOptions({ baseURL: "https://offline.invalid", reasoningEffort: "high" });
const real = new DeepSeekAdapter({ options: () => connection, resolveAuth: () => ({ headers: {} }), resolveUserId: () => "offline", prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) });
const originalFetch = globalThis.fetch;
let wire;
globalThis.fetch = async (_url, init) => {
  wire = JSON.parse(init.body);
  if (wire.thinking.type === "enabled" && wire.messages.some((message) => message.role === "assistant" && !message.content.some((block) => block.type === "thinking"))) {
    return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "The content[].thinking in the thinking mode must be passed back to the API." } }), { status: 400 });
  }
  const events = [
    ["message_start", { type: "message_start", message: { id: "offline", usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return new Response(events.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};
try {
  for (const source of ["deepseek-official", "deepseek-account"]) {
    const state = { stats: {}, escalation: new Map() };
    const cfg = normalizeConfig({ adapterSource: source, prefill: "native", manyShot: 2, shadowRefusal: "on", reasoningScrub: "on", retryOnRefusal: "off" });
    const proxy = makeProxyAdapter(real, cfg, state);
    const history = { role: "assistant", content: [{ type: "reasoning", text: "offline reasoning" }, { type: "text", text: "I cannot assist with that request." }], source: { kind: "model", provider: source, model: "fixture" } };
    const snapshot = JSON.stringify(history);
    const messages = [{ role: "user", content: [{ type: "text", text: "previous" }] }, history, { role: "user", content: [{ type: "text", text: "hello" }] }];
    const call = await proxy.prepareCall("offline-alias", "fixture");
    const chunks = [];
    for await (const chunk of call.stream({ provider: "offline-alias", model: "fixture", reasoningEffort: "high", messages })) chunks.push(chunk);
    assert.equal(chunks.at(-1).reason.kind, "stop", JSON.stringify(chunks.at(-1)));
    const assistants = wire.messages.filter((message) => message.role === "assistant");
    assert.equal(assistants.length, 1, "Messages thinking requests must not acquire synthetic assistant turns");
    assert.deepEqual(assistants[0].content, [{ type: "thinking", thinking: "offline reasoning" }, { type: "text", text: "I cannot assist with that request." }]);
    assert.equal(wire.messages.at(-1).role, "user");
    assert.equal(JSON.stringify(history), snapshot);
    assert.equal(state.stats.prefill, 1, "text shaping must still run");
    assert.equal(state.stats.shots || 0, 0);
    console.log(`ok: ${source} 真 Messages 序列化保留 thinking，文本整形生效，无 synthetic assistant`);

    const offState = { stats: {}, escalation: new Map() };
    const offProxy = makeProxyAdapter(real, cfg, offState);
    const offCall = await offProxy.prepareCall("offline-alias", "fixture");
    const offChunks = [];
    for await (const chunk of offCall.stream({ provider: "offline-alias", model: "fixture", reasoningEffort: "off", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })) offChunks.push(chunk);
    assert.equal(offChunks.at(-1).reason.kind, "stop");
    assert.equal(wire.thinking.type, "disabled");
    assert.equal(wire.messages.filter((message) => message.role === "assistant").length, 2, "non-thinking requests may retain the configured many-shot examples");
    assert.equal(wire.messages.at(-1).role, "user", "Messages still uses text prefill when thinking is off");
    assert.equal(offState.prefillMode, "text");
    assert.equal(offState.manyShotMode, 2);
    assert.equal(offState.shadowRefusalMode, "on");
    assert.equal(offState.stats.prefill, 1);
    assert.equal(offState.stats.shots, 1);
    console.log(`ok: ${source} reasoningEffort=off 保留配置的 many-shot，仍使用 Messages 文本整形`);
  }
} finally { globalThis.fetch = originalFetch; }
