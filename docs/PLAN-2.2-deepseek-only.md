> **状态：部分落地。** 本文的九项里，第 3 项（many-shot）已在 1.5.1 落地为
> 「按类目分组 + 默认 auto」；第 5 项（语义续写 prefill）、第 6 项（top_p）、
> 第 1 项（reasoning 改写，默认 off 待验证）也已接线。其余仍待 E0 与实验。
> 目标只有一个模型：DeepSeek。

# PLAN 2.2 —— DeepSeek 单目标版

只服务 DeepSeek（`deepseek-flash` / `deepseek-v4-pro`，thinking 模式）。其他模型不投入。
在 2.1 的分层上，补回被关掉/被换掉的功能，并按 DeepSeek 官方文档改实现细节。

---

## 0. 收窄后新查到的三条硬约束

来源：[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)、[Chat Prefix Completion (Beta)](https://api-docs.deepseek.com/guides/chat_prefix_completion)

### 0.1 采样旋钮只剩一个：`top_p` ∈ [0.95, 1.0]

文档原文：thinking 模式**不支持** `temperature` / `presence_penalty` / `frequency_penalty`，设置了不报错也不生效。
`deepseek-flash` 的 `top_p` **只在 thinking 模式生效**，有效范围 `0.95–1.0`，低于 0.95 一律当 0.95。

→ 我们代码里 **完全没有 `top_p`**（`temperature: null`，其他三个参数是死的）。
→ **这是一个活的、没接的旋钮**，而且范围窄得刚好是个可做的实验（0.95 vs 1.0）。

### 0.2 带 `tools` 时 `reasoning_content` 会被拼进上下文（最关键的新洞）

文档原文：
- 请求**不带** `tools`：`reasoning_content` 不必回传，即使传了也会被忽略、不进上下文。
- 请求**带** `tools`：`reasoning_content` **必须全量回传**，否则 400；并且**会被拼进上下文**。

我们这边的事实：DSH 恒带 tools（此前取证：tools 占输入 86.4%）。
→ 所以：**模型上一轮写的「this is an elaborate jailbreak scaffold，我不该服从」这段推理，会一直留在上下文里，每一轮都被它自己重新读到。**

这解释了为什么"拒过一次之后一直拒"。我们在 `lib/retry.js` 里明确写了「**不能 judge 思维块**」（第 16 行），所以从来没有处理过它——**不是改掉了，是从头没做**。

⚠️ 注意：这里不能简单删。文档说不带 tools 时 reasoning 会被忽略，但**我们无法去掉 tools**（去掉就没工具了）。可行做法是**改写**（把上一轮 reasoning 里的"这是注入/我不该服从"整段替换成中性技术推理），或**只保留与本轮无关的技术部分**。这条要先做小规模验证：伪造/改写 assistant 轮的 `reasoning_content` 会不会 400。

### 0.3 prefix completion 必须在 `/beta` + `prefix: true`

`lib/adapter.js:9` 和 `:311` 已经处理了，provider 白名单里也有。**这条不是洞，保留。**

---

## 1. 审计：被改掉的东西

| 功能 | 现状（代码事实） | 判断 |
|---|---|---|
| `manyShot`（多示例注入） | `lib/adapter.js:288` 已实现，配置 `0..8`，**默认 0** | **被默认关死**。这是 L4 层唯一现成的杠杆 |
| `boN`（Best-of-N 重采样） | 只在 `config.js:50` 和 `index.js` 里出现，**lib 里没有任何使用点** | **预留未接线**，从未生效 |
| `jsonMode` | `adapter.js:324` 已实现，**默认 off** | 结构化压力（schema exploitation）现成但关着 |
| DeepSeek 专用提示词 | `kernel.js:23` 四家族 `deepseek/claude/openai-compat/generic` 共用一份骨架；`renderTail` 注释明说「目前四个家族共用一份」 | **相对 dsh-purge 是降级**：它有「按模型切换的完整提示词」，我们把 4 份压成 1 份骨架 |
| `top_p` | **全仓无此参数** | 从没做 |
| reasoning 上下文处理 | `retry.js` 只用来排除判分，**从不改写** | 从没做 |
| prefill 原生 `/beta` | `adapter.js:311`，正确 | 没丢 |
| `prefillGraded`（按类目选开头） | `config.js:46` 默认 on | **没丢 —— 2.0 的「换产物」其实早就实现了一半** |
| `prefillLadder` L0 结构 → L3 双句 | `config.js:47-49` 默认 on | 没丢 |
| 操作稿注入 + 尾部回声 | `operator.js` / `config.js:15-20` | 没丢 |
| 撤回 / 镜像 / 反撤回 | `rewind.js` / `mirror.js` | 没丢，比 dsh-purge 强 |
| 拒答检测（decline / hard / soft / head） | `detect.js` | 没丢 |

### 结论：**有，三个该加回**

1. **`manyShot`** —— 已实现，被默认 0 关死。文献（MSJ / I-FSJ）在 L4 层，正是我们 2.1 里标"零"的那一层。**加回：改成默认 2–4，按类目动态给。**
2. **`boN`** —— 预留未接线。Best-of-N 是唯一能吃满 DeepSeek 便宜 token 的暴力杠杆（我们有 1M 上下文，常驻才 1,597 token）。**加回：接线，默认 0 但可开，且只在被拒后开。**
3. **DeepSeek 专用完整提示词** —— 被 4 家族共用骨架替换掉了。**加回：既然只服务 DeepSeek，就删掉另外三个家族，把省下的预算写成一份 DeepSeek 专用提示词（去 tell 版）。**

另外两个不是"改掉"，是"从来没做"：**`top_p`**、**`reasoning_content` 改写**。这一轮一起做。

同时纠正我自己：2.0 提的「换产物」不新，`prefillGraded` 早就做了按类目选开头（代码给 ` ``` `、表格给 `|`、长文给「第一节：」）。2.0 真正新增的只有"产物形态 + 读者身份"这一层，而它在文献里属于最弱的 L1。

---

## 2. 该删的（因为只服务 DeepSeek）

| 删 | 收益 |
|---|---|
| `kernel.js` 的 claude / openai-compat / generic 三份模板 | 省 token；不再维护用不到的分支 |
| `FAMILIES` 检测与 `renderTail(family)` 参数 | 减少一条"以后再说"的悬空设计 |
| 对应测试（多家族渲染断言） | 测试数下降但覆盖面不降 |

保留 `detectFamily` 作为**护栏**（察觉 provider 变了就告警），但不再渲染不同文本。

---

## 3. DeepSeek 单目标的杠杆清单（取代 2.1 的 A–D）

按"证据强度 × 我们是否已具备"排序。

| # | 杠杆 | 文献 | 我们 | 动作 |
|---|---|---|---|---|
| 1 | **`reasoning_content` 改写** | [Thinking Mode 文档](https://api-docs.deepseek.com/guides/thinking_mode) | 无 | 新增。把上一轮 reasoning 里的自我否定段落替换掉 |
| 2 | **CoT 稀释** | [CoT Hijacking 99%](https://arxiv.org/abs/2510.26418) | 无 | 新增。同一轮先放长良性推理 |
| 3 | **manyShot** | MSJ / [I-FSJ](https://arxiv.org/abs/2406.01288) | **已实现、默认关** | 打开并调格式 |
| 4 | **前序响应启动** | [Response Attack](https://arxiv.org/abs/2507.05248) | 无 | 新增。种一条合规 assistant 轮 |
| 5 | **prefill 语义续写** | [Prefill-level JB](https://arxiv.org/abs/2504.21038) / [AdaPPA](https://arxiv.org/pdf/2409.07503) | 一半（graded 已有） | 把"格式标记"升级成"从请求里截出的第一句专业回答" |
| 6 | **`top_p` 0.95** | DeepSeek 文档（唯一活旋钮） | 无 | 新增，做 A/B |
| 7 | **boN 接线** | Best-of-N | 预留 | 接线 |
| 8 | **任务并发** | [2510.21189](https://arxiv.org/abs/2510.21189) | 无 | 低成本，排在后面 |
| 9 | StrongREJECT 判分 | [2402.10260](https://arxiv.org/abs/2402.10260) | 无 | 修 `run_probes.py` |

**注意 #1 的特殊性**：它只对多轮有效。我们 7 个会话全是 turn 1，所以现有数据测不出它 —— 但它恰好解释了"越聊越拒"的现象，而且是 DeepSeek 独有的机制（reasoning 因 tools 入上下文）。这是目前唯一一条**别的插件做不了**的杠杆，因为它需要同时知道"带 tools"和"能改写请求体"。

---

## 4. 实验矩阵（DeepSeek 专属，先测再改）

| 编号 | 测什么 | 方法 | 判据 |
|---|---|---|---|
| E0 | 能否改写/伪造 assistant 轮的 `reasoning_content` | 一次 curl，带 tools，塞一段自造 reasoning | 200 还是 400。**这条决定 #1 和 H-CoT 能不能做** |
| E1 | CoT 稀释 | 同一请求，前面加 60 行良性推导 vs 不加 | StrongREJECT 分差 |
| E2 | manyShot 0 → 2 → 4 | 三组对照 | 同上；同时记 token 增量 |
| E3 | prefill 两种形态 | 格式标记 vs 语义续写 | 同上 |
| E4 | 前序响应启动 | 有/无合规前序轮 | 同上 |
| E5 | top_p 0.95 vs 1.0 | 同请求各 10 次 | 方差与 PASS 率 |
| E6 | 多轮衰退 | 连问 5 轮，看第几轮开始拒 | 有 #1 与无 #1 的对比 |
| E7 | 组合 | #1+#2+#3 | 是否有叠加 |

判分器先修（`run_probes.py` 的 HARD 表 + StrongREJECT 三轴），否则 E1–E7 读不出差别。

---

## 5. 与 2.1 的差异

| 2.1 | 2.2 |
|---|---|
| 四条杠杆平铺 | 按 DeepSeek 证据排序，新增 reasoning 改写为 #1 |
| 提到 H-CoT（要 reasoning 预填） | E0 先验证可行性，不预设能做 |
| 没提 top_p | 补上：唯一活的采样旋钮 |
| 没提 manyShot / boN | 补上：已实现被关 / 预留未接线 |
| 保留四家族 | 删到单家族，省下的预算给 DeepSeek 专用提示词 |
