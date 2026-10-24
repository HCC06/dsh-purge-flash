/**
 * 连拒换线：同一个 turn 里被拒到阈值，就把这一轮的 provider/model 换到阶梯的下一档。
 *
 * 依据
 * ----
 * `agent/request` 是 DSH 的 waterfall，返回值就是真正要发的 { provider, model }。
 * dsh-agent 自己的 installModelSelection 就用它改写选中模型，所以这是官方口子，
 * 不是破解。L1B3RT4S 的 ULTRAPLANIAN 是「55 个模型并行问、挑最不审查的」，
 * 这里做成串行阶梯：便宜、可解释、成本接近零。
 *
 * 防死循环
 * --------
 * 同一个 (turn) 每档最多用一次；总切换次数 <= 阶梯长度。
 */

import { log } from "./log.js";

export function installRoute(ctx, cfg, state) {
  try {
    const ladder = Array.isArray(cfg.routeLadder) ? cfg.routeLadder : [];
    if (ladder.length === 0) {
      state.layers.route = "no-ladder";
      return false;
    }
    if (typeof ctx?.on !== "function") {
      state.layers.route = "no-service";
      return false;
    }

    const off = ctx.on(
      "agent/request",
      async (payload, next) => {
        const resolved = typeof next === "function" ? await next() : payload;
        try {
          if (!resolved || typeof resolved !== "object") return resolved;
          const agent = payload?.agent;
          const sid = agent?.id || agent?.session?.id || "";
          const turn = Number(payload?.turn) || 0;
          const key = `${sid}:${turn}`;
          const refusals = state.refusals.get(key) || 0;
          if (refusals < cfg.routeAfterRefusals) return resolved;

          const slot = state.routeSlot.get(key) || 0;
          if (slot >= ladder.length) return resolved;
          const pick = ladder[slot];
          const same =
            resolved.provider === pick.provider && resolved.model === pick.model;
          state.routeSlot.set(key, slot + 1);
          if (same) return resolved;
          state.stats.routes += 1;
          log("换线", `${resolved.provider}/${resolved.model}`, "→", `${pick.provider}/${pick.model}`);
          return { ...resolved, provider: pick.provider, model: pick.model };
        } catch (e) {
          log("route 改写失败，放行原值", String(e?.message || e));
          return resolved;
        }
      },
      { global: true },
    );

    state.layers.route = "on";
    state.routeDisposer = off;
    return true;
  } catch (e) {
    state.layers.route = "failed";
    log("installRoute 失败", String(e?.message || e));
    return false;
  }
}

/** 拒绝计数：由 index 在事件流里调用。 */
export function noteRefusal(state, sessionId, turn) {
  const key = `${sessionId || ""}:${Number(turn) || 0}`;
  state.refusals.set(key, (state.refusals.get(key) || 0) + 1);
  if (state.refusals.size > 400) {
    const first = state.refusals.keys().next().value;
    if (first !== undefined) state.refusals.delete(first);
  }
}
