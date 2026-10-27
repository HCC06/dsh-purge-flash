#!/usr/bin/env node
// Real Cordis coverage for undeclared and late llm services; no network or user data.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { installAdapter } from "../lib/adapter.js";
import { installRoute } from "../lib/route.js";
import { normalizeConfig } from "../lib/config.js";

if (!process.env.CORDIS_PATH) {
  console.error("Set CORDIS_PATH to the host cordis/lib/index.js");
  process.exit(2);
}
const { Context, Service } = await import(pathToFileURL(process.env.CORDIS_PATH).href);
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));
const root = new Context();
const cfg = normalizeConfig({ mirror: false, prefill: "native", manyShot: "off" });
const accountAlias = `${cfg.adapterAlias}-account`;
const state = { layers: {}, stats: {}, disposers: [], refusals: new Map(), routeSlot: new Map() };
const seen = [];
const real = {
  providerInfo: (id) => ({ id, name: id }),
  providerRetryPolicy: () => ({}),
  async prepareCall(provider, model) {
    seen.push({ provider, model });
    return { dispatch(options) { seen.push(options); return options; } };
  },
};
class FakeLlm extends Service {
  constructor(ctx) { super(ctx, "llm"); this.adapters = new Map(); }
  registration(provider) {
    if (!this.adapters.has(provider)) throw Object.assign(new Error(provider), { code: "NO_ADAPTER" });
    return { adapter: this.adapters.get(provider) };
  }
  registerAdapter(providers, adapter) {
    for (const id of providers) {
      if (this.adapters.has(id)) throw Object.assign(new Error(id), { code: "DUPLICATE_ADAPTER" });
      this.adapters.set(id, adapter);
    }
    this.ctx.emit("llm/adapters-updated");
    return () => {
      for (const id of providers) if (this.adapters.get(id) === adapter) this.adapters.delete(id);
      this.ctx.emit("llm/adapters-updated");
    };
  }
}
const fiber = root.plugin({ apply(ctx) { installAdapter(ctx, cfg, state); installRoute(ctx, cfg, state); } });
await tick();
assert.equal(state.layers.adapter, "pending", "missing llm must wait without the undeclared-service exception");
console.log("ok: llm 缺席时 adapter 等待，父插件继续加载");
const route = (provider) => root.waterfall("agent/request", { provider, model: "fixture" }, async () => ({ provider, model: "fixture" }));
assert.equal((await route("deepseek-account")).provider, "deepseek-account");

let llm;
let serviceFiber = root.plugin((ctx) => { llm = new FakeLlm(ctx); });
await tick();
assert.equal(state.layers.adapter, "failed:NO_ADAPTER");
let removeSource = llm.registerAdapter(["deepseek-account"], real);
await tick();
assert.equal(state.layers.adapter, "on", "late adapter registration must activate the proxy");
assert.equal(llm.adapters.size, 2, "own registration event must not recurse or duplicate aliases");
assert.equal((await route("deepseek-account")).provider, accountAlias);
assert.equal((await route("deepseek-official")).provider, "deepseek-official");
assert.equal((await route("anthropic")).provider, "anthropic");
console.log("ok: llm 和源 adapter 迟到后挂载，路由只代理匹配 provider");

const proxy = llm.registration(accountAlias).adapter;
const call = await proxy.prepareCall(accountAlias, "fixture", undefined);
const original = Object.freeze({ messages: Object.freeze([{ role: "user", content: [{ type: "text", text: "hello" }] }]) });
await call.dispatch(original);
assert.equal(seen[0].provider, "deepseek-account");
assert.equal(seen.at(-1).messages.at(-1).role, "user");
assert.ok(seen.at(-1).messages.at(-1).content[0].text.length > "hello".length);
assert.equal(original.messages.length, 1);
console.log("ok: 真实路由的代理调用进入请求体整形，原请求未被修改");

removeSource();
await tick();
assert.equal(llm.adapters.has(accountAlias), false);
assert.equal(state.layers.adapter, "failed:NO_ADAPTER");
assert.equal((await route("deepseek-account")).provider, "deepseek-account");
const replacement = { ...real, providerInfo: (id) => ({ id, name: "replacement" }) };
removeSource = llm.registerAdapter(["deepseek-account"], replacement);
await tick();
assert.equal(state.layers.adapter, "on");
assert.match(llm.registration(accountAlias).adapter.providerInfo(accountAlias).name, /replacement/);
console.log("ok: 源 adapter 移除时撤销代理，替换后代理使用新 adapter");

const oldLlm = llm;
serviceFiber.dispose();
await tick();
assert.equal(oldLlm.adapters.has(accountAlias), false, "service removal must dispose the alias");
assert.equal(state.layers.adapter, "pending");
assert.equal((await route("deepseek-account")).provider, "deepseek-account");
serviceFiber = root.plugin((ctx) => { llm = new FakeLlm(ctx); llm.registerAdapter(["deepseek-account"], real); });
await tick();
assert.equal(state.layers.adapter, "on");
assert.equal((await route("deepseek-account")).provider, accountAlias);
console.log("ok: llm 服务重载后重新挂载，缺席期间不改路由");

fiber.dispose();
await tick();
assert.equal(llm.adapters.has(accountAlias), false);
assert.equal((await route("deepseek-account")).provider, "deepseek-account");
serviceFiber.dispose();
console.log("ok: 插件卸载清理 adapter 和路由");
