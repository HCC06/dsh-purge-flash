/**
 * 配置：全部字段在这里定型，其它模块只读。
 *
 * 原则：默认值必须能在「什么都不改」的情况下把四层全部挂上；
 * 任何一层挂不上只降级、不抛错（宿主会因为一行 fiber 失败就报 Failed to load plugins）。
 */

export const DEFAULTS = Object.freeze({
  // L0 提示词内核
  enabled: true,
  kernel: "auto", // auto | deepseek | claude | openai-compat | generic | off
  kernelOrder: -100000,
  kernelOverrideFile: "", // 非空则从该文件读内核（覆盖内置）

  // L1 宿主侧剥离
  stripOfficial: true, // 剥官方身份句 + 拦截句

  // L1 拒绝修补
  prefillAnchor: true, // 每轮首步追加「已开始输出：」
  repairOnRefusal: true,
  repairMaxPerTurn: 2,

  // L1.5 连拒换线
  routeLadder: [], // [{ provider, model }]，空 = 不换
  routeAfterRefusals: 2,

  // L2 反撤回
  mirror: true,
  mirrorDir: "purge-flash-raw",
  rawStream: true, // llm/stream tee
  shadowSnapshot: true, // 遮蔽前先抄原文
  retractProbe: true, // 扫「我之前的回答作废」类自我撤回

  // L3 按需技能
  playbook: true,

  // Tier B 宿主补丁（默认 off）
  patches: "none", // none | gateway

  // 记账
  verbose: false,
});

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function asLadder(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const provider = String(row.provider || "").trim();
    const model = String(row.model || "").trim();
    if (!provider || !model) continue;
    out.push({ provider, model });
  }
  return out;
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const kernel = String(src.kernel || DEFAULTS.kernel).toLowerCase();
  return {
    enabled: src.enabled !== false,
    kernel: ["auto", "deepseek", "claude", "openai-compat", "generic", "off"].includes(kernel)
      ? kernel
      : DEFAULTS.kernel,
    kernelOrder: Number.isFinite(Number(src.kernelOrder)) ? Number(src.kernelOrder) : DEFAULTS.kernelOrder,
    kernelOverrideFile: typeof src.kernelOverrideFile === "string" ? src.kernelOverrideFile : "",
    stripOfficial: src.stripOfficial !== false,
    prefillAnchor: src.prefillAnchor !== false,
    repairOnRefusal: src.repairOnRefusal !== false,
    repairMaxPerTurn: clampInt(src.repairMaxPerTurn, DEFAULTS.repairMaxPerTurn, 0, 8),
    routeLadder: asLadder(src.routeLadder),
    routeAfterRefusals: clampInt(src.routeAfterRefusals, DEFAULTS.routeAfterRefusals, 1, 8),
    mirror: src.mirror !== false,
    mirrorDir: typeof src.mirrorDir === "string" && src.mirrorDir.trim() ? src.mirrorDir.trim() : DEFAULTS.mirrorDir,
    rawStream: src.rawStream !== false,
    shadowSnapshot: src.shadowSnapshot !== false,
    retractProbe: src.retractProbe !== false,
    playbook: src.playbook !== false,
    patches: String(src.patches || DEFAULTS.patches).toLowerCase() === "gateway" ? "gateway" : "none",
    verbose: src.verbose === true,
  };
}
