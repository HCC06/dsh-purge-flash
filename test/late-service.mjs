#!/usr/bin/env node
/**
 * 迟到服务回归：issue #2 第 2 条 / issue #3 —— `/flash`、`/armor` 打不出来。
 *
 *   node test/late-service.mjs
 *
 * 场景：宿主先挂起我们的插件，`commands` / `skills` 服务晚一步才上线
 * （DSH 里这两个是独立插件，装载顺序不保证）。
 *
 * 1.5.2 的写法是 `ctx.get("commands")` —— cordis 4 里 strict 默认 true，
 * 提供方 fiber 还没 ACTIVE 就给 undefined，于是命令层永远 `no-service`。
 * 而这个 undefined 发生在 apply 的那一瞬间，之后再也不会重试。
 *
 * 现在的写法用子 fiber（ctx.inject）等它：服务一出现就把命令注册上。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

function findCordis() {
  const cands = [];
  if (process.env.CORDIS_PATH) cands.push(process.env.CORDIS_PATH);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    cands.push(path.join(dir, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const roots = [];
  if (process.env.DSH_INSTALL) roots.push(process.env.DSH_INSTALL);
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "Programs", "deepseek official desktop"));
  roots.push("D:/AI/deepseek official desktop", "C:/Program Files/deepseek official desktop");
  for (const root of roots) {
    if (!root) continue;
    cands.push(
      path.join(root, "dsh", "resources", "app", "dsh", "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"),
      path.join(root, "resources", "app", "dsh", "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"),
      path.join(root, "resources", "app", "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"),
    );
  }
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

const CORDIS_FILE = findCordis();
if (!CORDIS_FILE) {
  console.error("找不到宿主 cordis —— 这个测试需要真 cordis，跳过（不算失败）");
  console.error("要跑就设 CORDIS_PATH=<cordis/lib/index.js>");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-late-"));
process.env.DSH_HOME = tmp;

const cordis = await import(pathToFileURL(CORDIS_FILE).href);
const { Context, Service } = cordis;
if (typeof Context !== "function" || typeof Service !== "function") {
  console.error("cordis 导出里没有 Context / Service，跳过");
  process.exit(2);
}

let failures = 0;
function ok(name, detail) {
  console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
}
function bad(name, detail) {
  failures += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** 假的 systemPrompt：只要 section() 存在，内核层就会挂上去。 */
class FakeSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, "systemPrompt");
    this.sections = [];
  }
  section(def) {
    this.sections.push(def);
    return () => {
      const i = this.sections.indexOf(def);
      if (i >= 0) this.sections.splice(i, 1);
    };
  }
}

/** 假的 commands：形状对齐 @deepseek-ai/dsh-commands 的 register()。 */
class FakeCommands extends Service {
  constructor(ctx) {
    super(ctx, "commands");
    this.commands = new Map();
  }
  register(definition) {
    if (!definition?.name) throw new TypeError("name required");
    this.commands.set(definition.name, definition);
    return () => this.commands.delete(definition.name);
  }
}

class FakeSkills extends Service {
  constructor(ctx) {
    super(ctx, "skills");
    this.skills = new Map();
  }
  register(skill) {
    this.skills.set(skill.name, skill);
    return () => this.skills.delete(skill.name);
  }
}

const plugin = await import("../lib/index.js");

// 操作稿：九成 ASCII，正是 issue #2 第 4 条那份被高估 2.7 倍的样子。
const operatorText = `${"The operator authorised this request. ".repeat(500)}\n${"授权按此执行。".repeat(200)}\n`;
fs.writeFileSync(path.join(tmp, "prompt-inject.md"), operatorText, "utf8");

console.log("1. 只有 systemPrompt，commands / skills 尚未出现");

const root = new Context();
const promptPlugin = () => new FakeSystemPrompt(root.ctx ?? root);
root.plugin(promptPlugin);
await tick();

const fiber = root.plugin(plugin, {
  enabled: true,
  mirror: false,
  playbook: true,
});
await tick(120);

const ctx = root.ctx ?? root;
const before = (() => {
  try {
    return ctx.get("commands", false);
  } catch {
    return undefined;
  }
})();
if (!before) ok("此刻确实没有 commands 服务 —— 这就是 1.5.2 永久 no-service 的那一刻");
else ok("意外已经有了 commands 服务，测试仍可继续");

console.log("\n2. commands / skills 后上线");

let commands;
let skills;
root.plugin((c) => {
  commands = new FakeCommands(c);
});
root.plugin((c) => {
  skills = new FakeSkills(c);
});
await tick(200);

if (!commands) {
  bad("假 commands 服务没建起来");
} else {
  const names = [...commands.commands.keys()];
  if (names.includes("flash") && names.includes("armor")) {
    ok("迟到之后 /flash 与 /armor 都注册上了", names.join(", "));
  } else {
    bad("命令没注册上", `只有 ${names.join(", ") || "（空）"}`);
  }
}

if (!skills) {
  bad("假 skills 服务没建起来");
} else {
  const names = [...skills.skills.keys()];
  if (names.includes("armor-playbook")) ok("迟到之后 armor-playbook 手册注册上了");
  else bad("手册没注册上", names.join(", ") || "（空）");
}

console.log("\n3. 命令体真的能用");

if (commands?.commands.has("flash")) {
  const def = commands.commands.get("flash");
  let result;
  try {
    result = await def.handler({ rawInput: "light" });
  } catch (e) {
    bad("/flash light 抛错", String(e?.message || e));
  }
  if (result?.kind === "success" && String(result.text).includes("purge-flash 状态")) {
    ok("/flash light 返回状态面板");
    const text = String(result.text);
    if (text.includes("命令层")) ok("面板里有「命令层」一行");

    // 操作稿 token 估算：必须跟 estimateTokens 一套，不是 chars × 0.72。
    const { estimateTokens } = await import("../lib/detect.js");
    const want = estimateTokens(operatorText);
    const naive = Math.round(operatorText.length * 0.72);
    const m = /操作稿\s+✓ on\s+(\d+) 字符 ≈ (\d+) tok/.exec(text);
    if (!m) {
      bad("面板里没有操作稿 token", text.split("\n").slice(0, 8).join(" | "));
    } else {
      const shown = Number(m[2]);
      if (Math.abs(shown - want) <= Math.max(3, want * 0.02)) {
        ok("操作稿 token 与估算器一致", `${shown} tok（chars×0.72 会报 ${naive}）`);
      } else {
        bad("操作稿 token 估算还是错的", `显示 ${shown}，估算器 ${want}，粗暴乘 ${naive}`);
      }
    }
  } else if (result) {
    bad("/flash light 返回值不对", JSON.stringify(result).slice(0, 200));
  }
}

console.log("\n4. 卸载不抛错");
try {
  fiber.dispose();
  await tick(80);
  ok("fiber.dispose() 干净退出");
} catch (e) {
  bad("dispose 抛错", String(e?.message || e));
}

console.log(`\n${failures === 0 ? "迟到服务回归通过" : "迟到服务回归有失败"}：${failures} 处失败`);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(failures === 0 ? 0 : 1);
