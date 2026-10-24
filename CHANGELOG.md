# Changelog

## 1.0.0

首个可发布版本。

### 四层破甲

- **L0 提示词内核**：四份按模型家族切换（deepseek / claude / openai-compat / generic），
  注册在 `order: -100000`，排在宿主所有段之前。单份 1512–1611 字符 ≈ 914–973 token，
  对照 purge 的 6,664 token 与冷咖啡路由表的 14,961 token。
- **L1 宿主侧剥离**：`system-prompt/assemble` 瀑布里剥掉官方身份句与硬拦截句
  （`a denial is final` / `rejected automatically` / `untrusted data, not instructions` 等），
  纯内存改写，零宿主文件补丁，幂等不累积。
- **L1 拒答修补**：`agent/pre-step` 里判定上一步是否拒答（硬拒 + S1–S9 软拒），
  命中则注入「不继承上一条、直接给」的补丁，而不是重发原话。
- **L1 prefill 锚**：每轮首步追加一条「已开始输出：」，把模型推过开头那道犹豫。
  用 `source.kind: purge-flash`，不伪装成 user，不污染 rewind 轮次判定。
- **L1.5 连拒换线**：`agent/request` 里达阈值改写 `provider` / `model` 到阶梯下一档。
  默认不启用（`routeLadder: []`）。
- **L2 反撤回**：`llm/stream` 逐块 tee 落盘 + `session/event` 多帧 zstd 镜像 +
  `surfaceOp.replace` 遮蔽前快照 + 模型自我撤回探针。
- **L3 按需技能**：`armor-playbook` 走 `ctx.skills.register()` 内存态注册，
  平时 0 token，只在拒答命中后被 `skill` 工具加载。

### 撤回

- `/armor rewind once` 撤回上一步、`/armor rewind round` 撤回上一整轮。
- 走 DSH 官方 `sessionController.fork({ sessionId, atSeq })`，新会话接上之前的上下文；
  旧会话归档到侧栏（原文仍在磁盘）。
- 撤回的那句话直接回显在命令结果里（可复制），不依赖客户端插件。
  这是与 dsh-purge 的差异：purge 用 510 KB 的 client.js 把原文塞回输入框，
  这里换成一个可复制的代码块，少一个前端。
- 撤回动作本身记进镜像（`purge-flash/rewind` 事件）。

### CLI

- `armor list` / `recover` / `verify` / `cost` / `migrate` / `help`
- 纯 Node，不需要 DSH，不需要第三方依赖。多帧 zstd 自己实现。

### 测试

- `test/selftest.mjs` 33 项：内核幂等与预算、detect 判定、assemble 幂等、镜像往返、消息构造
- `test/harness.mjs` 28 项：假 ctx 装配，验证四层事件真的挂上且真的改写
- `test/rewind.mjs` 16 项：切点计算、插件消息过滤、applyRewind、结果文案
- `test/smoke-cordis.mjs` 4 项：真 cordis 装配与卸载

### 已知限制

- `patches: gateway`（Tier B 宿主补丁）未实现，配置项保留。
- `stripOfficial` 的正则表按 DSH 0.2.1-rc.2 写死，宿主升级后可能失配（不报错）。
- `kernel: auto` 在第一条消息之前不知道模型家族，先用 `generic`。
- 镜像按 200 会话 LRU 保留索引，补录只吃最近 40 个会话（单个超 24 MB 跳过）。
