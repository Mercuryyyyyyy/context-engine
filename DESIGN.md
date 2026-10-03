# Context Engine 设计文档

> 一个面向 AI Coding 场景的上下文管理工具。通过代理层拦截 LLM 请求，对 messages 进行检索、压缩、缓存优化，在保证回答质量的前提下显著降低 token 消耗与成本。

## 一、项目定位

**解决的问题**：长对话 / 大代码库场景下，上下文爆炸导致 token 成本飙升、缓存命中率下降、模型注意力分散。

**核心价值**：

- Token 节省 60–80%
- 回答质量损失 < 5%
- 缓存命中率提升 30%+

**差异化**：

- 专注代码场景（tree-sitter repo map）
- 代理层联合优化「检索 + 压缩 + 缓存」三者，而非只做压缩
- 可审计：每次请求记录 token / 成本 / 命中率

## 二、三层架构

```
┌─────────────┐     ┌──────────────┐     ┌──────────┐
│   Client    │────▶│ context-proxy│────▶│  LLM API │
│ (opencode/  │     │  - 拦截      │     │          │
│  Cursor/    │     │  - 调 Engine │     └──────────┘
│  自写脚本)  │     │  - 改写      │
└─────────────┘     │  - 转发      │
                    └──────────────┘
┌─────────────┐           │
│ context-mcp │◀──────────┤ (生态接入，被动查询)
└─────────────┘           │
                          ▼
                    ┌──────────────┐
                    │context-engine│  (核心库)
                    │ - 检索       │
                    │ - 压缩       │
                    │ - 缓存优化   │
                    │ - 预算管理   │
                    └──────────────┘
```

| 层                | 形态           | 职责                     |
| ---------------- | ------------ | ---------------------- |
| `context-engine` | npm 包        | 核心算法：检索 / 压缩 / 缓存 / 预算 |
| `context-proxy`  | CLI + Docker | HTTP 代理，拦截并改写 messages |
| `context-mcp`    | npx 运行       | MCP server，暴露检索能力给生态   |

## 三、核心模块设计

### 3.1 类型系统（`packages/context-engine/src/types.ts`）

```ts
// 单条消息（兼容 OpenAI 格式）
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
}

// 上下文层级（决定稳定性与缓存策略）
type ContextTier =
  | 'system'        // 绝对不变：system prompt
  | 'tools'         // 几乎不变：工具定义
  | 'rules'         // 长期稳定：项目规则
  | 'history'       // 会话内稳定：历史对话
  | 'dynamic';      // 每轮变化：当前查询 + RAG 结果

// 分层后的上下文块
interface ContextBlock {
  tier: ContextTier;
  messages: Message[];
  tokenCount: number;
  // 是否在该块末尾插入 Anthropic cache_control 断点
  cacheBreakpoint?: boolean;
}

// 引擎输入
interface EngineInput {
  messages: Message[];
  model: string;
  // token 预算上限（输入侧）
  budget?: number;
  // 上一轮的 messages，用于算缓存命中率
  previousMessages?: Message[];
}

// 引擎输出
interface EngineOutput {
  messages: Message[];           // 改写后
  stats: {
    originalTokens: number;
    optimizedTokens: number;
    savedTokens: number;
    cacheHitTokens: number;      // 预估可命中前缀
    cacheHitRate: number;
    compressionRatio: number;
    strategies: string[];        // 命中了哪些策略
  };
}
```

### 3.2 预算管理（`budget.ts`）

**职责**：在固定 token 预算内，按优先级保留内容。

**策略**：分级截断，优先级 `system > tools > rules > 最近 N 轮 history > 更早 history > dynamic`。

```ts
interface BudgetOptions {
  maxTokens: number;
  // 每层保留的最小 token（保护性下限）
  minKeep?: Partial<Record<ContextTier, number>>;
}

// 返回裁剪后的 blocks，总 token ≤ maxTokens
function applyBudget(blocks: ContextBlock[], opts: BudgetOptions): ContextBlock[];
```

**算法**：

1. 计算各层 token 数
2. 若总量 ≤ 预算，直接返回
3. 否则从最低优先级层开始裁剪：
   - `dynamic`：从尾部裁（保留前部稳定）
   - `history`：从最老的一轮开始裁，必要时触发摘要压缩
   - 其他层不裁

### 3.3 缓存优化（`cache.ts`）

**职责**：最大化前缀缓存命中率。

**三个能力**：

1. **前缀分层**：将 messages 按 tier 排序，稳定者前置
2. **自动断点**：在 tier 边界插入 `cache_control`（Anthropic 最多 4 个）
3. **命中率预估**：对比 `previousMessages`，找最长公共前缀

```ts
// 预估前缀命中
function estimateCacheHit(
  current: Message[],
  previous: Message[]
): { hitTokens: number; hitRate: number; firstDiffIndex: number };
```

**命中预估算法**：

- 用 tiktoken 对每条 message 计 token
- 逐条对比，找到第一条不同的 message
- 命中 token = 前缀所有 message 的 token 之和

### 3.4 压缩层（`compress/`）

**两级压缩**：

#### 可逆压缩（`reversible.ts`，无损）

| 手法   | 实现                                 |
| ---- | ---------------------------------- |
| 空白规整 | 多空行/缩进归一                           |
| 结构折叠 | 把超长 JSON/日志折叠为 `<folded:N tokens>` |
| 重复检测 | 字典法去重重复片段                          |
| Mask | 低重要性段标记 `[masked]`，可恢复             |

```ts
function reversibleCompress(text: string): { compressed: string; reversible: true; saved: number };
```

#### 不可逆压缩（`summarize.ts`，有损）

调小模型对老历史 / 长文档做摘要。

```ts
interface SummarizeOptions {
  model: string;          // 如 'gpt-4o-mini' / 'claude-haiku'
  targetRatio: number;    // 目标压缩比，如 0.2
  apiKey?: string;
}

function summarizeMessages(
  messages: Message[],
  opts: SummarizeOptions
): Promise<{ summary: string; originalTokens: number; summaryTokens: number }>;
```

### 3.5 检索层（`retrieve/repo-map.ts`，P1）

tree-sitter 解析代码库，生成 repo map（类/函数签名 + 调用关系），供 LLM 参考。

```ts
function buildRepoMap(rootDir: string): Promise<string>;
```

P1 阶段实现，最小 demo 不含。

### 3.6 引擎主流程（`engine.ts`）

```ts
async function runEngine(input: EngineInput): Promise<EngineOutput> {
  // 1. 分层：把扁平 messages 切成 ContextBlock[]
  // 2. 缓存预估：对比 previousMessages
  // 3. 压缩：对 history 中较老部分做可逆 + 摘要
  // 4. 预算：applyBudget 控制总量
  // 5. 重排：按 tier 顺序拼装，插 cache_control 断点
  // 6. 统计：返回 stats
}
```

## 四、代理层设计（`context-proxy`）

### 4.1 技术栈

- **HTTP 框架**：Hono（轻量、快、跨运行时）
- **运行时**：Node.js（兼容性最好）
- **CLI**：直接 `process.argv` 解析（避免引依赖）

### 4.2 路由

| 路径                          | 行为                                      |
| --------------------------- | --------------------------------------- |
| `POST /v1/chat/completions` | 拦截 OpenAI 格式，调 engine 改写 messages，转发到上游 |
| `POST /v1/messages`         | Anthropic 格式（P1）                        |
| `GET /healthz`              | 健康检查                                    |
| `GET /metrics`              | Prometheus 指标                           |
| `GET /stats`                | 最近请求统计 JSON                             |

### 4.3 配置

```yaml
# context-proxy.yaml
port: 8787
upstream:
  openai: https://api.openai.com
  anthropic: https://api.anthropic.com
engine:
  budget: 32000
  enableReversible: true
  enableSummarize: false    # P1 默认关，避免依赖外部 API
  cacheBreakpoints: 4
logging: true
```

### 4.4 中间件链

```
请求 → logging → 鉴权(pass-through) → engine → forward → logging
```

## 五、技术栈与依赖

### 共享

- TypeScript 5.x，strict 模式
- pnpm workspace 管理 monorepo
- tsup 打包，tsx 运行

### context-engine

- `tiktoken`（js-tiktoken）：token 计数
- `tree-sitter` + 各语言 grammar（P1）

### context-proxy

- `hono`：HTTP 框架
- `@hono/node-server`：Node 适配
- `yaml`：配置解析

### context-mcp

- `@modelcontextprotocol/sdk`

## 六、Benchmark 方案

### 6.1 测试集

准备 3 个场景：

1. **长对话**：20 轮多轮对话（含工具调用）
2. **代码库 RAG**：模拟代码仓库检索场景
3. **超长文档**：单条 80k token 文档 + 提问

### 6.2 指标

| 指标        | 计算方式                                 |
| --------- | ------------------------------------ |
| Token 节省率 | 1 - optimizedTokens / originalTokens |
| 缓存命中率     | hitTokens / optimizedTokens          |
| 回答准确率     | LLM-as-judge（GPT-4 评分 0-10）          |
| 端到端延迟     | proxy 介入前后的 P50/P95                  |

### 6.3 对比基线

- **Baseline**：原始 messages 直发
- **Headroom-like**：仅做可逆压缩
- **Ours-full**：检索 + 两级压缩 + 缓存优化

## 七、优先级与路线图

### P0（最小可 demo）

- [x] monorepo 骨架
- [x] context-engine: types + budget + cache + engine 主流程
- [x] context-proxy: Hono server + OpenAI 路由 + 转发
- [x] 可逆压缩（空白规整 + 结构折叠）
- [x] 缓存命中率预估 + 日志输出

### P1（核心能力补齐）

- [ ] 不可逆压缩（LLM 摘要）
- [ ] Anthropic `/v1/messages` 路由 + cache_control 自动断点
- [ ] tree-sitter repo map
- [ ] 配置文件 + CLI 参数

### P2（增强）

- [ ] 向量检索（bge-small）
- [ ] Web Dashboard（可视化 messages 改写前后）
- [ ] Prometheus metrics
- [ ] Docker 镜像

### P3（生态）

- [ ] context-mcp server
- [ ] npm 发布
- [ ] Benchmark 报告 + 博客

## 八、简历叙事

> "我开发了一个面向 AI Coding 的上下文管理代理。它通过 HTTP 代理层拦截 LLM 请求，在保证回答质量（< 5% 损失）的前提下，通过两级压缩（可逆 + 摘要）、前缀缓存优化、tree-sitter 代码检索，将 token 消耗降低 60–80%，缓存命中率提升 30%+。项目采用三层架构（核心库 + 代理 + MCP），支持 OpenAI / Anthropic 双协议，并提供了完整的 benchmark 评估。"

可讲深的方向：

- 缓存命中算法的设计与权衡
- 两级压缩的边界（什么时候该可逆、什么时候该摘要）
- 代理层的工程实践（中间件、可观测性）
- benchmark 方法论（LLM-as-judge 的局限性）
