import { Hono } from 'hono';
import type { Message, EngineStats, SummarizerOptions, RetrievalOptions, EmbedFn } from '@context/engine';
import { runEngine, anthropicToMessages, messagesToAnthropic } from '@context/engine';
import { ModuleTracker, ArchiveStore, ArchiveRetriever, createEmbedder } from '@context/engine';
import type { AnthropicRequestBody } from '@context/engine';
import { createHash } from 'node:crypto';

export interface ArchiveConfig {
  topicSwitchThreshold: number;
  archiveDelayRounds: number;
  embedFn?: EmbedFn;  // 可选，提供时启用向量混合检索
}

export interface ProxyConfig {
  port: number;
  upstream: string;           // OpenAI 上游
  anthropicUpstream?: string; // Anthropic 上游，如 https://api.anthropic.com
  budget: number;             // token 预算，0 表示不裁剪
  enableReversible: boolean;
  enableSemanticFold?: boolean;
  log: boolean;
  // 摘要压缩配置（可选）
  summarizer?: SummarizerOptions;
  retrieval?: RetrievalOptions;
  // 归档配置（可选，提供时启用 Archival Memory）
  archive?: ArchiveConfig;
}

interface SessionState {
  rawMessages: Message[];
  optimizedMessages: Message[];
  durableMessages: Message[];
  epoch: number;
  turn: number;
  moduleTracker?: ModuleTracker;
  archiveStore?: ArchiveStore;
  archiveRetriever?: ArchiveRetriever;
}

// 每个 epoch 内复用上一轮已经压缩的稳定前缀，只处理新追加的消息。
const sessionStore = new Map<string, SessionState>();
const MAX_SESSIONS = 100;

// 累计统计（进程生命周期内）
interface SessionStats {
  totalRequests: number;
  totalOriginalTokens: number;
  totalOptimizedTokens: number;
  totalSavedTokens: number;
  totalSavedCost: number; // USD
}
const cumulative = { totalRequests: 0, totalOriginalTokens: 0, totalOptimizedTokens: 0, totalSavedTokens: 0, totalSavedCost: 0 };

function getSessionId(auth: string, explicit?: string): string {
  if (explicit) return explicit.slice(0, 128);
  if (!auth) return 'anonymous';
  return createHash('sha256').update(auth).digest('hex').slice(0, 24);
}

function messagesEqual(a: Message, b: Message): boolean {
  return a.role === b.role
    && a.name === b.name
    && a.tool_call_id === b.tool_call_id
    && JSON.stringify(a.content) === JSON.stringify(b.content);
}

function isMessagePrefix(prefix: Message[], current: Message[]): boolean {
  return prefix.length <= current.length
    && prefix.every((message, index) => messagesEqual(message, current[index]!));
}

function prepareEpochInput(rawMessages: Message[], previous?: SessionState): {
  engineMessages: Message[];
  previousOptimized?: Message[];
  stablePrefixLength: number;
  epoch: number;
} {
  if (!previous || !isMessagePrefix(previous.rawMessages, rawMessages)) {
    return {
      engineMessages: rawMessages,
      previousOptimized: undefined,
      stablePrefixLength: 0,
      epoch: previous ? previous.epoch + 1 : 0,
    };
  }
  return {
    engineMessages: [
      ...previous.durableMessages,
      ...rawMessages.slice(previous.rawMessages.length),
    ],
    previousOptimized: previous.optimizedMessages,
    stablePrefixLength: previous.durableMessages.length,
    epoch: previous.epoch,
  };
}

// 获取或创建 session，初始化归档组件（每个 session 独立持有状态）
function getOrCreateSession(sessionId: string, config: ProxyConfig): SessionState {
  const existing = sessionStore.get(sessionId);
  if (existing) return existing;

  const session: SessionState = {
    rawMessages: [],
    optimizedMessages: [],
    durableMessages: [],
    epoch: 0,
    turn: 0,
  };

  if (config.archive) {
    session.moduleTracker = new ModuleTracker({
      topicSwitchThreshold: config.archive.topicSwitchThreshold,
      archiveDelayRounds: config.archive.archiveDelayRounds,
      highWatermarkTokens: config.budget > 0 ? config.budget * 1.5 : 10000,
    });
    session.archiveStore = new ArchiveStore(config.archive.embedFn);
    session.archiveRetriever = new ArchiveRetriever(session.archiveStore, {
      topK: 4,
      minScore: 0.01,
      topicGateThreshold: 0.10,
      maxTokens: Math.max(256, Math.floor(config.budget * 0.15)),
    });
  }

  sessionStore.set(sessionId, session);
  if (sessionStore.size > MAX_SESSIONS) {
    const firstKey = sessionStore.keys().next().value;
    if (firstKey) sessionStore.delete(firstKey);
  }
  return session;
}

function isCompactionStrategy(strategies: string[]): boolean {
  return strategies.some((strategy) =>
    ['summarize', 'semantic-fold', 'clear-middle', 'clear-tail', 'drop-overflow'].includes(strategy)
  );
}

// ANSI 颜色
const C = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

// 模型定价（USD / 1M tokens，input 价格）
const PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model] || PRICING['gpt-4o-mini']!;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

function formatUSD(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatStats(stats: EngineStats, model: string): string {
  const savedPct = stats.originalTokens > 0
    ? ((stats.savedTokens / stats.originalTokens) * 100).toFixed(1)
    : '0.0';
  const hitPct = (stats.cacheHitRate * 100).toFixed(1);
  const ratio = (stats.compressionRatio * 100).toFixed(0);

  // 成本估算：节省的 input token 对应的费用
  const savedCost = estimateCost(model, stats.savedTokens, 0);

  // cache hit 高亮：>50% 绿色，>0 黄色，0 红色
  const cacheLabel = stats.cacheHitTokens > 0
    ? (stats.cacheHitRate > 0.5
        ? `${C.green}cache_hit ${hitPct}%${C.reset} ${C.gray}(${stats.cacheHitTokens} tok)${C.reset}`
        : `${C.yellow}cache_hit ${hitPct}%${C.reset} ${C.gray}(${stats.cacheHitTokens} tok)${C.reset}`)
    : `${C.red}cache_miss${C.reset}`;

  // 压缩箭头颜色：节省 >30% 用绿色加粗
  const arrowColor = stats.savedTokens / Math.max(stats.originalTokens, 1) > 0.3
    ? C.green + C.bold
    : C.bold;

  return [
    `${C.cyan}[context]${C.reset}`,
    `${C.bold}${stats.originalTokens}${C.reset} ${C.dim}→${C.reset} ${arrowColor}${stats.optimizedTokens}${C.reset} ${C.gray}tok${C.reset}`,
    `${C.gray}saved ${C.green}${savedPct}%${C.reset}${C.gray} (ratio ${ratio}%)${C.reset}`,
    savedCost > 0 ? `${C.magenta}${formatUSD(savedCost)}${C.reset} ${C.gray}saved${C.reset}` : '',
    cacheLabel,
    `${C.gray}[${stats.strategies.join(',')}]${C.reset}`,
  ].filter(Boolean).join(' ');
}

function formatCumulative(): string {
  if (cumulative.totalRequests === 0) return '';
  const avgPct = cumulative.totalOriginalTokens > 0
    ? ((cumulative.totalSavedTokens / cumulative.totalOriginalTokens) * 100).toFixed(1)
    : '0.0';
  return `${C.gray}cumulative: ${cumulative.totalRequests} reqs, ${cumulative.totalSavedTokens} tok saved (${avgPct}%), ${formatUSD(cumulative.totalSavedCost)}${C.reset}`;
}

function updateCumulative(stats: EngineStats, model: string): void {
  cumulative.totalRequests++;
  cumulative.totalOriginalTokens += stats.originalTokens;
  cumulative.totalOptimizedTokens += stats.optimizedTokens;
  cumulative.totalSavedTokens += stats.savedTokens;
  cumulative.totalSavedCost += estimateCost(model, stats.savedTokens, 0);
}

// 转发请求头（白名单）
function forwardHeaders(rawHeaders: Headers): Headers {
  const headers = new Headers();
  const allow = ['authorization', 'content-type', 'user-agent', 'accept'];
  for (const [key, value] of rawHeaders.entries()) {
    if (allow.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  headers.set('content-type', 'application/json');
  return headers;
}

export function createServer(config: ProxyConfig): Hono {
  const app = new Hono();

  // 健康检查
  app.get('/healthz', (c) => c.json({ ok: true, version: '0.1.0' }));

  // 统计端点
  app.get('/stats', (c) => {
    return c.json({
      sessions: sessionStore.size,
      upstream: config.upstream,
      budget: config.budget,
      cumulative: {
        requests: cumulative.totalRequests,
        originalTokens: cumulative.totalOriginalTokens,
        optimizedTokens: cumulative.totalOptimizedTokens,
        savedTokens: cumulative.totalSavedTokens,
        savedCostUSD: cumulative.totalSavedCost,
        avgSavingPct: cumulative.totalOriginalTokens > 0
          ? (cumulative.totalSavedTokens / cumulative.totalOriginalTokens) * 100
          : 0,
      },
    });
  });

  // OpenAI 兼容：POST /v1/chat/completions
  app.post('/v1/chat/completions', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }

    if (!Array.isArray(body?.messages)) {
      return c.json({ error: 'missing messages field' }, 400);
    }

    const auth = c.req.header('authorization') || '';
    const sessionId = getSessionId(auth, c.req.header('x-context-session-id') || body.user);
    const session = getOrCreateSession(sessionId, config);
    session.turn++;
    const rawMessages = body.messages as Message[];
    const epochInput = prepareEpochInput(rawMessages, session);

    // 调 engine 改写 messages（接入归档系统、稳定前缀保护、compaction hysteresis）
    const { messages: optimized, stats } = await runEngine({
      messages: epochInput.engineMessages,
      baselineMessages: rawMessages,
      model: body.model || 'unknown',
      budget: config.budget > 0 ? config.budget : undefined,
      enableReversible: config.enableReversible,
      enableSemanticFold: config.enableSemanticFold,
      previousMessages: epochInput.previousOptimized,
      stablePrefixLength: epochInput.stablePrefixLength,
      compaction: config.budget > 0 ? {
        highWatermark: config.budget,
        lowWatermark: Math.floor(config.budget * 0.7),
      } : undefined,
      ...(session.moduleTracker && session.archiveStore && session.archiveRetriever ? {
        archive: {
          moduleTracker: session.moduleTracker,
          archiveStore: session.archiveStore,
          retriever: session.archiveRetriever,
          enableSummary: !!config.summarizer,
        },
      } : {}),
      currentTurn: session.turn,
      summarizer: config.summarizer,
      retrieval: config.retrieval,
    });

    if (config.log) {
      const model = body.model || 'unknown';
      updateCumulative(stats, model);
      console.log(formatStats(stats, model));
      console.log(formatCumulative());
    }

    // 更新 session（保存本轮 messages 供下轮对比，保留归档组件状态）
    session.rawMessages = structuredClone(rawMessages);
    session.optimizedMessages = structuredClone(optimized);
    session.durableMessages = structuredClone(optimized.filter((message) => message.name !== 'context-retrieval'));
    session.epoch = epochInput.epoch + (isCompactionStrategy(stats.strategies) ? 1 : 0);

    // 构造新 body
    const newBody = { ...body, messages: optimized };

    // 转发到上游
    const upstreamUrl = `${config.upstream}/v1/chat/completions`;
    const upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: forwardHeaders(c.req.raw.headers),
      body: JSON.stringify(newBody),
    });

    // 透传 response（支持 streaming SSE）
    const respHeaders = new Headers();
    const passThrough = ['content-type', 'x-request-id', 'openai-organization', 'openai-processing-ms'];
    for (const [key, value] of upstreamResp.headers.entries()) {
      if (passThrough.includes(key.toLowerCase())) {
        respHeaders.set(key, value);
      }
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  });

  // Anthropic 兼容：POST /v1/messages
  app.post('/v1/messages', async (c) => {
    if (!config.anthropicUpstream) {
      return c.json({ error: 'Anthropic upstream not configured. Use --anthropic-upstream.' }, 501);
    }

    let body: AnthropicRequestBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }

    if (!Array.isArray(body?.messages)) {
      return c.json({ error: 'missing messages field' }, 400);
    }

    // Anthropic → 内部 Message[]
    const internalMessages = anthropicToMessages(body);

    const auth = c.req.header('x-api-key') || c.req.header('authorization') || '';
    const sessionId = `anthropic:${getSessionId(auth, c.req.header('x-context-session-id'))}`;
    const session = getOrCreateSession(sessionId, config);
    session.turn++;
    const epochInput = prepareEpochInput(internalMessages, session);

    // 调 engine 改写（接入归档系统、稳定前缀保护、compaction hysteresis）
    const { messages: optimized, stats } = await runEngine({
      messages: epochInput.engineMessages,
      baselineMessages: internalMessages,
      model: body.model || 'unknown',
      budget: config.budget > 0 ? config.budget : undefined,
      enableReversible: config.enableReversible,
      enableSemanticFold: config.enableSemanticFold,
      previousMessages: epochInput.previousOptimized,
      stablePrefixLength: epochInput.stablePrefixLength,
      compaction: config.budget > 0 ? {
        highWatermark: config.budget,
        lowWatermark: Math.floor(config.budget * 0.7),
      } : undefined,
      ...(session.moduleTracker && session.archiveStore && session.archiveRetriever ? {
        archive: {
          moduleTracker: session.moduleTracker,
          archiveStore: session.archiveStore,
          retriever: session.archiveRetriever,
          enableSummary: !!config.summarizer,
        },
      } : {}),
      currentTurn: session.turn,
      summarizer: config.summarizer,
      retrieval: config.retrieval,
    });

    if (config.log) {
      const model = body.model || 'unknown';
      updateCumulative(stats, model);
      console.log(formatStats(stats, model));
      console.log(formatCumulative());
    }

    // 更新 session（保存本轮 messages 供下轮对比，保留归档组件状态）
    session.rawMessages = structuredClone(internalMessages);
    session.optimizedMessages = structuredClone(optimized);
    session.durableMessages = structuredClone(optimized.filter((message) => message.name !== 'context-retrieval'));
    session.epoch = epochInput.epoch + (isCompactionStrategy(stats.strategies) ? 1 : 0);

    // 内部 Message[] → Anthropic 格式（带 cache_control 断点）
    const { system, messages: anthropicMessages } = messagesToAnthropic(optimized);

    // 构造新 body
    const newBody: AnthropicRequestBody = {
      ...body,
      messages: anthropicMessages,
    };
    if (system !== undefined) {
      newBody.system = system;
    }

    // 转发到 Anthropic 上游（注意认证头差异）
    const upstreamUrl = `${config.anthropicUpstream}/v1/messages`;
    const fwdHeaders = new Headers();
    fwdHeaders.set('content-type', 'application/json');
    // Anthropic 用 x-api-key 认证，需透传
    const apiKey = c.req.header('x-api-key');
    if (apiKey) fwdHeaders.set('x-api-key', apiKey);
    const anthropicVersion = c.req.header('anthropic-version');
    if (anthropicVersion) fwdHeaders.set('anthropic-version', anthropicVersion);

    const upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: fwdHeaders,
      body: JSON.stringify(newBody),
    });

    // 透传响应
    const respHeaders = new Headers();
    const passThrough = ['content-type', 'x-request-id', 'request-id'];
    for (const [key, value] of upstreamResp.headers.entries()) {
      if (passThrough.includes(key.toLowerCase())) {
        respHeaders.set(key, value);
      }
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  });

  // 兜底：其他路径直接透传（如 /v1/embeddings）
  app.all('*', async (c) => {
    const url = `${config.upstream}${c.req.path}`;
    const headers = forwardHeaders(c.req.raw.headers);
    const init: RequestInit = {
      method: c.req.method,
      headers,
    };
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      init.body = await c.req.raw.text();
    }
    const resp = await fetch(url, init);
    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  });

  return app;
}
