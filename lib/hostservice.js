/**
 * 宿主服务的迟到获取。
 *
 * 问题
 * ----
 * cordis 4 的 `ctx.get(name)` 默认 strict：只有**提供方 fiber 已 ACTIVE** 才返回值，
 * 否则给 undefined。插件的启动顺序不保证 `commands` / `skills` 比我们早，
 * 早一步就是永久 `no-service` —— issue #2 #3 的 `/flash`、`/armor` 打不出来就是这个。
 *
 * 而 `ctx.commands` 直接读会抛 `cannot get property "commands" without inject`，
 * 除非名字写进本插件自己的 `inject`。写进去是**硬依赖**：那些 profile 没挂
 * commands 插件时我们整个 fiber 永远 PENDING，内核跟着一起被拖死 —— 比拿不到
 * 命令更糟。
 *
 * 解法
 * ----
 * 开一个子 fiber 去等。`ctx.inject([name], cb)` 就是「子插件 + 硬依赖」，
 * 它只挂住子 fiber：服务缺席时静静待着，服务一出现立刻激活并回调，
 * 父 fiber 照常跑。
 *
 * 回调拿到的 `host` 是**外层的 ctx**，不是子 fiber 的 ctx。
 * 理由：handler 里后续要用的服务（sessionController 等）由外层 fiber 的
 * inject 保证，用子 fiber 的 ctx 反而会缺。
 */

import { log } from "./log.js";

/**
 * @param ctx      本插件的 ctx
 * @param name     服务名（commands / skills / …）
 * @param attach   (service, hostCtx) => void。抛错会被记一行，不影响父 fiber。
 * @returns "on" | "pending" | "failed" | "no-service"
 */
export function withHostService(ctx, name, attach) {
  const run = (service) => {
    try {
      if (!service || typeof service !== "object") return "no-service";
      attach(service, ctx);
      return "on";
    } catch (e) {
      log(`挂 ${name} 失败`, String(e?.message || e));
      return "failed";
    }
  };

  // 快路：服务已经在了。strict=false —— 提供方 fiber 也许还在 LOADING，
  // 但「注册一个命令 / 一本手册」这个动作不依赖它的状态机。
  let service;
  try {
    service = typeof ctx?.get === "function" ? ctx.get(name, false) : undefined;
  } catch {
    service = undefined;
  }
  if (service && typeof service === "object") return run(service);

  // 慢路：子 fiber 等它出现。
  if (typeof ctx?.inject !== "function") return "no-service";
  let status = "pending";
  try {
    ctx.inject([name], function waitForHostService(child) {
      status = run(child[name]);
    });
  } catch (e) {
    log(`等待 ${name} 失败`, String(e?.message || e));
    return "no-service";
  }
  return status;
}
