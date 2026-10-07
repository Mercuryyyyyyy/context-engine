# Context 项目状态文档

## 2026-08-13 实用性改进（相关性裁剪 + 提示保留 + token 级缓存预估 + 评测可信度）

本轮围绕「提高实用性」做了三项核心算法改进 + 一项评测改进，均通过离线测试与 typecheck：

1. **相关性感知 clear-middle + 关键词 hint 保留**（[engine.ts](packages/context-engine/src/engine.ts)）
   - 中间消息不再按索引顺序清空，而是按「与当前 query 相关性最低优先」排序后再清空（借鉴 Lost-in-the-Middle：模型对中间信息注意力最弱，应优先保留相关上下文）。
   - 被清空消息从 `[cleared: was N tok]` 改为 `[cleared: was N tok | hint: k1, k2, ...]`，用极少的 token 保留一组关键词作为「语义脚手架」，在相同预算下减少信息损失、提升压缩后回答准确性。
   - 兼容旧格式：`startsWith('[cleared:')` 检测与测试均不受影响。

2. **Token 级缓存命中预估**（[cache.ts](packages/context-engine/src/cache.ts) + [tokenize.ts](packages/context-engine/src/tokenize.ts)）
   - 原来 `estimateCacheHit` 是消息粒度，遇到第一条不同消息就整体判 miss；现在在首条不同消息上继续做 token 级最长公共前缀匹配，能捕获「同位置消息被部分追加」的前缀命中，提升缓存命中预测精度。
   - 新增 `encodeTokens()` 导出，`messageTokenIds()` 将消息序列化为 token id 用于前缀匹配。

3. **LLM-as-judge 评测可信度提升**（[demo-client.ts](packages/context-proxy/src/demo-client.ts)）
   - 依据 LLM-as-judge 研究（EvidentlyAI / MT-Bench / JudgeBench）：将原来的「一次调用同时打相似度 + 覆盖率」拆分为两个独立评测（`judgeSimilarity` + `judgeCoverage`），避免多维度相互干扰。
   - 增加评分锚点（rubric）、先给理由再打分（CoT）、显式抑制冗长/格式偏好，并以原始回答为 reference 做 grounded 相似度评分。
   - Pairwise judge 增加 correctness/completeness 评价标准 + 反冗长偏好指令。

4. **diff 展示适配**：`diffMessages` 对清空式裁剪的识别从精确匹配 `[cleared: was N tok]` 放宽为 `startsWith('[cleared:')`，适配带 hint 的新格式。

> 验证：`pnpm typecheck` 通过；`pnpm --filter @context/engine test` 全部通过；`pnpm --filter @context/engine build` 成功。

## 2026-07-22 归档系统 + 真实代理集成 + Live Demo

- 新增 **Archival Memory 系统**（`ModuleTracker` + `ArchiveStore` + `ArchiveRetriever`）：
  - `ModuleTracker`：主题切换检测（相关性 < 0.2 连续 K 轮）+ 模块生命周期管理，支持 LLM 摘要归档
  - `ArchiveStore`：完整消息归档 + BM25 索引（可选向量索引，无 embedFn 时退化为纯 BM25）
  - `ArchiveRetriever`：混合检索（BM25 + 向量 + RRF），结果以 `context-retrieval` 临时消息注入（不进持久前缀）
- **Compaction Epoch 稳定前缀保护**：`stablePrefixLength` 保护上一轮压缩后的前缀不被再次压缩；归档/检索阈值提高到 `hardLimit * 2`，提供 5-7 轮稳定缓存窗口
- **分层压缩阈值**：`highWatermark(budget)` → `hardLimit(1.5x)` → `rearchiveThreshold(2x)`
- **P0-1 修复**：真实 HTTP 代理 Anthropic `/v1/messages` 端点接入归档系统（[server.ts](packages/context-proxy/src/server.ts)），CLI 新增 `--archive` / `--archive-delay` / `--archive-topic-threshold` / `--embed-*` 参数
- **20 轮回归**（`reports/demo-eval-2026-07-22T14-15-20.md`，⚠️ 经 2026-10-07 查证该报告同样不存在，下列数字仅供历史参考）：
  - 累计输入 188,933 → 152,084（**-19.5%**），最后一轮 -22.0%
  - 输出截断 **0/20**，严重退化 **0/10**，平均语义相似度 **88.5%**，需求覆盖率差 **0.0pp**
  - Pairwise 1胜/9负，但 raw-vs-raw 校准表明 Judge 存在"回答长度/细节"偏好，综合质量以相似度 + 覆盖率为准
- **Live Demo 模式**（`demo-client.ts --demo`）：单终端 ANSI 左右分屏，16 轮实时展示（左：对话进度，右：代理日志），含归档触发（Turn 13，压缩 37.3%）与归档召回（Turn 16，`forceRetrieval` 注入 1099 tok）
  - 结果：节省 15.0%，截断 0/16，归档 8 模块，召回 1 次，0 严重退化
- **最终 Benchmark 报告**：`reports/BENCHMARK_FINAL.md`（面试展示用，非每次运行生成），含核心指标汇总表 + 逐轮压缩策略与缓存命中 + Pairwise 逐轮详情 + raw-vs-raw 校准方法论

## 2026-07-15 上下文策略与评测重构

本轮针对“压缩率、质量、缓存命中率无法同时稳定”的问题完成了以下修改：

- 将原“可逆压缩”拆分为默认无损归一化与显式有损 `semantic fold`。代码、JSON、URL、长行折叠默认关闭。
- `semantic fold` 仅在超预算时作用于低相关旧 history；system、rules、当前 query 和近期 history 受保护。
- 新增 compaction epoch：代理复用上一轮持久化压缩前缀，只处理新追加消息；历史被编辑时开启新 epoch。
- 检索结果作为当前 query 的临时上下文，不进入下一轮持久前缀。
- `runEngine` 新增 query-aware retrieval hook，可接入 `HybridSearcher` 或其他检索器。
- demo 在超预算时使用 TF-IDF 对历史问答归档检索，展示真实的检索注入链路。
- compare 默认改为 controlled replay，代理使用直连回答构造固定历史，隔离压缩策略影响；`--rollout` 保留端到端分叉评测。
- 直连与代理都保存调用前的实际 request payload，缓存命中率现在使用完全对称的数据计算。
- 质量报告新增 Pairwise 胜/平/负和“语义相似度 < 70”的严重退化轮次，不再仅用离散的 0%/100% 准确率描述质量。
- benchmark 改为调用真实 `runEngine`，并明确 token 数据不等于质量结论。
- 新增策略安全测试，PageRank focus 权重修复，所有离线测试通过。

新的建议评测方式：20 轮以上、原始输入达到 15k+ token 后，再比较 4k/8k/12k 预算；默认关闭 semantic fold，分别运行 controlled replay 与 rollout。

### 2026-07-18 长上下文真实回归

> ⚠️ **2026-10-07 全盘查证更正**：本段引用的报告 `reports/demo-eval-2026-07-18T04-12-29.md` 经 git 全历史 + Context.zip + 原始基线目录交叉查证**从未以文件形式存在**，下列数字（46.6% / 65.4% / 87.8% / -5.3pp / 0-18）不可溯源，**已作废**。
>
> 替代数据来自 2026-10-07 用当前代码（rotation 经济性门槛 + 自动硬约束 + 串行 Judge + 需求逐条核对 + 两次不一致判平）重跑的 20 轮受控回放，报告：`reports/_rerun-20t-baseline-20261007/demo-eval-2026-10-07T07-41-45.md`，可追溯、可复现：
> - 累计输入 234031 → 139765（**-40.3%**）；末轮 27327 → 11298（**-58.7%**）
> - 相似度 85.6%；需求覆盖率 0.0pp（100%→100%，零差异）；非劣率 90.0%（胜/平/负 2/7/1）
> - 严重退化 0/10 有效（10 压缩轮）；输出截断 0/20
> - 缓存命中：本地预估 直连 79.3% / 代理 67.7%；DeepSeek 真实 直连 98.3% / 代理 80.7%
>
> 以下为当时的原始工作记录，**数字仅供历史参考，不代表当前可追溯结论**。

最终配置：DeepSeek `deepseek-chat`，20 轮 controlled replay，budget=8000，结构化摘要开启，semantic fold 关闭，回答上限 2200。

- 直连最后一轮输入：19672 token；代理：6800 token；最后一轮节省 65.4%。
- 累计输入：180602 → 96511 token，节省 46.6%。
- 平均语义相似度：87.8%，严重退化轮次 0/18。
- 平均需求覆盖率：直连 95.6%，代理 90.3%，差值 -5.3pp。
- 输出截断：0/20。
- 本地前缀估算：直连 80.4%，代理 56.8%。
- DeepSeek Provider 实际缓存：直连 97.9%，代理 45.9%。
- No-op raw-vs-raw 校准有效样本平均相似度 95%，且 Judge 仍强制偏好其中一侧，说明 Pairwise 存在明显噪声，不能单独作为正确率。

报告：`reports/demo-eval-2026-07-18T04-12-29.md`。

当前主要剩余问题：摘要/检索 compaction 会重置 Provider 前缀缓存；纯关键词检索对跨主题长对话仍存在误命中，后续应增加 topic gate、向量相似度或只检索已被摘要移除且与当前 query 高相关的内容。

> 本文档记录项目已完成的工作、应用的技术、实现的功能及各模块位置，用于对话压缩后快速恢复上下文。

## 一、项目定位

**Context** 是一个面向 AI Coding 场景的上下文管理工具，通过 HTTP 代理层拦截 LLM 请求，对 messages 进行检索、压缩、缓存优化，在保证回答质量的前提下显著降低 token 消耗与成本。

**历史数据（策略重构前，budget=1500；仅用于回归对照，不再作为当前质量结论）**：

- Token 节省率：37.9%（累计输入），最后一轮 56.9%
- 平均缓存命中率：直连 68.1% vs 代理 **53.9%**（Head+Tail 保护 + Middle 就地清空后）
- 平均语义相似度：67.0%（budget=1500 时；budget=2000 时应更高）
- **缓存命中修复**：旧版"删除式裁剪"缓存命中仅 20.8%，新版"清空式裁剪"提升至 53.9%

**关键修复**：缓存友好裁剪策略（Head+Tail 保护 + Middle 就地清空），借鉴 Claude Code MicroCompact + Hermes ContextCompressor

**DeepSeek API Key**（用于真实 LLM 测试，仅存于本地环境变量 `DEEPSEEK_API_KEY`，不入库）

## 二、项目结构

```
f:\Context\
├── DESIGN.md                    # 设计文档（架构、模块、路线图）
├── PROJECT_STATUS.md            # 本文档
├── package.json                 # monorepo 根配置
├── pnpm-workspace.yaml          # pnpm workspace 配置
├── tsconfig.base.json           # 共享 tsconfig
├── reports/                     # 评测报告输出目录（统一保存路径，避免 pnpm exec cwd 问题）
│   ├── accuracy-eval-*.md       # 单轮独立用例准确率评测报告
│   └── demo-eval-*.md           # 多轮对话评测报告（demo-client compare 模式生成）
└── packages/
    ├── context-engine/          # 核心库（算法实现）
    │   ├── src/
    │   │   ├── types.ts         # 核心类型定义
    │   │   ├── tokenize.ts      # token 计数
    │   │   ├── cache.ts         # 缓存命中预估
    │   │   ├── engine.ts        # 主引擎（分层→压缩→摘要→预算→统计）
    │   │   ├── anthropic.ts     # Anthropic 格式互转 + cache_control
    │   │   ├── index.ts         # 统一导出
    │   │   ├── compress/
    │   │   │   ├── reversible.ts   # 可逆压缩（P0基础 + P2进阶）
    │   │   │   └── summarize.ts    # LLM 摘要压缩
    │   │   ├── retrieve/
    │   │   │   ├── repo-map.ts       # tree-sitter repo map
    │   │   │   ├── pagerank.ts       # PageRank 算法
    │   │   │   ├── embedder.ts       # 向量 embedding
    │   │   │   ├── vector-store.ts   # 向量存储
    │   │   │   ├── keyword-search.ts # TF-IDF 关键词检索
    │   │   │   ├── hybrid-search.ts  # RRF 融合算法
    │   │   │   ├── hybrid-searcher.ts # 混合检索统一接口
    │   │   │   ├── module-tracker.ts # 模块跟踪（主题切换检测 + 生命周期）
    │   │   │   ├── archive-store.ts  # 归档存储（完整消息 + BM25/向量索引）
    │   │   │   └── archive-retriever.ts # 归档检索器（混合检索统一入口）
    │   │   └── __test__/
    │   │       ├── engine-summarize.test.ts
    │   │       ├── anthropic.test.ts
    │   │       ├── repo-map.test.ts
    │   │       ├── pagerank.test.ts
    │   │       ├── hybrid-search.test.ts
    │   │       ├── reversible-advanced.test.ts
    │   │       ├── benchmark.ts        # benchmark 脚本
    │   │       └── accuracy-eval.ts    # 准确率评测脚本
    │   └── package.json
    ├── context-proxy/           # HTTP 代理
    │   ├── src/
    │   │   ├── server.ts        # Hono server + 路由 + 日志
    │   │   ├── index.ts         # CLI 入口
    │   │   └── demo-client.ts   # demo 对话脚本
    │   └── package.json
    └── context-mcp/             # MCP server（search_archive）
        ├── src/
        │   └── index.ts         # 占位
        └── package.json
```

## 三、三层架构

| 层    | 包名                | 形态                | 职责                         |
| ---- | ----------------- | ----------------- | -------------------------- |
| 核心库  | `@context/engine` | npm 包             | 核心算法：检索 / 压缩 / 缓存 / 预算     |
| 代理层  | `@context/proxy`  | CLI + HTTP server | 拦截并改写 messages，转发到 LLM API |
| 生态接入 | `@context/mcp`    | MCP server            | 通过 `search_archive` 暴露 ArchiveStore 检索 |

## 四、已实现功能详解

### 4.1 核心库 context-engine

#### 4.1.1 类型系统（types.ts）

- `Message`：兼容 OpenAI 格式
- `ContextTier`：5 级分层（system / tools / rules / history / dynamic）
- `ContextBlock`：分层后的上下文块
- `EngineInput` / `EngineOutput`：引擎输入输出
- `EngineStats`：统计信息（originalTokens / optimizedTokens / cacheHitRate / strategies）

#### 4.1.2 Token 计数（tokenize.ts）

- 基于 `js-tiktoken` 的 `cl100k_base` 编码
- `countTokens(text)`：单文本 token 计数
- `countMessageTokens(msg)`：单条消息 token 计数
- `countMessagesTokens(msgs)`：多消息 token 计数

#### 4.1.3 缓存命中预估（cache.ts）

- `estimateCacheHit(current, previous)`：对比上一轮 messages，找最长公共前缀
- 返回 `{ hitTokens, hitRate, firstDiffIndex }`
- 算法：逐条对比 message，找到第一条不同的，命中 token = 前缀所有 message 的 token 之和

#### 4.1.4 可逆压缩（compress/reversible.ts）— P0 + P2

**P0 基础手法**（4 种）：

1. `trimTrailingWhitespace`：规整行尾空白
2. `collapseBlankLines`：连续 3+ 空行 → 2 空行
3. `foldLongLines`：超长单行（>500 chars）→ `<folded:N chars>`
4. `collapseRepeatedLines`：连续重复行（≥4 次）→ `[repeated N more times]`

**P2 进阶手法**（5 种）：
5. `foldUrlsAndPaths`：长 URL / 文件路径 → `<url:domain.../N chars>`
6. `foldCommentBlocks`：多行注释 / 连续单行注释 → 单行摘要
7. `foldJsonStructures`：长 JSON / 对象 → `<json-array:N items, keys:...>`
8. `foldCodeBlocks`：长函数体 → 保留签名 + `<folded:N chars>`
9. `deduplicateChunks`：重复长行 → `<dup:ref to line N, M chars>`

**关键设计**：URL 折叠在 `foldLongLines` 之前执行，避免 URL 被通用折叠吃掉

**接口**：

```typescript
interface ReversibleOptions {
  enableAdvanced?: boolean;      // 默认 true
  codeBlockThreshold?: number;   // 默认 300
  jsonThreshold?: number;        // 默认 200
  dedupThreshold?: number;       // 默认 100
}
function reversibleCompress(text: string, options?: ReversibleOptions): ReversibleResult
```

#### 4.1.5 LLM 摘要压缩（compress/summarize.ts）

- `SummarizerFn`：可注入的摘要函数接口
- `createDefaultSummarizer(config)`：默认实现，调 OpenAI 兼容 API
- `summarizeMessages(messages, fn)`：对老历史做摘要
- `buildSummaryMessage(summary)`：构造摘要消息（system 角色）
- 支持配置：model / apiKey / baseURL / targetRatio

#### 4.1.6 Anthropic 格式支持（anthropic.ts）

- `anthropicToMessages(body)`：Anthropic 请求体 → OpenAI messages
- `messagesToAnthropic(messages, system)`：OpenAI messages → Anthropic 请求体
- `insertCacheBreakpoints(messages, maxBreakpoints)`：自动插入 `cache_control` 断点（最多 4 个）
- 断点策略：system 末尾 + tools 末尾 + history 末尾 + dynamic 末尾

#### 4.1.7 主引擎（engine.ts）

`runEngine(input: EngineInput): Promise<EngineOutput>` 流程：

1. **分层标注**：classifyMessage 给每条 message 打 tier 标签
2. **可逆压缩**：对所有字符串 content 做 reversibleCompress
3. **预算管理**：
   - 3a. 若超预算且有 summarizer，对老 history 做摘要压缩
   - 3b. **Head+Tail 保护 + Middle 就地清空**（缓存友好裁剪，借鉴 Claude Code MicroCompact + Hermes）：
     - **分段**：head（system + 前 2 条 history，永不裁）+ tail（最近 4 条 history + dynamic，永不裁）+ middle（head 和 tail 之间）
     - **第一级 clear-middle**：middle 消息 content → `[cleared: was N tok]`，保留消息骨架，前缀 token 序列不变
     - **第二级 clear-tail**：清空 tail 中较老的消息（保留最后 2 条），仍保持消息骨架
     - **第三级 drop-overflow**：清空后仍超预算，才删除消息（先删 middle，再删 tail 中已清空的）
4. **保持原顺序输出**
5. **缓存命中预估**：对比 previousMessages

**Tier 优先级**（数字越大越优先保留）：

- system: 5（不裁）
- tools: 4（不裁）
- rules: 3
- history: 2
- dynamic: 1（不裁，当前查询）

**缓存友好设计**：

- 旧版（删除式）：直接 `annotated[idx].dropped = true`，删除消息后前缀断裂，缓存命中 ~20%
- 新版（清空式）：`content → [cleared: was N tok]`，保留消息骨架，缓存命中 ~54%
- 关键原理：KV Cache 要求从第 0 个 token 开始字节级一致，清空只改内容不改消息结构，前缀 token 序列（消息边界、role 标记）不变

#### 4.1.8 检索层 — repo map（retrieve/repo-map.ts）

- 基于 `web-tree-sitter`（WASM 跨平台）
- 支持 TypeScript / TSX / JavaScript 三种语言
- 用 tree-sitter Query API 提取符号定义（class / interface / function / method / type / enum）和引用（call / new / type）
- `buildRepoMap(rootDir, options)`：生成树状 repo map
- 支持 `maxTokens` 预算控制、`focusFiles` 个性化向量加权、`disablePageRank` 退回字母序

**关键实现细节**：

- 用 `createRequire(import.meta.url)` 解决 ESM 下 require.resolve 问题
- `ensureInit()` 确保 Parser.init() 在 Language.load() 之前调用
- `walkDir` 用 try-catch 包裹 readdir，目录不存在不抛异常
- 用 `query.matches()` 替代 `query.captures()`（captures 顺序不保证，matches 内 captures 成对）

#### 4.1.9 检索层 — PageRank（retrieve/pagerank.ts）

- `computePageRank(edges, nodes, options)`：标准 PageRank 算法
- `buildGraphFromSymbols(defMap, fileRefs)`：从符号定义和引用构建文件级有向图
- 边的定义：引用文件 → 定义文件
- 支持个性化向量（focusFiles 加权）、阻尼因子（默认 0.85）、收敛阈值（默认 1e-6）
- 最大迭代 100 次

#### 4.1.10 检索层 — 向量检索（retrieve/embedder.ts + vector-store.ts）

- `createEmbedder(config)`：OpenAI 兼容 API embedding
- `cosineSimilarity(a, b)`：余弦相似度
- `embedBatch(texts, fn)`：批量 embedding
- `VectorStore` 类：内存向量存储 + 暴力搜索
  - `add(text, embedding)` / `addBatch(docs)` / `search(query, k)` / `searchByEmbedding(emb, k)`

#### 4.1.11 检索层 — 关键词检索（retrieve/keyword-search.ts）

- `KeywordIndex` 类：零依赖 TF-IDF 实现
- 自定义分词：英文单词 + 中文双字符滑窗 + 驼峰分割
- 停用词过滤
- `add(doc)` / `search(query, k)`

#### 4.1.12 检索层 — 混合检索（retrieve/hybrid-search.ts + hybrid-searcher.ts）

- `reciprocalRankFusion(rankings, k)`：RRF 融合算法（k=60）
- `fuseResults(vectorResults, keywordResults, k)`：便捷函数
- `HybridSearcher` 类：统一向量 + 关键词 + RRF 融合接口
  - `index(entries)` / `search(query, k, options)`

### 4.2 代理层 context-proxy

#### 4.2.1 HTTP 服务器（server.ts）

- 基于 `Hono` + `@hono/node-server`
- **路由**：
  - `POST /v1/chat/completions`：OpenAI 格式，调 engine 改写后转发
  - `POST /v1/messages`：Anthropic 格式，转 OpenAI 改写后转回 Anthropic 转发
  - `GET /healthz`：健康检查
- **会话存储**：`sessionStore`（Map），按 auth 头哈希存上一轮 messages，用于缓存命中预估
- **累计统计**：`cumulative` 对象，进程生命周期内统计 totalRequests / totalSavedTokens / totalSavedCost

#### 4.2.2 日志增强（server.ts formatStats）

- ANSI 彩色输出
- `cache_hit` 状态颜色区分：绿色（hit）/ 黄色（partial）/ 红色（miss）
- 成本估算：`saved: $0.0002 saved`（按模型定价）
- 累计统计：`cumulative: 6 reqs, 4924 tok saved (62.6%), $0.0009`
- 模型定价表：deepseek-chat / deepseek-reasoner / gpt-4o / gpt-4o-mini / claude-3-5-sonnet / claude-3-5-haiku

#### 4.2.3 CLI 入口（index.ts）

- 参数解析：`-p` / `-u` / `--anthropic-upstream` / `-b` / `--no-reversible` / `--summarize` / `--summarize-keep` / `-q`
- 环境变量：`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `OPENAI_API_KEY` / `SUMMARIZER_API_KEY`
- 启动 banner：显示 port / upstream / anthropic / budget / reversible / summarize 状态

#### 4.2.4 Demo 对话脚本（demo-client.ts）— **P3 重构版**

**重大变更**：代理模式从"走 HTTP proxy"改为"本地 engine 处理"，这样可以：

- 记录压缩后的具体 messages 内容
- 计算逐轮缓存命中率（前缀一致率）
- 对每一轮做 LLM-as-judge 评测

**三种模式**：

- `--direct`：直连 DeepSeek（原始 token 消耗基线）
- `--proxy`：本地 engine 处理（budget 控制，压缩 + 预算管理）
- `--compare`：同时跑直连和代理 + 逐轮 LLM-as-judge 评测 + 生成评测报告

**参数**：

- `-n` / `--turns`：对话轮数（默认 20，demo 用 6）
- `-b` / `--budget`：token 预算（默认 800，建议 1500-2000）
- `-v` / `--verbose`：实时输出每轮对话详情

**对话内容**：内置 20 轮真实编程问题（TypeScript 类型、异步重试、IndexedDB、观察者模式、CLI 解析、交互式提示、Zustand selector、i18n、性能优化、虚拟滚动、WebSocket、RPC 协议、Postgres 索引、乐观锁 CRDT、Vitest 迁移、e2e 测试、CI/CD、preview 部署、安全防护、可观测性）

**compare 模式流程**：

1. 直连跑 N 轮，记录每轮 messages / 输入输出 token / 回答
2. 代理跑 N 轮，每轮用 `runEngine` 本地处理，记录压缩后 messages / engineStats
3. 逐轮 LLM-as-judge 评测（仅对有压缩的轮次）：
   - Pairwise + 位置交换（`judgeSymmetric`）
   - 第三轮决胜（`judgeCall` with `forceChoice=true`）
   - 语义相似度（`judgeSimilarity`，LLM 打 0-100 分，中文 reason）
4. 缓存命中率计算（`computeCacheHit`，用 `estimateCacheHit` 比对相邻轮 messages）
5. 生成评测报告

**报告格式**（顺序展示，不分栏）：

```
## 轮次 N
### 问题（代码块）
### 输入 token（直连 X vs 代理 Y，压缩率 Z%，压缩策略列表）
### 缓存命中率（直连 A% vs 代理 B%，仅第 2 轮起）
### 代理实际输入内容（<details> 折叠，点击展开 JSON 格式的压缩后 messages）
### 直连回答（代码块）
### 代理回答（代码块）
### 评测（Judge 结论 + 语义相似度 + 中文 reason）
---
```

**无压缩轮次**：直接显示 `> 当前没有压缩，两者一致`，跳过详细对比

**报告汇总表**：累计输入 token / 最后一轮输入 / 准确率保持率 / 平均语义相似度 / 平均缓存命中率

**报告保存**：`f:\Context\reports\demo-eval-{timestamp}.md`

**--demo 模式（Live Demo 左右分屏）**：

- 单终端 ANSI 左右分屏（左：对话进度，右：代理日志），16 轮实时展示
- 步骤 1 先跑直连 baseline 收集 canonical history（controlled replay），步骤 2 跑代理分屏
- 关键看点：Turn 13 归档触发（压缩 37.3%）、Turn 16 归档召回（`forceRetrieval` 强制注入 1099 tok）
- 末尾汇总 + 保存报告：`f:\Context\reports\demo-live-{timestamp}.md`
- 运行：`pnpm --filter @context/proxy exec tsx src/demo-client.ts --demo -b 8000 --max-output 2400`

### 4.3 评测脚本

#### 4.3.1 Benchmark（__test__/benchmark.ts）

- 量化效果：token 节省、缓存命中率、压缩率
- 测试场景：模拟对话、代码片段、长文档
- 输出：综合统计 + 每场景明细

#### 4.3.2 单轮准确率评测（__test__/accuracy-eval.ts）— **已修复**

- **定位**：单轮独立用例基准测试（类似 unit test），不是多轮对话场景
- **被测模型**：deepseek-chat
- **Judge 模型**：deepseek-chat
- **评测方法（四维度）**：
  1. **Pairwise + 位置交换**：judge 比较 原始context回答 vs 压缩context回答，交换 A/B 顺序跑两次
  2. **第三轮决胜**（`judgePairwiseTiebreaker`）：两次结论不一致时，跑第三轮（prompt 要求"必须选 A 或 B，不能 tie"），v3=A → raw_better，v3=B → compressed_better，v3=tie → 最终 tie
  3. **LLM 语义相似度**：LLM 打分 0-100，**中文 prompt**，输出中文 reason
  4. **LLM 关键信息覆盖率**：LLM 判断关键点是否覆盖（语义匹配，"删除缓存"和"清除缓存"都算覆盖）
- **5 个测试用例**：代码 bug 定位 / 架构理解 / 配置文件理解 / 长代码理解 / API 文档理解
- **CaseResult 字段**：新增 `compressedContext` 字段，报告中用 `<details>` 折叠展示压缩后具体输入内容
- **报告格式**：
  - 汇总表（准确率保持率 / 语义相似度 / 上下文压缩率）
  - 每用例：问题（代码块）+ 参考答案 + 上下文压缩信息 + 压缩后具体输入内容（`<details>` 折叠）+ 左右分栏回答对比（HTML table + `<pre>` + `escapeHtml`）+ Judge 结论 + 语义相似度（中文 reason）+ 关键点命中表格
  - 无压缩时跳过：`> 当前没有压缩，两者一致`
- **报告保存**：`f:\Context\reports\accuracy-eval-{timestamp}.md`

#### 4.3.3 多轮对话评测（demo-client.ts compare 模式）— **P3 新增**

- **定位**：多轮对话场景的端到端评测（demo 展示用）
- **与 accuracy-eval.ts 的区别**：accuracy-eval 是单轮独立用例，demo-client 是多轮对话逐轮评测
- **评测流程**：见 4.2.4 的"compare 模式流程"
- **报告保存**：`f:\Context\reports\demo-eval-{timestamp}.md`
- **最新数据**（budget=800, 6 轮）：
  - Token 节省率：63.2%（累计），75.1%（最后一轮）
  - 语义相似度：82.0%
  - 缓存命中率：直连 68.5% vs 代理 20.8%

## 五、测试运行方式

### 5.1 启动代理

```powershell
# 设置 API Key
$env:DEEPSEEK_API_KEY="sk-你的密钥"

# 启动代理（budget=800 触发压缩）
pnpm --filter @context/proxy dev -- -u https://api.deepseek.com -b 800 -p 8788
```

### 5.2 运行多轮对话评测（demo-client compare 模式）

```powershell
# 设置 API Key
$env:DEEPSEEK_API_KEY="sk-你的密钥"

# compare 模式（直连 vs 本地 engine 处理 + 逐轮评测）
# -n 6: 6 轮对话 / -b 1500: budget 1500 token（建议 1500-2000）
pnpm --filter @context/proxy exec tsx src/demo-client.ts --compare -n 6 -b 1500

# verbose 模式（输出每轮对话详情）
pnpm --filter @context/proxy exec tsx src/demo-client.ts --compare -n 6 -b 1500 -v

# 只跑直连（基线测试，不需要 proxy）
pnpm --filter @context/proxy exec tsx src/demo-client.ts --direct -n 6
```

**注意**：compare 模式不需要启动 proxy server，直接本地调 engine 处理。每轮有压缩的轮次会做 2-3 次 LLM-as-judge 调用 + 1 次语义相似度调用，6 轮约 12-18 次额外 API 调用。

### 5.3 运行准确率评测

```powershell
$env:DEEPSEEK_API_KEY="sk-你的密钥"
pnpm --filter @context/engine exec tsx src/__test__/accuracy-eval.ts

# verbose 模式
pnpm --filter @context/engine exec tsx src/__test__/accuracy-eval.ts -v
```

### 5.4 运行单元测试

```powershell
pnpm --filter @context/engine test
# 或单独运行某个测试
pnpm --filter @context/engine exec tsx src/__test__/reversible-advanced.test.ts
pnpm --filter @context/engine exec tsx src/__test__/pagerank.test.ts
pnpm --filter @context/engine exec tsx src/__test__/hybrid-search.test.ts
```

### 5.5 运行 Benchmark

```powershell
pnpm --filter @context/engine exec tsx src/__test__/benchmark.ts
```

## 六、技术栈

### 共享

- TypeScript 5.x，strict 模式
- pnpm workspace 管理 monorepo
- tsup 打包，tsx 运行
- ESM 模块（`import`，不能用 `require`）

### context-engine

- `js-tiktoken`（cl100k_base 编码）：token 计数
- `web-tree-sitter`（WASM）：跨平台代码解析
- `tree-sitter-typescript` / `tree-sitter-javascript`：语法 grammar

### context-proxy

- `hono`：HTTP 框架
- `@hono/node-server`：Node 适配

### context-mcp

- 已实现 `search_archive` MCP tool：复用注入的 `ArchiveStore`，支持 `query` 与 `topK` 参数。
- 默认入口使用 stdio transport；服务日志写 stderr，stdout 保持 MCP 协议干净。
- `createMcpServer(store)` 保留为未来宿主接入接口；当前独立 stdio 模式不接入代理 session 生命周期，也不伪造实时归档数据。

- `@modelcontextprotocol/sdk` + `zod`：MCP 协议、stdio transport 与工具参数校验。

## 七、已完成阶段

### P0（最小可 demo）✅

- monorepo 骨架
- context-engine: types + budget + cache + engine 主流程
- context-proxy: Hono server + OpenAI 路由 + 转发
- 可逆压缩（空白规整 + 结构折叠）
- 缓存命中率预估 + 日志输出

### P1（核心能力补齐）✅

- LLM 摘要压缩（summarize.ts）
- Anthropic `/v1/messages` 路由 + cache_control 自动断点
- tree-sitter repo map
- 配置文件 + CLI 参数

### P2（增强）✅

- PageRank 符号排序（pagerank.ts）
- 向量检索 RAG（embedder.ts + vector-store.ts + keyword-search.ts + hybrid-search.ts + hybrid-searcher.ts）
- 结构折叠/mask 可逆压缩进阶（reversible.ts 新增 5 种手法）
- benchmark 脚本（benchmark.ts）

### P3（demo 准备）✅

- ✅ P3-1: demo-client 脚本（真实 LLM 多轮对话）
- ✅ P3-2: 日志增强（saved: $0.0X + cache_hit 高亮）
- ✅ P3-3: 准确率评测脚本（accuracy-eval.ts 单轮 + demo-client compare 多轮）
- ✅ P3-3 修复：第三轮决胜 + 中文 prompt + 压缩后输入内容展示 + 报告格式（顺序展示）
- ✅ 报告路径冗余修复：统一保存到 `f:\Context\reports\`

### P3 后续（未开始）

- P3-4: 本地 mock 上游（网络兜底）
- P3-5: 运行时配置切换（`/config` PATCH 端点）
- ~~MCP server 包装~~ 已完成：`search_archive`
- npm 发布

## 八、待解决问题与下一步工作

### 已解决的问题（近两次工作）

1. **Judge 无法判定** → 加第三轮决胜（`judgePairwiseTiebreaker`），inconclusive 数量降为 0
2. **语义相似度英文 reason** → llmEvaluate prompt 改为中文，输出中文 reason
3. **报告不展示压缩后输入内容** → CaseResult 加 `compressedContext` 字段 + `<details>` 折叠展示
4. **HTML table 内代码块不渲染** → 用 `<pre>` + `escapeHtml` 替代
5. **accuracy-eval 单轮 vs demo-client 多轮的定位割裂** → demo-client compare 模式新增逐轮评测，成为多轮对话场景的主评测
6. **报告路径冗余** → 统一保存到 `f:\Context\reports\`
7. **报告格式** → 改为顺序展示（不分栏），每轮：问题 / 输入 token / 缓存命中率 / 代理实际输入内容 / 直连回答 / 代理回答 / 评测
8. **P0-1 真实代理未接入归档** → Anthropic `/v1/messages` 端点改为 `getOrCreateSession` 并传入 archive / currentTurn / stablePrefixLength / compaction（[server.ts](packages/context-proxy/src/server.ts)）
9. **P0-2 typecheck 失败** → 修复 mock summarizer 返回类型；`forceRetrieval` 加入 `EngineInput` 后需重建 `@context/engine` 包
10. **P0-3 测试脚本遗漏归档测试** → 默认 test 脚本纳入 Repo Map / PageRank 等新测试
11. **Demo 召回 0 次** → `injectRetrieval` 的 over-budget 阈值检查跳过 `forceRetrieval`（[engine.ts](packages/context-engine/src/engine.ts#L97)），Demo Turn 16 召回成功（注入 1099 tok）

### 当前待解决问题

1. **Pairwise Judge 偏差（已在 2026-10-07 修正口径）**：原口径下 raw-vs-raw 校准显示 Judge 存在长度偏好 + 决胜轮位置偏置，导致 20 轮回归 Pairwise 1胜/9负与实际语义不符。现已改为「需求逐条核对 + 位置交换，两次不一致直接判平」并删除有偏决胜轮，2026-10-07 重跑（`reports/_rerun-20t-baseline-20261007/`）非劣率 90.0%（胜/平/负 2/7/1），相似度 85.6%、需求覆盖率 0.0pp（零差异）
2. **归档 epoch 切换导致 cache 全 miss**：Turn 13 归档后缓存命中从 ~99% 降至 0%，之后需 5-7 轮恢复。这正是 `rearchiveThreshold = hardLimit * 2` 的设计动机，但一次归档仍带来一次全 miss 的成本
3. **budget=1500 准确率偏低（0%）**：清空式裁剪保留了缓存命中但丢失了上下文信息。已通过预算提高到 8000 + 归档系统缓解，但极端低预算下仍需权衡
4. **judge 模型用同一模型**：被测和 judge 都用 deepseek-chat，存在自评偏差。理想情况 judge 应用 GPT-4，但 DeepSeek 便宜足够 demo

### 下一步候选工作（按优先级）

1. **详细版 Demo 报告**：在 demo-live 报告基础上增加"压缩前后内容 diff"与"压缩后回答准确性评测细节"（用户已确认方向，见下方讨论）
2. **面试展示 Benchmark 报告**：独立一份（`reports/BENCHMARK_FINAL.md` 已有），补充"典型案例解剖"章节（选 1-2 轮展示压缩前后具体内容），非每次运行生成
3. **P3-4: 本地 mock 上游**：网络断了也能 demo，准备预设回答的假 LLM server
4. **P3-5: 运行时配置切换**：`/config` PATCH 端点，不重启代理改 budget / 策略
5. **MCP server 扩展**：补充归档持久化与宿主应用接入
6. **npm 发布**：让面试官能 `npm install` 试

## 九、关键设计决策记录

1. **代理层方案**：MCP 无法修改 messages，采用 API 代理层方案
2. **跨平台兼容性**：选用 web-tree-sitter（WASM）规避 Windows 原生编译
3. **PageRank 算法**：环形图均匀分布、星形图中心节点 rank 更高
4. **混合检索**：RRF 融合后定义 parseConfig 的文件排第一
5. **Anthropic cache_control**：正确插入 ≤4 个断点
6. **KV Cache 原理**：前缀逐 token 一致才能命中；分层结构（system/tools/rules/history/dynamic）
7. **LLM-as-judge 偏差**：30% 系统性偏差，用 Pairwise + 位置交换 + 第三轮决胜消除
8. **报告保存路径**：统一到 `f:\Context\reports\`，避免 pnpm exec 的 cwd 问题
9. **demo-client 代理模式改本地 engine 处理**（P3 重构）：不走 HTTP proxy，直接调 `runEngine`，这样可以记录压缩后 messages、计算逐轮缓存命中率、做逐轮 judge 评测
10. **多轮评测优于单轮评测**：accuracy-eval.ts 单轮评测作为基准 unit test，demo-client compare 模式作为多轮对话端到端评测，后者更贴近项目核心价值
11. **报告顺序展示格式**：放弃 HTML table 左右分栏（代码块在 table 内不渲染），改为顺序展示：问题 / 输入 token / 缓存命中率 / 代理实际输入内容 / 直连回答 / 代理回答 / 评测
12. **第三轮决胜设计**：v1 与 v2 不一致时跑 v3（forceChoice=true），v3=A → raw_better，v3=B → compressed_better，v3=tie → 最终 tie
13. **缓存友好裁剪策略**（P3 修复）：旧版"删除式裁剪"破坏前缀 token 序列，缓存命中仅 20.8%；改为"清空式裁剪"（content → `[cleared: was N tok]`），保留消息骨架，缓存命中提升至 53.9%。借鉴 Claude Code MicroCompact（就地清空）+ Hermes ContextCompressor（head+tail 保护）
14. **Head+Tail 保护设计**：head（system + 前 2 条 history）永不裁，tail（最近 4 条 history + dynamic）永不裁，只动 middle。三级渐进：clear-middle → clear-tail → drop-overflow
15. **重要陷阱**：改 context-engine 源码后必须 `pnpm --filter @context/engine build` 重新编译，否则 demo-client 导入的是旧的 dist/index.js

## 十、简历叙事

> "我开发了一个面向 AI Coding 的上下文管理代理。它通过 HTTP 代理层拦截 LLM 请求，在保证回答质量（Pairwise + 需求逐条核对 + 位置交换、两次不一致判平 + LLM 语义相似度评测）的前提下，两级压缩（可逆 + 预算裁剪 + rotation 经济性门槛）将 token 消耗降低 40.3%（多轮对话累计）至 58.7%（最后一轮），并实现了 cache_hit 预估、成本节省统计等可观测性能力。项目采用三层架构（核心库 + 代理 + MCP），支持 OpenAI / Anthropic 双协议，并提供了完整的 benchmark 评估（单轮基准 + 多轮端到端）。"

**可讲深的方向**：

- 缓存命中算法的设计与权衡（前缀一致率，压缩对缓存的影响）
- 两级压缩的边界（什么时候该可逆、什么时候该摘要）
- 代理层的工程实践（中间件、可观测性）
- benchmark 方法论（LLM-as-judge 的 30% 偏差 + 位置交换消除 + 第三轮决胜）
- PageRank 在代码符号排序中的应用
- 混合检索（向量 + TF-IDF + RRF 融合）
- budget 调参权衡（压缩率 vs 准确率 vs 缓存命中率）
