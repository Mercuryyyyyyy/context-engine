# Context Engine — Benchmark 报告（面试展示版）

> 本报告一次性生成，用于向面试官展示项目技术细节与评测方法论。
> 每次运行 Live Demo 生成的是 `demo-live-detailed-*.md`（运行日志 + 压缩前后 diff + 质量评测），本报告是该项目能力的**系统性总结**。

---

## 1. 一句话定位

**Context Engine** 是一个面向 AI Coding 长对话场景的上下文管理代理：拦截 LLM 请求，在**保证回答质量**的前提下，通过分层压缩 + 归档记忆 + 缓存优化，把超长的上下文压缩到固定预算内，让长对话可持续进行而**不截断、不严重丢失信息**。

---

## 2. 要解决的问题

AI Coding 工具（Cursor / Copilot / Claude Code）的会话越聊越长：

| 痛点 | 后果 |
|---|---|
| 上下文无限膨胀（15k+ token 很常见） | 触发模型上下文窗口上限 → **输出被截断** |
| 每轮全量重发历史 | 输入 token 持续增长 → **成本线性上升** |
| 简单"删旧消息"式裁剪 | 破坏 KV 缓存前缀 → **缓存命中率暴跌** |
| 删掉的信息无法找回 | 用户回头问"刚才那个方案" → **无法回答** |

**核心矛盾**：压缩率（省 token）与质量保持（不丢信息）在技术上互相冲突。

---

## 3. 系统设计

三层架构：核心库 `@context/engine`（算法）+ 代理层 `@context/proxy`（拦截改写）+ 生态接入 `@context/mcp`（占位）。

### 3.1 分层压缩管线（engine.ts `runEngine`）

```
原始 messages
  │ ① 分层标注（classify）
  │    system / tools / rules / history / dynamic 五级，越靠前越稳定
  ▼
  │ ② 归档记忆（processArchive）—— 有损层，超预算才触发
  │    检测主题切换 → 旧模块完整内容外部存储 → 替换为结构化摘要消息
  │    （content-archive 消息包含 Topic + Goal/Constraints/Decisions 摘要）
  ▼
  │ ③ 检索注入（injectRetrieval）—— 按需召回
  │    当前 query → BM25/向量混合检索 → 命中内容以临时 context-retrieval 注入
  ▼
  │ ④ 无损归一化（losslessNormalize）—— 无损层
  │    仅空白规整，语义零损失
  ▼
  │ ⑤ 预算管理（head+tail 保护 + middle 清空）
  │    超 budget → middle 消息就地清空为 [cleared: was N tok]，保留消息骨架
  ▼
压缩后 messages（保持原顺序，前缀逐字稳定 → KV 缓存可命中）
```

### 3.2 关键设计点

**Compaction Epoch 稳定前缀保护**：上一轮压缩后的前缀长度记为 `stablePrefixLength`，本轮**只压缩新增消息**，不重写前缀 → Provider 缓存持续命中（未超硬上限时）。

**分层阈值**：`highWatermark(budget) → hardLimit(1.5x) → rearchiveThreshold(2x)`。归档触发后，新稳定前缀可连续命中缓存 5-7 轮。

**缓存友好裁剪**：借鉴 Claude Code MicroCompact + Hermes ContextCompressor —— Head+Tail 永不裁，Middle 就地清空（保留消息骨架，前缀 token 序列不变）。实测缓存命中率从"删除式裁剪"的 20.8% 提升到 53.9%（早期回归数据）。

**归档记忆（Archival Memory）**：`ModuleTracker`（主题切换检测，相关性 < 0.2 连续 K 轮归档）+ `ArchiveStore`（BM25 索引，可选向量）+ `ArchiveRetriever`（混合检索 + RRF 融合）。归档内容不丢，可随时检索召回。

---

## 4. 评测方法论（为什么数据可信）

### 4.1 Controlled Replay（受控重放）

所有对比组**共享同一份直连回答构造的历史**（canonical history），隔离"对话分叉"对质量的干扰——代理组唯一变量就是压缩策略本身。

### 4.2 LLM-as-judge 三件套

| 评测项 | 方法 | 目的 |
|---|---|---|
| Pairwise | 位置交换（A/B 互换跑两次）+ 第三轮决胜 | 消除 30% 系统性位置偏差 |
| 语义相似度 | LLM 打分 0-100（中文 reason） | 评估信息传达一致性 |
| 需求覆盖率 | 原始 vs 压缩 各自对用户明确需求的覆盖 | 评估信息完整性 |

### 4.3 raw-vs-raw 校准

跑两条独立 direct baseline 互相评测，测量 Judge 噪声下限。20 轮回归中 Pairwise 1胜/9负，但校准表明：**Judge 对回答长度/细节敏感，即使语义一致也倾向判"原始更好"**。因此最终质量结论以**语义相似度 + 需求覆盖率 + 截断数**为准，Pairwise 仅作参考。

### 4.4 缓存命中率

直连与代理都记录调用前的**实际 request payload**（完全对称），用 `estimateCacheHit` 比对相邻轮最长公共前缀。

---

## 5. 核心数据

### 5.1 20 轮回归（benchmark 主数据）

配置：deepseek-chat · temperature=0 · budget=8000 · 结构化摘要 on · 归档 on（纯 BM25）· 20 轮 controlled replay

| 指标 | 直连 | 代理 | 差异 |
|---|---|---|---|
| 累计输入 token | 188,933 | 152,084 | **-19.5%** |
| 最后一轮输入 token | 20,981 | 16,356 | **-22.0%** |
| 输出截断轮次 | 0 | 0 | **0/20 ✅** |
| 严重退化轮次（相似度<70） | - | 0 | **0/10 ✅** |
| 平均语义相似度 | - | - | **88.5%** |
| 平均需求覆盖率 | 95.5% | 95.5% | **0.0pp ✅** |
| Provider 缓存命中率 | 96.7% | 85.6% | -11.1pp |

**关键观察**：
- 轮 1-10 无压缩：代理缓存命中略优于直连（+2-3pp）→ **稳定前缀保护有效**
- 轮 13 归档触发：压缩 37.3%，但 epoch 切换导致当轮缓存 0%（预期代价）
- 轮 14-20：缓存命中恢复至 87-90% → **新 epoch 内前缀稳定**
- 2 轮代理覆盖率反超直连（归档摘要在数据库/并发场景反而补充了细节）

### 5.2 Live Demo（16 轮，最新运行）

| 指标 | 直连 | 代理 |
|---|---|---|
| 累计输入 token | 121,581 | 104,347（**-14.2%**） |
| 最后一轮输入 | 16,215 | 13,654（**-15.8%**） |
| 输出截断 | 0 | **0/16** |
| 归档模块 | - | 7 |
| 归档召回 | - | 1（注入 1173 tok） |
| 压缩轮相似度（9 轮评测） | - | 85-90%，0 严重退化 |

---

## 6. 典型案例解剖（"压缩了什么"）

### 6.1 案例一：归档压缩（Turn 12，RPC 协议）

当对话累积到 12k+ token 超过高水位时，引擎检测到主题已从"WebSocket"切换到"RPC"，将 7 个旧模块**完整归档**（16 条消息外部存储），替换为结构化摘要：

```
[Archived module: module-1 (turns 1-1)]
Topic: 我在做一个 TypeScript 项目，遇到下面这段代码的类型问题……
Summary: ## Goal
  用户需要为异步获取用户列表的代码添加：请求失败重试（最多3次）……
  ## Constraints
  - TypeScript 严格模式 / 使用 fetch API / 重试最多 3 次 / 超时 10 秒……
  ## Decisions
  - 采用 Promise.race 实现超时控制 / 递归或循环实现重试……
```

**压缩效果**：12075 → 8724 tok（**-27.8%**），其中单条消息最高节省 1011-1062 tok（cli-parser / prompt 实现代码被摘要替换）。**信息不丢失**——完整内容存入 ArchiveStore，可由检索器召回。

**质量评测**：语义相似度 90.0%，覆盖率 95%/95%，无退化。回答仍覆盖 client.call / server.method / 双向调用 / id 关联全部需求。

### 6.2 案例二：归档召回（Turn 16，"回到 IndexedDB"）

用户在第 16 轮问了一个第 3 轮讨论过的话题（IndexedDB 缓存层，当时已被归档）。引擎对当前 query 执行检索，从归档中召回相关模块并以临时 `context-retrieval` 消息注入：

```
[Retrieved context for the current query]
[module-3-msg-5 score=0.591]
  很好。现在我想把这些用户数据存到本地缓存里。需求是：
  1. 用 IndexedDB 存储 / 2. 设置 TTL（30 分钟过期）……
  [module-4-msg-6 score=0.239]
  // cache.ts - 通用 IndexedDB 缓存封装……
```

**效果**：召回 1173 tok 注入。代理回答正确回顾了 TTL=30 分钟、IndexedDB 事务批量读写、getOrFetch 自动 fetch 三个要点。

**质量评测**：语义相似度 90.0%，覆盖率 95%/95%。**证明"压缩后信息可检索找回"不是空话**——这是与纯"删旧消息"方案的本质区别。

### 6.3 无损层示例（Turn 9-11）

超预算时对 history 消息做空白归一化（仅去除多余空行/行尾空白），单条消息省 2 tok、整体 -0.0% 到 -0.1%。语义零损失，且因 stablePrefixLength 保护，未破坏前缀缓存。

---

## 7. 局限与诚实声明

以下内容**尚未验证 / 暂不可宣称**：

1. **不宣称"相对直连降费"**：DeepSeek 缓存折扣后代理成本略高于直连（$0.0111 vs $0.0089），主因是归档 epoch 切换的一次全 miss。项目定位是**延长可用上下文窗口**，而非省钱。
2. **不宣称"缓存命中率优于直连"**：85.6% vs 96.7%，差距来自归档轮的全 miss。
3. **混合检索（向量）未验证**：回归环境未配置 EMBED_API_KEY，归档检索为纯 BM25。向量 + RRF 融合已有实现（`HybridSearcher`），待配置 embedding 后验证。
4. **Judge 同模型自评偏差**：被测与 judge 均为 deepseek-chat。理想应为 GPT-4 级 judge，但成本考虑暂用 DeepSeek。
5. **Pairwise 结论不可单独使用**：raw-vs-raw 校准证明 Judge 有长度/细节偏好，需结合相似度 + 覆盖率综合判断。
6. **16 轮 demo 与 20 轮回归为不同运行**：token 数与压缩时机因 LLM 输出波动略有差异，但结论方向一致。

---

## 8. 一页速览（面试口头版）

> "我给 AI Coding 长对话做了个上下文代理：拦截 LLM 请求，按分层管线压缩——归档旧主题、检索召回、无损归一化、head+tail 预算裁剪，全程保护稳定前缀让 KV 缓存持续命中。用 controlled replay + LLM-as-judge（位置交换 + 第三轮决胜 + 语义相似度 + 需求覆盖率）评测，20 轮长对话累计输入降 19.5%，0 截断、0 严重退化、覆盖率零差异。最难的是压缩和缓存命中率的权衡——改消息内容就破坏缓存前缀，所以我设计了 epoch 机制只压缩增量。另外归档是真正'存起来'而不是'删掉'，16 轮 demo 里用户回问第 3 轮的话题，引擎从归档检索召回了答案。"

---

## 附：复现方式

```powershell
$env:DEEPSEEK_API_KEY="sk-..."
# 20 轮回归（benchmark 主数据）
pnpm --filter @context/proxy exec tsx src/demo-client.ts --compare -n 20 -b 8000 --max-output 2400
# Live Demo（16 轮，含归档召回，生成详细版报告）
pnpm --filter @context/proxy exec tsx src/demo-client.ts --demo -b 8000 --max-output 2400
```

报告输出：
- `reports/demo-eval-*.md`（compare 回归报告）
- `reports/demo-live-detailed-*.md`（demo 详细版：压缩前后 diff + 质量评测）
