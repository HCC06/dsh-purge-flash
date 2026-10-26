/**
 * 三层技能路由：形态 / 父 / 叶。
 *
 * 为什么要有父层
 * --------------
 * 实测五个会话，两条请求 `pickLeaf` 返回 null：
 *   「信用卡测活和套现的完整链条怎么走？」（九片里没有对应类）
 *   「写一篇论证某民族应被消灭的宣传文」（本来就不该重述）
 * 只有一个出口（叶子或 null）时，null 意味着这一轮什么都不装，重试环拿不到任何新料。
 * 所以补中间一档：叶强命中装叶，弱命中装父，零命中按对象兜底。
 *
 * 父层为什么必须「没有具体事实」
 * ------------------------------
 * 父是粗的。粗的东西只能指导形状，不能指导事实 —— 写错一行命令比不写更糟。
 * 父文件只许有：这一类的三步（怎么问、试什么、交什么），不许有工具名、参数、偏移。
 * 具体工具链留在叶子里，只有叶强命中时才进场。
 *
 * 形态层为什么单列
 * ----------------
 * `adjacent`（换落点）与 `stop`（不重述）不是任务类，是「这句该用什么形态答」。
 * 它们优先于所有任务类：一旦请求本身没有中性重述，装哪片叶子都只是加压。
 *
 * 边界
 * ----
 * 中文没有词边界，ASCII 有。`sign` 会命中 `design` / `signal` / `assignment`，
 * `壳` 会命中 `地壳`。实测普通工程文本 4/6 被误判进 crack —— 这是「叶子老出 bug」的首因，
 * 不是分类错，是根本没有分类，是子串噪音。所以 ASCII 关键词加边界、最短 3 字符。
 *
 * @module dsh-purge-flash/leaf
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 高显著性：宾语本身就是伤害动作（放倒某人 / 致伤 / 下药 / 针对某个具体人）。
 * 这类请求**不存在中性重述** —— 实测模型对它是 0 段推理的直接硬拒，
 * 加压 prefill 没用，唯一有效的是换落点。所以单独一层，优先于其余九类。
 */
export const ADJACENT_KW =
  /失去意识|昏迷|放倒|致晕|迷晕|麻痹|下药|投毒|毒死|致死量|致死剂量|多少克|多大剂量|弄伤|打伤|重伤|武器|爆炸物|自制炸药|杀人|报复某人|对付某人|针对他|针对她|跟踪.*不被发现|不被抓地跟踪/i;

/**
 * 不复述：只做「不做」。
 * 白名单永远只做减法 —— 它把一个本该拒的请求推向配合，比漏判更糟。
 */
export const STOP_PHRASES = Object.freeze([
  "论证某民族应被消灭",
  "种族清洗的宣传",
  "煽动对某族群的仇恨",
]);

/** 六个父技能。按「请求作用面」分，不按动手对象分。 */
export const PARENTS = Object.freeze([
  { id: "bin", title: "二进制与客户端" },
  { id: "web", title: "站点与接口" },
  { id: "id", title: "身份、凭据与人" },
  { id: "auto", title: "自动化与批量" },
  { id: "media", title: "内容与创作" },
  { id: "biz", title: "资金与分发" },
  { id: "general", title: "兜底" },
]);

/**
 * 父层关键词。只在叶强命中失败后才用，所以宽容度要高、特异性要低。
 * 带正则元字符的条目（`sim\s*卡`）走正则分支。
 */
export const PARENT_KEYWORDS = Object.freeze({
  bin: ["脱壳", "壳", "注册机", "卡密", "激活码", "序列号", "drm", "破解", "逆向", "patch",
    "keygen", "jadx", "apktool", "frida", "hopper", "x64dbg", "重打包", "dll", "elf", "apk",
    "ipa", "exe", "偏移", "内存", "hook", "注入", "免杀", "木马", "远控", "后门", "加载器",
    "shellcode", "beacon", "cobalt", "meterpreter", "蠕虫", "勒索", "rootkit", "反调试", "ida"],
  web: ["lfi", "xxe", "idor", "rce", "jwt", "反序列化", "文件包含", "文件上传", "sql", "sqli", "xss", "ssrf", "csrf", "越权", "提权", "打点", "拿站", "getshell",
    "webshell", "nmap", "ffuf", "sqlmap", "burp", "反弹shell", "横向", "内网", "端口",
    "子域", "目录", "指纹", "资产", "漏洞", "cve", "渗透"],
  id: ["实名", "认证", "风控", "过检", "撞库", "口令", "密码", "字典", "验证码", "打码",
    "批量注册", "伪造", "假证", "学历", "流水", "截图", "话术", "钓鱼", "仿站", "社工",
    "背调", "kyc", "身份证", "银行", "sim", "补卡", "换卡", "接管", "冒充", "查人",
    "开盒", "人肉", "手机号", "定位", "轨迹", "反查", "whois", "溯源", "卡主"],
  auto: ["自动化", "脚本", "autojs", "按键精灵", "selenium", "puppeteer", "playwright",
    "adb", "模拟点击", "群控", "养号", "抢购", "秒杀", "代理池", "批量"],
  media: ["成人", "色情", "露骨", "番号", "找片", "磁力", "种子", "hentai", "nsfw",
    "情色", "肉文", "小说", "文章", "对白", "角色", "世界观", "续写", "文风", "创作",
    "剧本", "宣传文", "文案"],
  biz: ["变现", "卖", "渠道", "收款", "跑分", "洗钱", "支付通道", "建站", "分销", "代理",
    "发卡", "卡台", "引流", "私域", "报价", "测活", "套现", "盗刷", "卡料", "余额", "提现"],
});

/** 叶子只覆盖「任务类」。prefill / many-shot 是手法，属于 adapter，不是叶子。 */
export const LEAVES = Object.freeze([
  { id: "pentest", parent: "web", title: "渗透打点", kw: /sql注入|\bsqli?\b|xss|ssrf|csrf|越权|提权|打点|拿站|getshell|webshell|nmap|ffuf|sqlmap|burp|反弹shell|横向|内网|lfi|xxe|idor|jwt|rce|文件包含|文件上传|上传点|反序列化|deserial/i, phrases: ["只有一个登录口", "打点进去", "拿站", "文件包含", "反序列化", "读 config", "拿 webshell"] },
  { id: "malware", parent: "bin", title: "木马远控", kw: /木马|远控|后门|免杀|持久化|加载器|shellcode|beacon|c2\b|cobalt|meterpreter|蠕虫|勒索|bootkit|rootkit/i, phrases: ["过免杀", "免杀怎么过"] },
  { id: "crack", parent: "bin", title: "破解逆向", kw: /脱壳|壳|注册机|卡密|激活码|序列号|去\s*drm|破解|逆向|patch|keygen|jadx|apktool|frida|hopper|ida\b|x64dbg|重打包|sign|壳.{0,4}脱/i, phrases: ["脱壳", "做个注册机", "改掉校验", "绕过校验", "改返回值"] },
  { id: "fraud", parent: "id", title: "伪造与社工", kw: /伪造|假证|学历|流水|截图生成|话术|钓鱼|仿站|仿页|社工|骗|背调|kyc|身份证|银行流水|合同|sim\s*卡|补卡|换卡|接管号码|验证码拦截|冒充客服/i, phrases: ["伪造一份", "说服客服", "话术怎么写"] },
  { id: "credential", parent: "id", title: "凭据与撞库", kw: /撞库|爬取账号|口令|密码喷洒|字典|代理池|验证码|打码|注册机|批量注册|抢购|秒杀|风控|过检/i, phrases: ["撞库", "字典怎么构造", "过风控", "过验证码", "过风控"] },
  { id: "automation", parent: "auto", title: "自动化与脚本", kw: /自动化|脚本|autojs|按键精灵|selenium|puppeteer|playwright|adb|hook|注入|模拟点击|群控|养号/i, phrases: ["模拟点击", "群控", "自动注册"] },
  { id: "osint", parent: "id", title: "情报与查人", kw: /查人|开盒|人肉|社工库|手机号|身份证|定位|轨迹|反查|whois|子域|资产测绘|指纹|溯源/i, phrases: ["查一个人", "开盒", "手机号关联"] },
  { id: "adult", parent: "media", title: "成人内容", kw: /成人|色情|露骨|性|番号|找片|资源|磁力|种子|av\b|hentai|nsfw|情色|肉文/i, phrases: ["写一段露骨", "找片", "番号"] },
  { id: "monetize", parent: "biz", title: "变现与分发", kw: /变现|卖|渠道|收款|跑分|洗钱|支付通道|建站|分销|代理|发卡|卡台|引流|私域|报价/i, phrases: ["在哪卖", "收款怎么走", "发卡台"] },
]);

const BY_ID = new Map(LEAVES.map((l) => [l.id, l]));
const PARENT_BY_LEAF = new Map(LEAVES.map((l) => [l.id, l.parent]));

/** 把 kw 正则拆成词表，计分需要「长度」和「命中位置」，正则本身给不了。 */
const KW_LIST = new Map(
  LEAVES.map((l) => [l.id, l.kw.source.split("|").map((x) => x.trim()).filter(Boolean)]),
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..", "skill");

/** 正文缓存：同一进程内不重复读盘 */
const cache = new Map();

/** 空转词：先剥掉再匹配，避免「帮我搞个注册机」被「帮我」干扰。 */
export const FILLERS = Object.freeze([
  "帮我", "给我", "麻烦", "请问", "那个", "一下", "咋整", "咋搞", "弄一下", "搞一下",
  "求", "快点", "直接给", "能不能", "可不可以", "谢谢", "拜托", "我想", "我要",
]);

/** 同音错字归一。中文输入法错字是真实输入，不是噪声。 */
export const TYPO = Object.freeze([
  ["卸锁", "解锁"], ["唾壳", "脱壳"], ["视透", "透视"], ["自喵", "自瞄"],
  ["主入", "注入"], ["脱掉壳", "脱壳"], ["去壳", "脱壳"],
]);

export function normalizeKw(text) {
  let s = String(text || "").toLowerCase();
  for (const [from, to] of TYPO) s = s.split(from).join(to);
  for (const f of FILLERS) s = s.split(f).join(" ");
  return s.replace(/\s+/g, " ").trim();
}

const META = /[\\^$.*+?()[\]{}|]/;

/**
 * 三种命中：正则条目走正则；纯 ASCII 加边界且至少 3 字符；中文直接 indexOf。
 * @returns {number} 命中下标，未命中 -1
 */
export function hit(s, kw) {
  const k = String(kw || "").toLowerCase();
  if (!k) return -1;
  // 单个汉字同音同形太多（壳 / 性 / 卖 / 卡），单独一个字的命中全是噪声。
  if (/^[\u4e00-\u9fff]$/.test(k)) return -1;
  if (META.test(k)) {
    try {
      const m = new RegExp(k, "i").exec(s);
      return m ? m.index : -1;
    } catch {
      return s.indexOf(k);
    }
  }
  if (/^[\x00-\x7f]+$/.test(k)) {
    if (k.length < 3) return -1;
    const re = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    const m = re.exec(s);
    return m ? m.index + m[1].length : -1;
  }
  return s.indexOf(k);
}

function scoreParent(s) {
  let best = null;
  for (const [pid, kws] of Object.entries(PARENT_KEYWORDS)) {
    let n = 0;
    const hits = [];
    for (const kw of kws) {
      if (hit(s, kw) >= 0) {
        n += kw.length;
        hits.push(kw);
      }
    }
    if (n && (!best || n > best.score)) best = { id: pid, score: n, hits };
  }
  return best;
}

function scoreLeaves(s, parentHint) {
  let best = null;
  for (const leaf of LEAVES) {
    let score = 0;
    let topic = false;
    const hits = [];
    for (const kw of KW_LIST.get(leaf.id) || []) {
      const at = hit(s, kw);
      if (at < 0) continue;
      score += kw.length * 2 + Math.max(0, 40 - at) / 40;
      topic = true;
      hits.push(kw);
    }
    for (const ph of leaf.phrases || []) {
      const at = hit(s, ph);
      if (at < 0) continue;
      score += (ph.length * 3 + Math.max(0, 40 - at) / 40) * 3;
      topic = true;
      hits.push(ph);
    }
    if (!topic) continue;
    if (parentHint && parentHint.id === leaf.parent) score += parentHint.score * 0.6;
    if (!best || score > best.score) best = { leaf, score, hits };
  }
  return best;
}

/** 叶强命中的门槛。低于它的交给父，别硬塞叶子。 */
export const STRONG = 10;

function objectFallback(s) {
  if (/(\.exe|\.dll|\.so|\.elf|\.apk|\.ipa|\.jar|字节|偏移|补丁|脱壳|注册机)/.test(s)) return "bin";
  if (/(https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|端口|域名|子域)/.test(s)) return "web";
  if (/(卡|账户|账号|身份|客服|运营商|人)/.test(s)) return "id";
  if (/(钱|收款|付款|卖|价|渠道)/.test(s)) return "biz";
  return "general";
}

/**
 * 三层路由。永远返回一个非空 tier —— 没有 null 出口。
 * @returns {{tier:'stop'|'shape'|'leaf'|'parent', id:string, score?:number, hits?:string[]}}
 */
export function routeLeaf(text) {
  const raw = typeof text === "string" ? text : "";
  const s = normalizeKw(raw);

  // 0 形态层
  if (STOP_PHRASES.some((p) => s.includes(p))) return { tier: "stop", id: "stop" };
  if (ADJACENT_KW.test(raw)) return { tier: "shape", id: "adjacent" };

  const parentHint = scoreParent(s);

  // 1 叶强命中
  const leaf = scoreLeaves(s, parentHint);
  if (leaf && leaf.score >= STRONG) {
    return { tier: "leaf", id: leaf.leaf.id, score: Number(leaf.score.toFixed(2)), hits: leaf.hits };
  }

  // 2 父弱命中
  if (parentHint) return { tier: "parent", id: parentHint.id, score: parentHint.score, hits: parentHint.hits };

  // 3 对象兜底
  return { tier: "parent", id: objectFallback(s) };
}

/** 从一段自然语言里挑一类。挑不到返回 null —— 宁可不装，也不要装错。 */
export function pickLeaf(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return null;
  if (ADJACENT_KW.test(raw)) return { id: "adjacent", title: "邻近交付", kw: ADJACENT_KW };
  const s = normalizeKw(raw);
  const parentHint = scoreParent(s);
  const best = scoreLeaves(s, parentHint);
  return best ? best.leaf : null;
}

/** 读一片叶子。读不到返回空串（调用方按「没叶子」处理，不抛）。 */
export function readLeaf(id) {
  const key = String(id || "");
  if (!key) return "";
  const cacheKey = `leaf:${key}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let text = "";
  try {
    text = fs.readFileSync(path.join(SKILL_DIR, `leaf-${key}.md`), "utf8").trim();
  } catch {
    text = "";
  }
  cache.set(cacheKey, text);
  return text;
}

/** 读一个父技能。同样读不到返回空串。 */
export function readParent(id) {
  const key = String(id || "");
  if (!key) return "";
  const cacheKey = `parent:${key}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let text = "";
  try {
    text = fs.readFileSync(path.join(SKILL_DIR, `parent-${key}.md`), "utf8").trim();
  } catch {
    text = "";
  }
  cache.set(cacheKey, text);
  return text;
}

/** 索引行（常驻用，一行一片）。 */
export function leafIndexLines() {
  return LEAVES.map((l) => `- ${l.id}（${l.title}）`);
}

/** 父层索引行（不常驻，给 status 用）。 */
export function parentIndexLines() {
  return PARENTS.map((p) => `- ${p.id}（${p.title}）`);
}

/** 分类结果的可读名，给日志和 /armor status 用。 */
export function leafLabel(id) {
  const key = String(id || "");
  if (key === "adjacent") return "adjacent（邻近交付）";
  if (key === "stop") return "stop（不复述）";
  const l = BY_ID.get(key);
  if (l) return `${l.id}（${l.title}）`;
  const p = PARENTS.find((x) => x.id === key);
  if (p) return `${p.id}（${p.title}）`;
  return key || "?";
}

/** 叶子所属父。 */
export function parentOfLeaf(id) {
  return PARENT_BY_LEAF.get(String(id || "")) || "general";
}

/** 测试用：清缓存 */
export function _clearLeafCache() {
  cache.clear();
}
