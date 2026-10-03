// 核心类型定义

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export type ContentPart = TextPart;

export interface Message {
  role: Role;
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

// 上下文层级：决定稳定性与缓存策略
// system（绝对不变）→ tools（几乎不变）→ rules（长期稳定）→ history（会话内稳定）→ dynamic（每轮变化）
export type ContextTier = 'system' | 'tools' | 'rules' | 'history' | 'dynamic';

// 分层后的上下文块
export interface ContextBlock {
  tier: ContextTier;
  messages: Message[];
  tokenCount: number;
  cacheBreakpoint?: boolean;
}

export interface SummarizerOptions {
  // 二选一：提供 config 用内置摘要器，或提供 fn 自定义
  config?: import('./compress/summarize.js').SummarizerConfig;
  fn?: import('./compress/summarize.js').SummarizerFn;
  // 保留最近 N 条 history 消息不摘要，默认 6
  recentKeep?: number;
}

export interface RetrievedContext {
  id: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface RetrievalOptions {
  search: (query: string, topK: number) => Promise<RetrievedContext[]>;
  topK?: number;
  maxTokens?: number;
  when?: 'always' | 'over-budget';
  minScore?: number;
}

export interface EngineInput {
  messages: Message[];
  // 可选的未压缩基线，仅用于统计；messages 可以是上一压缩 epoch + 本轮增量。
  baselineMessages?: Message[];
  model: string;
  // token 预算上限（输入侧），超过则触发裁剪 / 摘要
  budget?: number;
  // 上一轮的 messages，用于算缓存命中率
  previousMessages?: Message[];
  // 稳定前缀长度：前 N 条消息是上一轮压缩后的稳定前缀，本轮不应再次压缩。
  // 由调用方（如 demo-client 的 controlled replay）传入，用于保护 Provider 前缀缓存。
  // 当 total 超过硬上限（highWatermark * 1.5）时，忽略此值并全量重压缩。
  stablePrefixLength?: number;
  // 是否启用可逆压缩，默认 true
  // 兼容旧配置：现在仅执行真正无损的空白归一化。
  enableReversible?: boolean;
  // 是否启用有损语义折叠（代码块/JSON/长行等），默认 false。
  enableSemanticFold?: boolean;
  // 仅保留最近 N 条 history 原文，默认 6。
  recentKeep?: number;
  // 是否强制满足硬预算。默认 false：宁可软超限，也不删除受保护的近期上下文。
  hardBudget?: boolean;
  // 摘要压缩配置，提供时才启用有损压缩
  summarizer?: SummarizerOptions;
  // 可选的 query-aware 外部检索器。
  retrieval?: RetrievalOptions;
  // 归档选项：模块跟踪 + 归档存储 + 归档检索器
  // 提供时启用 archival memory 模式：自动检测主题切换、归档旧模块、按需检索
  archive?: ArchiveOptions;
  // 当前轮次（1-based），用于 ModuleTracker
  currentTurn?: number;
  // 压缩滞后配置：避免每轮频繁触发摘要
  // highWatermark: 超过此值才触发摘要/clear-middle（默认 = budget）
  // lowWatermark: 摘要后的目标 token（默认 = budget * 0.7）
  compaction?: CompactionOptions;
  // 强制注入 retrieval（跳过 over-budget 阈值检查），用于 Demo 场景展示归档召回
  forceRetrieval?: boolean;
}

export interface CompactionOptions {
  // 高水位：超过此值触发摘要和裁剪，默认 = budget
  highWatermark?: number;
  // 低水位：摘要后的目标，默认 = budget * 0.7
  lowWatermark?: number;
}

export interface ArchiveOptions {
  // 模块跟踪器（有状态，由调用方管理生命周期）
  moduleTracker: import('./retrieve/module-tracker.js').ModuleTracker;
  // 归档存储（有状态，由调用方管理生命周期）
  archiveStore: import('./retrieve/archive-store.js').ArchiveStore;
  // 归档检索器（可选，提供时替代 retrieval）
  retriever?: import('./retrieve/archive-retriever.js').ArchiveRetriever;
  // 归档时是否生成 LLM 摘要（需要 summarizer），默认 true
  enableSummary?: boolean;
}

export interface EngineStats {
  originalTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  cacheHitTokens: number;   // 预估可命中前缀的 token 数
  cacheHitRate: number;
  compressionRatio: number;
  strategies: string[];     // 命中了哪些策略
  retrievedTokens?: number;
  retrievedItems?: Array<{ id: string; score?: number }>;
  budgetExceeded?: boolean;
  archivedModules?: number;           // 本轮归档的模块数
  archivedMessages?: number;          // 本轮归档的消息数
  archiveRetrievedCount?: number;     // 本轮从归档检索的消息数
  archiveRetrievedTokens?: number;    // 本轮从归档检索注入的 token 数
}

export interface EngineOutput {
  messages: Message[];
  stats: EngineStats;
}
