import type { ContextTier, EngineInput, EngineOutput, Message, RetrievedContext } from './types.js';
import { countMessageTokens, countMessagesTokens, messageContentToString } from './tokenize.js';
import { estimateCacheHit } from './cache.js';
import { losslessNormalize, semanticFold } from './compress/reversible.js';
import {
  createDefaultSummarizer,
  buildSummaryMessage,
  summarizeMessages,
} from './compress/summarize.js';

function isRulesMessage(msg: Message): boolean {
  const text = messageContentToString(msg.content);
  return /<rules>|<project>|^#\s+(Rules|Project Rules|CLAUDE)/m.test(text);
}

function classifyMessage(msg: Message, index: number, messages: Message[]): ContextTier {
  if (msg.name === 'context-retrieval') return 'dynamic';
  if (msg.name === 'context-summary') return 'history';
  if (msg.name === 'context-archive') return 'history';
  if (msg.role === 'system') return 'system';
  if (msg.role === 'tool') return 'tools';
  if (msg.role === 'user' && isRulesMessage(msg)) return 'rules';

  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
  if (lastUserIndex >= 0 && index >= lastUserIndex) return 'dynamic';
  return 'history';
}

interface AnnotatedItem {
  msg: Message;
  tier: ContextTier;
  tokens: number;
  dropped: boolean;
  originalIndex: number;
}

function queryTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z_][a-z0-9_.-]{1,}|\d+/g)) {
    terms.add(match[0]);
  }
  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const value = match[0];
    if (value.length <= 2) terms.add(value);
    for (let i = 0; i < value.length - 1; i++) terms.add(value.slice(i, i + 2));
  }
  return terms;
}

function relevanceToQuery(message: Message, query: string): number {
  const q = queryTerms(query);
  if (q.size === 0) return 0;
  const contentTerms = queryTerms(messageContentToString(message.content));
  let overlap = 0;
  for (const term of q) if (contentTerms.has(term)) overlap++;
  return overlap / q.size;
}

// 从被清空的消息中提取少量关键词作为「语义脚手架」，
// 让模型在 token 预算不变的情况下仍能感知被裁剪消息的主题（借鉴 Lost-in-the-Middle 与去噪压缩思路）。
// 硬约束（rotationForceTokens）的紧急放大系数：
// total ≥ rotationForceTokens × 该系数时，忽略 epoch 年龄立即强制 rotation。
const ROTATION_EMERGENCY_FACTOR = 1.5;
// 由 contextWindowTokens 自动推导 rotationForceTokens 时占用的可用输入空间比例。
// 取 0.6 是为了保证滞回：紧急线 = 0.6 × 1.5 = 0.9，仍留出 10% 空间，
// 使"突破阈值后等待 epoch 年龄"期间的增长不至于溢出。
const ROTATION_FORCE_RATIO = 0.6;

const HINT_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'is', 'are', 'was',
  'were', 'be', 'been', 'for', 'of', 'to', 'in', 'on', 'with', 'this', 'that',
  'it', 'as', 'at', 'by', 'from', 'you', 'we', 'they', 'i', 'he', 'she', 'not',
  'no', 'all', 'do', 'does', 'did', 'have', 'has', 'had', 'can', 'will', 'would',
  'could', 'should', 'may', 'might', 'must',
]);

function extractHint(text: string, maxTerms = 8): string {
  const out: string[] = [];
  for (const term of queryTerms(text)) {
    if (out.length >= maxTerms) break;
    if (HINT_STOPWORDS.has(term)) continue;
    if (/^\d+$/.test(term) && term.length < 4) continue;
    out.push(term);
  }
  return out.join(', ');
}

function formatRetrievedContext(items: RetrievedContext[], maxTokens: number): {
  message?: Message;
  tokens: number;
  selected: Array<{ id: string; score?: number }>;
} {
  const sections: string[] = [];
  const selected: Array<{ id: string; score?: number }> = [];
  let tokens = 0;
  for (const item of items) {
    const section = `[${item.id}${item.score === undefined ? '' : ` score=${item.score.toFixed(3)}`} ]\n${item.content}`;
    const candidate: Message = { role: 'system', name: 'context-retrieval', content: section };
    const itemTokens = countMessageTokens(candidate);
    if (tokens + itemTokens > maxTokens) continue;
    sections.push(section);
    selected.push({ id: item.id, score: item.score });
    tokens += itemTokens;
  }
  if (sections.length === 0) return { tokens: 0, selected };
  const message: Message = {
    role: 'system',
    name: 'context-retrieval',
    content: `[Retrieved context for the current query]\n\n${sections.join('\n\n---\n\n')}`,
  };
  return { message, tokens: countMessageTokens(message), selected };
}

async function injectRetrieval(messages: Message[], input: EngineInput): Promise<{
  messages: Message[];
  tokens: number;
  selected: Array<{ id: string; score?: number }>;
}> {
  // 优先使用归档检索器
  const retrieval = input.archive?.retriever?.search
    ? { search: input.archive.retriever.search, topK: 6, maxTokens: 1200, when: 'over-budget' as const, minScore: 0 }
    : input.retrieval;
  if (!retrieval) return { messages, tokens: 0, selected: [] };
  if (retrieval.when === 'over-budget') {
    if (!input.forceRetrieval && (!input.budget || countMessagesTokens(messages) <= input.budget)) return { messages, tokens: 0, selected: [] };
    // Compaction Epoch 稳定前缀保护：未超硬上限时不注入 retrieval（注入会破坏前缀缓存）
    // 已有 context-archive 消息时，提高阈值到 hardLimit * 2，与 processArchive 保持一致
    // forceRetrieval=true 时跳过此检查（Demo 场景强制展示召回）
    const stablePrefixLen = input.stablePrefixLength ?? 0;
    const hw = input.compaction?.highWatermark ?? input.budget;
    const hl = hw ? Math.floor(hw * 1.5) : undefined;
    const hasExistingArchive = messages.some((m) => m.name === 'context-archive');
    const retrievalThreshold = hasExistingArchive && hl ? hl * 2 : hl;
    if (!input.forceRetrieval && stablePrefixLen > 0 && retrievalThreshold && countMessagesTokens(messages) <= retrievalThreshold) {
      return { messages, tokens: 0, selected: [] };
    }
  }
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
  if (lastUserIndex < 0) return { messages, tokens: 0, selected: [] };
  const query = messageContentToString(messages[lastUserIndex]!.content);
  const results = await retrieval.search(query, retrieval.topK ?? 6);
  const eligible = results.filter((item) => item.score === undefined
    || item.score >= (retrieval.minScore ?? 0));
  const formatted = formatRetrievedContext(eligible, retrieval.maxTokens ?? 1200);
  if (!formatted.message) return { messages, tokens: 0, selected: [] };
  const next = [...messages];
  next.splice(lastUserIndex, 0, formatted.message);
  return { messages: next, tokens: formatted.tokens, selected: formatted.selected };
}

/**
 * 归档处理：检测主题切换、归档旧模块、替换消息为摘要
 * 在 retrieval 之前执行，归档后的内容可通过 ArchiveRetriever 检索回来
 */
async function processArchive(
  messages: Message[],
  input: EngineInput,
): Promise<{
  messages: Message[];
  archivedModules: number;
  archivedMessages: number;
}> {
  if (!input.archive || input.currentTurn === undefined) {
    return { messages, archivedModules: 0, archivedMessages: 0 };
  }

  const { moduleTracker, archiveStore } = input.archive;
  const turn = input.currentTurn;

  // 找到当前 query（最后一条 user 消息）
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
  if (lastUserIndex < 0) return { messages, archivedModules: 0, archivedMessages: 0 };
  const query = messageContentToString(messages[lastUserIndex]!.content);

  // 计算本轮新增的消息索引（基于 previousMessages 长度）
  const prevLen = input.previousMessages?.length ?? 0;
  const newMessageIndices: number[] = [];
  for (let i = prevLen; i < messages.length; i++) {
    newMessageIndices.push(i);
  }

  // 当前 token 数（用于高水位兜底）
  const currentTokens = countMessagesTokens(messages);

  // 调用 moduleTracker.observe（每轮执行，检测话题切换）
  const observeResult = moduleTracker.observe(turn, query, newMessageIndices, currentTokens);

  // 只在超 highWatermark 时执行归档操作，避免每轮修改消息结构破坏 Provider 前缀缓存。
  // observe 仍然每轮执行（维护模块状态），但消息替换只在需要腾出空间时触发。
  // 未设置 highWatermark（无 budget）时保持原有行为，始终允许归档。
  const highWatermark = input.compaction?.highWatermark ?? input.budget;
  if (highWatermark && currentTokens <= highWatermark) {
    return { messages, archivedModules: 0, archivedMessages: 0 };
  }

  // Compaction Epoch 稳定前缀保护：未超硬上限时不归档（归档会替换消息破坏前缀缓存）。
  // 只有超过硬上限（highWatermark * 1.5）时才允许归档，与全量重压缩一起执行。
  // 已有 context-archive 消息时，将重新归档阈值提高到 hardLimit * 2，
  // 让首次归档后的稳定前缀能持续命中缓存，clear-middle 负责中间消息的裁剪。
  const stablePrefixLen = input.stablePrefixLength ?? 0;
  const hardLimit = highWatermark ? Math.floor(highWatermark * 1.5) : undefined;
  const hasExistingArchive = messages.some((m) => m.name === 'context-archive');
  const rearchiveThreshold = hasExistingArchive && hardLimit
    ? hardLimit * 2
    : hardLimit;
  if (stablePrefixLen > 0 && rearchiveThreshold && currentTokens <= rearchiveThreshold) {
    return { messages, archivedModules: 0, archivedMessages: 0 };
  }

  if (observeResult.modulesToArchive.length === 0) {
    return { messages, archivedModules: 0, archivedMessages: 0 };
  }

  // 处理每个待归档模块。
  // 已发送过的稳定前缀不能被删除或替换，否则下一轮 Provider 缓存会从该位置失效。
  // 跨越稳定前缀的模块也暂缓归档，避免只归档模块的一部分导致状态与 ArchiveStore 不一致。
  const archivableModules = stablePrefixLen > 0
    ? observeResult.modulesToArchive.filter((module) =>
      module.messageIndices.every((idx) => idx >= stablePrefixLen))
    : observeResult.modulesToArchive;
  if (archivableModules.length === 0) {
    return { messages, archivedModules: 0, archivedMessages: 0 };
  }

  let archivedModules = 0;
  let archivedMessages = 0;
  const messagesToReplace = new Set<number>();
  const archiveInsertions: Array<{ insertAt: number; msg: Message }> = [];

  for (const module of archivableModules) {
    // 提取该模块的消息
    const moduleMessageIndices: number[] = [];
    for (const idx of module.messageIndices) {
      if (idx < messages.length) {
        moduleMessageIndices.push(idx);
        messagesToReplace.add(idx);
      }
    }
    if (moduleMessageIndices.length === 0) continue;

    const moduleMessages = moduleMessageIndices.map((idx) => messages[idx]!);

    // 生成摘要：优先用 LLM summarizer，降级为关键词摘要
    let summary = module.representativeQuery;
    if (input.archive.enableSummary !== false && input.summarizer) {
      const fn = input.summarizer.fn
        ?? (input.summarizer.config ? createDefaultSummarizer(input.summarizer.config) : undefined);
      if (fn) {
        try {
          const result = await summarizeMessages(moduleMessages, fn);
          summary = result.summary;
        } catch {
          // 降级为关键词摘要
        }
      }
    }

    // 标记模块为已归档
    moduleTracker.markArchived(module.id, summary, turn);

    // 归档到 ArchiveStore
    await archiveStore.archive({ ...module, status: 'archived', summary }, messages);

    // 创建归档摘要消息（替代原始消息）
    const archiveMsg: Message = {
      role: 'system',
      name: 'context-archive',
      content: `[Archived module: ${module.id} (turns ${module.startTurn}-${module.lastReferencedTurn})]\nTopic: ${module.representativeQuery}\nSummary: ${summary}\nFull content archived: available via retrieval.`,
    };

    // 插入位置：模块的第一条消息的位置
    const insertAt = Math.min(...moduleMessageIndices);
    archiveInsertions.push({ insertAt, msg: archiveMsg });

    archivedModules++;
    archivedMessages += moduleMessages.length;
  }

  if (archivedModules === 0) {
    return { messages, archivedModules: 0, archivedMessages: 0 };
  }

  // 替换消息：将被归档的消息替换为归档摘要消息
  const newMessages: Message[] = [];
  const insertedSummaries = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (messagesToReplace.has(i)) {
      // 在模块第一条消息位置插入归档摘要
      const insertion = archiveInsertions.find((s) => s.insertAt === i);
      if (insertion && !insertedSummaries.has(i)) {
        newMessages.push(insertion.msg);
        insertedSummaries.add(i);
      }
      continue;  // 跳过被归档的消息
    }
    newMessages.push(messages[i]!);
  }

  return { messages: newMessages, archivedModules, archivedMessages };
}

export async function runEngine(input: EngineInput): Promise<EngineOutput> {
  const originalTokens = countMessagesTokens(input.baselineMessages ?? input.messages);
  const strategies: string[] = ['classify'];

  // 归档处理：在 retrieval 之前执行，归档后的内容可通过检索器找回
  const archiveResult = await processArchive([...input.messages], input);
  if (archiveResult.archivedModules > 0) {
    strategies.push('archive');
  }

  // 使用归档后的消息进行后续处理
  const messagesAfterArchive = archiveResult.messages;
  const retrievalInput: EngineInput = { ...input, messages: messagesAfterArchive };
  const retrievalResult = await injectRetrieval([...messagesAfterArchive], retrievalInput);
  if (retrievalResult.tokens > 0) strategies.push('retrieve');
  const workingMessages = retrievalResult.messages;

  // 当前 query：用于相关性感知的语义折叠与中间消息裁剪
  const currentQuery = messageContentToString(
    [...workingMessages].reverse().find((message) => message.role === 'user')?.content ?? ''
  );

  const annotated: AnnotatedItem[] = workingMessages.map((msg, i) => ({
    msg,
    tier: classifyMessage(msg, i, workingMessages),
    tokens: countMessageTokens(msg),
    dropped: false,
    originalIndex: i,
  }));

  const budget = input.budget && input.budget > 0 ? input.budget : undefined;
  const recentKeep = input.recentKeep ?? input.summarizer?.recentKeep ?? 6;
  let total = annotated.reduce((sum, item) => sum + item.tokens, 0);

  // Compaction hysteresis：高水位触发压缩，目标压缩到低水位。
  // 默认高水位 = budget，低水位 = budget * 0.7。
  // 这样一次摘要释放足够空间支撑数轮追加，避免每轮频繁触发破坏前缀稳定性。
  const highWatermark = input.compaction?.highWatermark ?? budget;
  const lowWatermark = input.compaction?.lowWatermark
    ?? (budget ? Math.floor(budget * 0.7) : undefined);
  // target = 低水位；进入下方分支时 highWatermark 必存在，故 target 也必存在
  const target = (): number | undefined => lowWatermark ?? highWatermark;

  // Compaction Epoch：稳定前缀保护。
  // 正常水位内跳过稳定前缀，只允许压缩新增消息。
  // 即使超过 rotation threshold，也要等稳定 epoch 持续足够轮数后才允许全量重压缩。
  const stablePrefixLength = input.stablePrefixLength ?? 0;
  const stablePrefixTurns = input.stablePrefixTurns ?? 0;
  const rotationAfterRounds = Math.max(0, input.compaction?.rotationAfterRounds ?? 6);
  const hardLimit = highWatermark ? Math.floor(highWatermark * 1.5) : undefined;
  const hasExistingCompaction = workingMessages.some((m) =>
    m.name === 'context-summary' || m.name === 'context-archive');
  const protectionThreshold = hasExistingCompaction && hardLimit
    ? hardLimit * 2
    : hardLimit;
  // 硬约束兜底：上下文逼近模型窗口上限时，溢出风险优先于缓存经济性。
  // 此时解除"经济性门槛"与"保护阈值"两道锁，允许 rotation 改写稳定前缀。
  // 典型取值：模型上下文上限减去预留输出与安全余量。
  //
  // 注意：硬约束【不】解除 rotationAfterRounds（epoch 年龄）约束。
  // 实测反例：若同时绕过轮数，压缩后的 total 仍贴近阈值时，下一轮会立刻再次触发强制，
  // 导致"每轮都 rotation"——缓存持续断裂（12 轮实测 cache 34.3%，远差于不压缩）。
  // 保留轮数约束可保证强制 rotation 是稀疏的（至多每 rotationAfterRounds 轮一次），
  // 给新 epoch 留出重建缓存的时间；刚 rotation 过的前缀本来也不会立刻溢出。
  // 硬约束阈值：显式 rotationForceTokens 优先；否则由模型窗口自动推导。
  // 自动推导 = (窗口 − 预留输出) × ROTATION_FORCE_RATIO，
  // 目的是避免手工配置把阈值贴到"压缩能力下限"上（滞回不足会频繁触发紧急通道）。
  const explicitForceTokens = Math.max(0, input.compaction?.rotationForceTokens ?? 0);
  const contextWindowTokens = Math.max(0, input.compaction?.contextWindowTokens ?? 0);
  const reserveOutputTokens = Math.max(0, input.compaction?.reserveOutputTokens ?? 0);
  const rotationForceTokens = explicitForceTokens > 0
    ? explicitForceTokens
    : (contextWindowTokens > 0
      ? Math.max(0,
        Math.floor((contextWindowTokens - reserveOutputTokens) * ROTATION_FORCE_RATIO))
      : 0);
  const rotationForced = rotationForceTokens > 0 && total >= rotationForceTokens;
  // 紧急通道：稀疏化让"阈值刚被突破"时最多等待 rotationAfterRounds 轮，
  // 期间上下文仍在增长；若已超过硬约束的 1.5 倍，说明逼近真实溢出，
  // 不再等待 epoch 年龄，立即强制 rotation（缓存让位于可用性）。
  const rotationEmergency = rotationForceTokens > 0
    && total >= rotationForceTokens * ROTATION_EMERGENCY_FACTOR;
  const rotationEligible = stablePrefixLength === 0
    || rotationEmergency
    || stablePrefixTurns >= rotationAfterRounds;

  // Rotation 经济性门槛（rotationMinSavingsRatio > 0 时启用）：
  // 改写稳定前缀会把"首个被改写点之后的所有内容"从 cache hit 降级为 cache miss（一次性全价），
  // 收益只是此后每轮前缀缩小 Δ（按 hit 价计）。miss 单价是 hit 的 10 倍，
  // 故回本轮次 ≈ 10 × (改写成本 / Δ)。不达标时把本轮 rotation 降级为"保护模式"，
  // 让旧前缀继续吃缓存（同时避免 losslessNormalize 改写前缀内容破坏 block hash）。
  const rotationMinSavingsRatio = input.compaction?.rotationMinSavingsRatio ?? 0;
  const rotationEconomyOk = ((): boolean => {
    if (stablePrefixLength === 0 || rotationMinSavingsRatio <= 0) return true;
    if (rotationForced) return true;
    // 候选：与 clear-middle 相同的选段逻辑（假设无保护时会被清空的中间消息）
    const protectHead = 2;
    const tailCount = Math.max(2, recentKeep);
    const candidates = annotated
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => item.tier === 'history' && !item.dropped
        && item.msg.name !== 'context-summary'
        && item.msg.name !== 'context-archive')
      .slice(protectHead, Math.max(protectHead, annotated.length - tailCount));
    if (candidates.length === 0) return true;
    const estimateSaving = (item: (typeof annotated)[number]): number => {
      const content = messageContentToString(item.msg.content);
      const oldTokens = item.tokens;
      const hint = extractHint(content);
      const placeholder = hint
        ? `[cleared: was ${oldTokens} tok | hint: ${hint}]`
        : `[cleared: was ${oldTokens} tok]`;
      return Math.max(0, oldTokens - countMessageTokens({ ...item.msg, content: placeholder }));
    };
    const estSavings = candidates.reduce((sum, c) => sum + estimateSaving(c.item), 0);
    // 改写成本：首个被改写点之后仍在消息流中的内容，全部会从 hit 变 miss
    const rewriteCost = annotated.slice(candidates[0]!.idx).reduce(
      (sum, it) => sum + (it.dropped ? 0 : it.tokens), 0);
    return rewriteCost > 0 && estSavings >= rotationMinSavingsRatio * rewriteCost;
  })();

  // rotationForceTokens 可能低于 protectionThreshold（highWatermark 的 1.5~3 倍），
  // 此时 "total > protectionThreshold" 不成立会让硬约束失效，故强制时视为已超阈值。
  const overProtectionThreshold = protectionThreshold === undefined
    || rotationForced
    || total > protectionThreshold;
  const protectStablePrefix = stablePrefixLength > 0
    && (!rotationEligible || !rotationEconomyOk || !overProtectionThreshold);

  // 只有超过高水位时才启动有损策略，避免每轮重写稳定前缀。
  // losslessNormalize 也移到此处：虽然归一化本身无损，但改变消息字符内容会改变
  // Provider 的 block hash，导致缓存 miss。未超水位时保持消息原样以最大化缓存命中。
  if (highWatermark && total > highWatermark && input.enableReversible !== false) {
    let changed = false;
    for (let idx = 0; idx < annotated.length; idx++) {
      const item = annotated[idx]!;
      // 稳定前缀保护：跳过已压缩的稳定前缀，避免改变其内容破坏缓存
      if (protectStablePrefix && idx < stablePrefixLength) continue;
      // 跳过系统生成的压缩消息（归一化会改变字符内容，破坏 Provider block hash）
      if (item.msg.name === 'context-summary'
        || item.msg.name === 'context-archive'
        || item.msg.name === 'context-retrieval') continue;
      if (typeof item.msg.content !== 'string') continue;
      const result = losslessNormalize(item.msg.content);
      if (result.saved <= 0) continue;
      item.msg = { ...item.msg, content: result.compressed };
      item.tokens = countMessageTokens(item.msg);
      changed = true;
    }
    if (changed) {
      strategies.push('lossless-normalize');
      total = annotated.reduce((sum, item) => sum + item.tokens, 0);
    }
  }
  if (highWatermark && total > highWatermark && input.summarizer) {
    // 稳定前缀保护模式或已存在压缩标记时跳过 summarize：
    // 1. protectStablePrefix 时全量重压缩未触发，不应重新生成 summary
    // 2. 已有 context-summary 或 context-archive 时重新生成会产生不同文本，破坏前缀缓存
    const hasExistingCompaction = annotated.some((item) =>
      item.msg.name === 'context-summary' || item.msg.name === 'context-archive');
    if (!protectStablePrefix && !hasExistingCompaction) {
      const historyItems = annotated.filter((item) => item.tier === 'history' && !item.dropped);
      if (historyItems.length > recentKeep) {
        const oldItems = historyItems.slice(0, historyItems.length - recentKeep);
        const fn = input.summarizer.fn
          ?? (input.summarizer.config ? createDefaultSummarizer(input.summarizer.config) : undefined);
        if (fn) {
          try {
            const result = await summarizeMessages(oldItems.map((item) => item.msg), fn);
            const summaryMsg = buildSummaryMessage(result.summary);
            const insertAt = annotated.indexOf(oldItems[0]!);
            for (const item of oldItems) item.dropped = true;
            annotated.splice(insertAt, 0, {
              msg: summaryMsg,
              tier: 'history',
              tokens: countMessageTokens(summaryMsg),
              dropped: false,
              originalIndex: oldItems[0]!.originalIndex,
            });
            total = annotated.reduce((sum, item) => item.dropped ? sum : sum + item.tokens, 0);
            strategies.push('summarize');
          } catch {
            strategies.push('summarize-failed');
          }
        }
      }
    }
  }

  if (highWatermark && total > highWatermark && input.enableSemanticFold === true) {
    const historyItems = annotated
      .map((item, idx) => ({ item, idx }))
      .filter(({ item, idx }) => item.tier === 'history' && !item.dropped
        && !(protectStablePrefix && idx < stablePrefixLength)
        && item.msg.name !== 'context-summary'
        && item.msg.name !== 'context-archive');
    const foldable = historyItems
      .slice(0, Math.max(0, historyItems.length - recentKeep))
      .map(({ item }) => ({ item, relevance: relevanceToQuery(item.msg, currentQuery) }))
      .sort((a, b) => a.relevance - b.relevance || a.item.originalIndex - b.item.originalIndex);

    let folded = false;
    for (const { item } of foldable) {
      if (total <= (target() ?? 0)) break;
      if (typeof item.msg.content !== 'string') continue;
      const result = semanticFold(item.msg.content);
      if (result.saved <= 0) continue;
      const next = { ...item.msg, content: result.compressed };
      const nextTokens = countMessageTokens(next);
      total -= item.tokens - nextTokens;
      item.msg = next;
      item.tokens = nextTokens;
      folded = true;
    }
    if (folded) strategies.push('semantic-fold');
  }

  if (highWatermark && total > highWatermark) {
    // 稳定前缀保护：只处理 stablePrefixLength 之后的消息
    // 跳过已压缩的系统消息（context-summary/context-archive），清除它们会丢失摘要信息并破坏前缀
    const historyItems = annotated
      .map((item, idx) => ({ item, idx }))
      .filter(({ item, idx }) => item.tier === 'history' && !item.dropped
        && !(protectStablePrefix && idx < stablePrefixLength)
        && item.msg.name !== 'context-summary'
        && item.msg.name !== 'context-archive');
    const protectHead = 2;
    const tailCount = Math.max(2, recentKeep);
    const middleBase = historyItems.length > protectHead + tailCount
      ? historyItems.slice(protectHead, historyItems.length - tailCount)
      : [];
    // 相关性感知：优先清空与当前 query 最不相关、且更早的中间消息，
    // 保留更多近期/相关上下文，在相同 token 预算下提升回答准确性。
    const middle = [...middleBase].sort((a, b) =>
      (relevanceToQuery(a.item.msg, currentQuery) - relevanceToQuery(b.item.msg, currentQuery))
      || (a.item.originalIndex - b.item.originalIndex)
    );
    // 经济性门槛未达标：本轮 rotation 已降级为保护模式（前缀不改写），仅打标记便于诊断。
    // 硬约束触发时忽略门槛强制 rotation（缓存会断裂，但避免上下文溢出）。
    // rotationEmergency 蕴含 rotationForced 与 rotationEligible，故优先打紧急标记
    if (rotationEmergency) strategies.push('rotation-emergency');
    else if (rotationForced && rotationEligible) strategies.push('rotation-forced-limit');
    else if (!rotationEconomyOk) strategies.push('rotation-deferred-economy');

    let clearedMiddle = false;
    for (const { item } of middle) {
      if (total <= (target() ?? 0)) break;
      if (messageContentToString(item.msg.content).startsWith('[cleared:')) continue;
      const oldTokens = item.tokens;
      const hint = extractHint(messageContentToString(item.msg.content));
      const next = {
        ...item.msg,
        content: hint ? `[cleared: was ${oldTokens} tok | hint: ${hint}]` : `[cleared: was ${oldTokens} tok]`,
      };
      item.msg = next;
      item.tokens = countMessageTokens(next);
      total -= oldTokens - item.tokens;
      clearedMiddle = true;
    }
    if (clearedMiddle) strategies.push('clear-middle');

    // 默认采用软预算：保护区超过预算时不继续破坏近期上下文。
    if (input.hardBudget === true) {
      let droppedOverflow = false;
      for (const { item } of middle) {
        if (total <= (target() ?? 0)) break;
        if (item.dropped || !messageContentToString(item.msg.content).startsWith('[cleared:')) continue;
        item.dropped = true;
        total -= item.tokens;
        droppedOverflow = true;
      }
      if (droppedOverflow) strategies.push('drop-overflow');
    }
    if (total > highWatermark) strategies.push('budget-exceeded-protected');
  }

  const optimizedMessages = annotated.filter((item) => !item.dropped).map((item) => item.msg);
  const optimizedTokens = countMessagesTokens(optimizedMessages);
  const cacheHit = input.previousMessages
    ? estimateCacheHit(optimizedMessages, input.previousMessages)
    : { hitTokens: 0, hitRate: 0, firstDiffIndex: 0 };
  if (cacheHit.hitTokens > 0) strategies.push('cache-hit-estimate');

  return {
    messages: optimizedMessages,
    stats: {
      originalTokens,
      optimizedTokens,
      savedTokens: Math.max(0, originalTokens - optimizedTokens),
      cacheHitTokens: cacheHit.hitTokens,
      cacheHitRate: cacheHit.hitRate,
      compressionRatio: originalTokens > 0 ? optimizedTokens / originalTokens : 1,
      strategies: [...new Set(strategies)],
      retrievedTokens: retrievalResult.tokens,
      retrievedItems: retrievalResult.selected,
      budgetExceeded: budget !== undefined && optimizedTokens > budget,
      archivedModules: archiveResult.archivedModules,
      archivedMessages: archiveResult.archivedMessages,
    },
  };
}
