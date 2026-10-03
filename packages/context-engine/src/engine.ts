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

  // 处理每个待归档模块
  let archivedModules = 0;
  let archivedMessages = 0;
  const messagesToReplace = new Set<number>();
  const archiveInsertions: Array<{ insertAt: number; msg: Message }> = [];

  for (const module of observeResult.modulesToArchive) {
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
  // 当 stablePrefixLength > 0（调用方传入上一轮压缩后的稳定前缀长度）且未超硬上限时，
  // 跳过稳定前缀部分，只允许压缩新增消息。这样前缀保持逐字一致，Provider 缓存可命中。
  // 只有超过硬上限（highWatermark * 1.5）时才全量重压缩，生成新的稳定前缀。
  // 已有 context-archive 消息时，将保护阈值提高到 hardLimit * 2，
  // 让首次归档后的稳定前缀能持续命中缓存（clear-middle 只处理新增消息）。
  const stablePrefixLength = input.stablePrefixLength ?? 0;
  const hardLimit = highWatermark ? Math.floor(highWatermark * 1.5) : undefined;
  const hasExistingArchiveInWorking = workingMessages.some((m) => m.name === 'context-archive');
  const protectionThreshold = hasExistingArchiveInWorking && hardLimit
    ? hardLimit * 2
    : hardLimit;
  const protectStablePrefix = stablePrefixLength > 0
    && (protectionThreshold === undefined || total <= protectionThreshold);

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
