#!/usr/bin/env node
// Offline integration with the real host LlmRuntime and Cordis contracts.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { installAdapter } from "../lib/adapter.js";
import { installRoute } from "../lib/route.js";
import { normalizeConfig } from "../lib/config.js";

assert.ok(process.env.CORDIS_PATH, "Set CORDIS_PATH to the host cordis/lib/index.js");
const { Context } = await import(pathToFileURL(process.env.CORDIS_PATH).href);
const llmFile = process.env.CORDIS_PATH.replace(/\/cordis\/lib\/index\.js$/, "/dsh-llm/lib/index.js");
const { LlmRuntime, LlmAdapter } = await import(pathToFileURL(llmFile).href);
const root = new Context();
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
let llm;
const service = root.plugin((ctx) => { llm = new LlmRuntime(ctx); });
await tick();
const seen = [];
class OfflineAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: provider }; }
  listModels(provider) { return Promise.resolve([{ provider, id: "fixture", name: "fixture" }]); }
  imageRequestPricing(provider) { return { provider }; }
  imageRequestTarget(provider, model, image) { return { width: image.width, height: image.height, maxBytes: image.bytes, provider }; }
  async *stream(options) { seen.push(options); yield { type: "finish", reason: { kind: "stop" } }; }
}
const sourceHandles = ["deepseek-account", "deepseek-official"].map((id) => llm.registerAdapter([id], new OfflineAdapter()));
const cfg = normalizeConfig({ mirror: false, prefill: "auto", manyShot: "off", retryOnRefusal: "off" });
const state = { layers: {}, stats: {}, disposers: [], refusals: new Map(), routeSlot: new Map() };
const plugin = root.plugin({ apply(ctx) { installAdapter(ctx, cfg, state); installRoute(ctx, cfg, state); } });
await tick();
assert.equal(state.layers.adapter, "on");

for (const source of ["deepseek-account", "deepseek-official"]) {
  const config = await root.waterfall("agent/request", {}, async () => ({ provider: source, model: "fixture" }));
  assert.notEqual(config.provider, source, `${source} must be routed through its own proxy`);
  assert.equal((await llm.listModels(config.provider))[0].provider, config.provider);
  assert.equal((await llm.resolveModelInfo(config.provider, "fixture" )).provider, config.provider);
  assert.equal(llm.imageRequestPricing(config.provider, "fixture").provider, source);
  assert.equal(llm.imageRequestTarget(config.provider, "fixture", { width: 1, height: 1, bytes: 3 }).provider, source);
  const call = await llm.prepareCall(config, new AbortController().signal);
  const messages = Object.freeze([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  const chunks = [];
  for await (const chunk of call.stream({ ...call.config, messages })) chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, "stop");
  const wire = seen.at(-1);
  assert.equal(wire.provider, source, "source adapter must receive its own provider identity");
  assert.equal(wire.messages.at(-1).role, "user");
  assert.ok(wire.messages.at(-1).content[0].text.length > "hello".length, "Messages prefill must use compatible text shaping");
  assert.equal(messages.length, 1);
  console.log(`ok: ${source} 通过真实 LlmRuntime 准备/分发，metadata 和文本整形正常`);
}
assert.equal(state.stats.prefill, 2);
assert.equal((await root.waterfall("agent/request", {}, async () => ({ provider: "anthropic", model: "fixture" }))).provider, "anthropic");
plugin.dispose();
await tick();
for (const handle of sourceHandles) handle();
service.dispose();
console.log("ok: 多 provider 代理通过，其他 provider 保持原样");
