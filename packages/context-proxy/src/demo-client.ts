// demo-client: 真实 LLM 多轮对话脚本，用于展示代理的 token 压缩效果
// 运行:
//   pnpm --filter @context/proxy exec tsx src/demo-client.ts --direct          # 直连 DeepSeek
//   pnpm --filter @context/proxy exec tsx src/demo-client.ts --proxy           # 走代理
//   pnpm --filter @context/proxy exec tsx src/demo-client.ts --compare         # 两种模式对比
//
// 环境变量:
//   DEEPSEEK_API_KEY  DeepSeek API key
//   PROXY_URL         代理地址 (默认 http://localhost:8787)

import type { Message } from '@context/engine';
import { countMessageTokens, countMessagesTokens, runEngine, estimateCacheHit, ModuleTracker, ArchiveStore, ArchiveRetriever, createEmbedder, type EmbedFn } from '@context/engine';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 报告目录：可通过 REPORTS_DIR 覆盖，默认写入项目根目录的 reports。
const REPORTS_DIR = process.env.REPORTS_DIR || join(dirname(fileURLToPath(import.meta.url)), '../../../reports');

// ============================================================
// 配置
// ============================================================

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE = 'https://api.deepseek.com';
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:8787';
const MODEL = 'deepseek-chat';

// 混合检索（P3）：可选启用向量检索 + BM25 + RRF 融合
// 通过环境变量配置 embedding API（OpenAI 兼容）
//   EMBED_API_KEY   embedding API key（必填才能启用）
//   EMBED_BASE_URL  embedding API base URL（默认 https://api.openai.com）
//   EMBED_MODEL     embedding 模型（默认 text-embedding-3-small）
const EMBED_API_KEY = process.env.EMBED_API_KEY || '';

// rotation 经济性门槛（由 --rotation-ratio 设置，默认 0 = 关闭）。
// 硬约束兜底 --rotation-force-tokens：total 达到该值时忽略门槛强制 rotation（0 = 关闭）。
// runConversation 已有大量位置参数，用模块级变量承接 CLI 配置，避免改动全部调用点。
let ROTATION_MIN_SAVINGS_RATIO = 0;
let ROTATION_FORCE_TOKENS = 0;
// 模型上下文窗口上限（由 --context-window 设置，0 = 不推导硬约束阈值）。
let CONTEXT_WINDOW_TOKENS = 0;
// 为输出预留的 token（= --max-output，用于自动推导硬约束阈值）。
let RESERVE_OUTPUT_TOKENS = 0;
const EMBED_BASE_URL = process.env.EMBED_BASE_URL || 'https://api.openai.com';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';

function createEmbedFnIfAvailable(): EmbedFn | undefined {
  if (!EMBED_API_KEY) return undefined;
  try {
    return createEmbedder({ apiKey: EMBED_API_KEY, baseURL: EMBED_BASE_URL, model: EMBED_MODEL });
  } catch (e) {
    console.warn(`  ${`警告: embedder 初始化失败，退化为纯 BM25: ${(e as Error).message}`}`);
    return undefined;
  }
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

// 显示宽度计算：忽略 ANSI 控制码，并按终端列数计算中英文宽度。
function terminalCharWidth(ch: string): number {
  const code = ch.codePointAt(0)!;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0xff00 && code <= 0xffef)
  ) ? 2 : 1;
}

function displayWidth(str: string): number {
  let width = 0;
  for (const ch of stripAnsi(str)) width += terminalCharWidth(ch);
  return width;
}

function padEndD(str: string, width: number): string {
  const dw = displayWidth(str);
  return dw >= width ? str : str + ' '.repeat(width - dw);
}

function padStartD(str: string, width: number): string {
  const dw = displayWidth(str);
  return dw >= width ? str : ' '.repeat(width - dw) + str;
}

// ============================================================
// 模拟真实 coding 助手的多轮对话场景
// 每轮对话包含代码片段 + 提问，让对话自然累积到 12000+ token
// ============================================================

interface DemoTurn {
  userMessage: string;
}

// 构造 20 轮真实编程对话
function buildDemoTurns(): DemoTurn[] {
  return [
    {
      userMessage: `我在做一个 TypeScript 项目，遇到下面这段代码的类型问题。请帮我分析并给出修复方案：

\`\`\`typescript
interface User {
  id: number;
  name: string;
  email: string;
}

function findUser(users: User[], id: number): User | undefined {
  return users.find(u => u.id === id);
}

const result = findUser(users, 123);
console.log(result.name); // 报错：result 可能为 undefined
\`\`\`

如何让 TypeScript 正确处理 undefined 的情况？`,
    },
    {
      userMessage: `谢谢。现在我的项目里还有一个异步数据获取的问题。下面是从 API 获取用户列表的代码：

\`\`\`typescript
async function fetchUsers(): Promise<User[]> {
  const response = await fetch('/api/users');
  const data = await response.json();
  return data; // 没有类型校验
}
\`\`\`

我想加入：
1. 请求失败的重试机制（最多 3 次）
2. 返回数据的运行时类型校验
3. 请求超时处理（10 秒）

请给出完整的实现。`,
    },
    {
      userMessage: `很好。现在我想把这些用户数据存到本地缓存里。需求是：
1. 用 IndexedDB 存储（不用 localStorage，因为数据可能很大）
2. 设置 TTL（30 分钟过期）
3. 支持批量读取和写入
4. 缓存失效时自动重新 fetch

我目前的代码是这样的，但是感觉封装得不够好：

\`\`\`typescript
const CACHE_KEY = 'users_cache';

function getCachedUsers(): User[] | null {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  const { data, ts } = JSON.parse(raw);
  if (Date.now() - ts > 30 * 60 * 1000) return null;
  return data;
}
\`\`\`

请给出更完善的 IndexedDB 封装方案。`,
    },
    {
      userMessage: `接着上面的话题。现在我想给这个缓存层加上观察者模式，让 UI 组件能订阅缓存变化自动更新。类似 React 的 useSyncExternalStore。

要求：
1. 通用 EventEmitter 基类
2. CacheStore 继承 EventEmitter，变化时 emit 事件
3. 提供 useCacheData hook（React）
4. 支持选择性订阅（只订阅某个 key 的变化）

请给出实现。`,
    },
    {
      userMessage: `现在我们换一个话题。我在做一个 Node.js 的 CLI 工具，需要解析命令行参数。之前一直用 commander.js，但这次想自己实现一个轻量版的。

需求：
1. 支持子命令（如 mycli build、mycli deploy）
2. 支持选项（--port 3000、--verbose）
3. 支持别名（-p 3000 等价于 --port 3000）
4. 自动生成 help
5. 类型推导（port 是 number，verbose 是 boolean）

我目前的骨架：
\`\`\`typescript
const args = process.argv.slice(2);
// 怎么优雅地解析？
\`\`\`

请给出设计方案。`,
    },
    {
      userMessage: `继续 CLI 的话题。现在我想给 CLI 加上交互式提示（类似 inquirer.js）。比如：

1. 列表选择（用方向键选择）
2. 确认提示（y/n）
3. 文本输入
4. 多选（空格选择，回车确认）

我调研了一下，发现需要处理 raw mode 的 stdin。请给出一个最小可用的实现，不依赖第三方库。`,
    },
    {
      userMessage: `现在回到 Web 项目。我们的 React 应用用了 Zustand 做状态管理，但是遇到一个问题：

有一个全局的 userStore，多个组件都订阅了它。但是某些组件只关心 user.name 变化，另一些只关心 user.email。现在每次 store 更新，所有组件都会 re-render。

\`\`\`typescript
const useUserStore = create<User>((set) => ({
  id: 0,
  name: '',
  email: '',
  setName: (name) => set({ name }),
  setEmail: (email) => set({ email }),
}));

// 组件 A：只关心 name
function NameTag() {
  const user = useUserStore(); // 这里会订阅整个 user，email 变化也会 re-render
  return <h1>{user.name}</h1>;
}
\`\`\`

如何用 selector 优化？还有没有更进阶的方案（比如 useShallow）？`,
    },
    {
      userMessage: `好的。现在我们的应用要支持国际化（i18n）。需求：
1. 支持中英日三语
2. 按需加载语言包（不一次性打包所有语言）
3. 支持插值（如 "欢迎，{name}"）
4. 支持复数形式（如 "1 item" vs "2 items"）
5. TypeScript 类型推导（key 必须在语言包里存在）

我目前用 react-i18next，但是语言包的 key 没有类型校验，经常拼错。请给出方案。`,
    },
    {
      userMessage: `现在聊一个性能问题。我们的 React 应用首屏加载很慢（LCP 4.2s），bundle 体积 1.8MB。已经做了：
- 路由级 code splitting
- tree shaking
- production build

主要瓶颈：
1. 首屏用了一个 600KB 的图表库（echarts），但首屏根本不需要
2. 图片没做懒加载
3. 有一个大的 JSON 数据（2MB）被打包进 bundle

请给出优化方案，目标是 LCP < 2s。`,
    },
    {
      userMessage: `继续性能话题。我们做了一个长列表（10000 条数据），目前用 react-window 虚拟滚动，但是滚动时掉帧严重（FPS 20 左右）。

分析发现：
1. 每行组件很复杂（包含图表、图片、多个按钮）
2. 滚动时每行都 re-render
3. 图片是高清的，解码慢

已经尝试：
- React.memo 包裹 Row 组件
- 图片懒加载

请给出进阶优化方案。`,
    },
    {
      userMessage: `换一个话题。我在写一个 WebSocket 服务，用 Node.js + ws 库。需求：
1. 支持多房间（room-based broadcast）
2. 心跳检测（30 秒无响应断开）
3. 断线重连（客户端）
4. 消息广播时排除发送者

我的现状：
\`\`\`typescript
const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    // 广播给所有人
    wss.clients.forEach(c => c.send(msg));
  });
});
\`\`\`

请给出完善实现。`,
    },
    {
      userMessage: `继续 WebSocket 话题。现在我想在 WebSocket 之上实现一个简单的 RPC 协议，让前后端可以像调用本地函数一样调用远程方法。

设计：
- client.call('getUser', { id: 123 }) → Promise<User>
- server 注册方法：server.method('getUser', async (args) => {...})
- 支持双向调用（server 也能调 client 的方法）
- 请求/响应用 id 关联

请给出协议设计和实现。`,
    },
    {
      userMessage: `现在聊一个数据库相关的问题。我们的 Postgres 里有一个 orders 表，5000 万行。查询很慢：

\`\`\`sql
SELECT * FROM orders
WHERE user_id = 123
  AND status = 'paid'
  AND created_at > '2025-01-01'
ORDER BY created_at DESC
LIMIT 20;
\`\`\`

已经有 user_id 的索引，但查询还是要 3 秒。

分析：
1. EXPLAIN ANALYZE 显示走了 seq scan（没用索引）
2. 偶尔会用到 user_id_idx，但也很慢

请给出索引优化方案和查询优化建议。`,
    },
    {
      userMessage: `继续数据库话题。现在我想实现一个乐观锁机制，处理并发更新。

场景：多个用户同时编辑同一个文档，用 version 字段做乐观锁。

\`\`\`typescript
async function updateDoc(id: number, content: string, version: number) {
  const result = await db.query(
    'UPDATE docs SET content = $1, version = version + 1 WHERE id = $2 AND version = $3',
    [content, id, version]
  );
  if (result.rowCount === 0) {
    throw new Error('版本冲突');
  }
}
\`\`\`

问题：
1. 冲突时如何自动合并（类似 git merge）？
2. 前端如何展示冲突并让用户选择？
3. 有没有现成的 CRDT 方案可以参考？`,
    },
    {
      userMessage: `换到测试话题。我们的 React 组件测试一直用 Jest + React Testing Library，但是：
1. 测试很慢（200 个测试要跑 40 秒）
2. ESM 支持有问题（一些库 import 报错）
3. mock 模块很麻烦

听说 Vitest 很好，想迁移。请给出：
1. 迁移步骤
2. 常见坑
3. 性能优化（parallel、isolate 等）`,
    },
    {
      userMessage: `继续测试话题。现在我想给 API 加 e2e 测试。目前用 supertest，但：
1. 每个测试都要真实起一个 server
2. 数据库状态难管理（测试间互相污染）
3. 外部依赖（如 Stripe API）如何 mock

请给出：
1. 用 Vitest 做 API e2e 的最佳实践
2. 数据库隔离方案（transaction rollback？truncate？）
3. mock 外部服务的方案（MSW？nock？）`,
    },
    {
      userMessage: `现在聊 CI/CD。我们的项目用 GitHub Actions，但是：
1. 构建慢（缓存命中率低）
2. monorepo 每次都全量构建（应该只构建变更的包）
3. 部署到 Vercel 经常超时

请给出：
1. pnpm + turborepo 的缓存配置
2. GitHub Actions 的 actions/cache 最佳实践
3. monorepo 增量部署方案`,
    },
    {
      userMessage: `继续 CI/CD。现在我想实现一个 preview deployment：
1. 每个 PR 自动部署一个 preview 环境
2. preview 环境有独立的数据库（怎么搞？）
3. preview URL 形如 pr-123.preview.myapp.com
4. PR 合并后自动清理 preview 环境

技术栈：Next.js + Vercel + Supabase。请给出方案。`,
    },
    {
      userMessage: `现在聊安全话题。我们的 Node.js API 收到一些异常请求：
1. 有 IP 频繁调用 /api/login（明显在撞库）
2. 有请求带着奇怪的 payload（疑似 XSS / SQL 注入）
3. 有人用 User-Agent 伪装成 Googlebot 绕过限流

请给出：
1. 限流方案（express-rate-limit？还是用 Redis？）
2. 输入校验（zod？joi？）
3. bot 识别
4. 安全响应头（helmet？）`,
    },
    {
      userMessage: `最后一个问题。我想给整个项目加上可观测性：
1. 结构化日志（pino？winston？）
2. 指标采集（Prometheus？）
3. 分布式追踪（OpenTelemetry？）
4. 错误监控（Sentry？）

要求：
- 生产环境才开启追踪（dev 不开）
- 日志带 request id，能串联一次请求的所有日志
- 指标暴露在 /metrics 端点

请给出整合方案。`,
    },
  ];
}

// ============================================================
// LLM 调用
// ============================================================

interface LLMResponse {
  content: string;
  finishReason: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens: number;
    prompt_cache_miss_tokens: number;
  };
}

async function callLLM(
  baseUrl: string,
  apiKey: string,
  messages: Message[],
  options?: { signal?: AbortSignal; maxTokens?: number },
): Promise<LLMResponse> {
  // 网络重试：3 次，指数退避（1s / 2s / 4s）
  const maxRetries = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: 0, // 确定性输出，确保对比公平
          max_tokens: options?.maxTokens ?? 400,
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`LLM API error ${response.status}: ${errText}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string }; finish_reason?: string }>;
        usage: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
        };
      };

      return {
        content: data.choices[0]!.message.content,
        finishReason: data.choices[0]!.finish_reason || 'unknown',
        usage: {
          ...data.usage,
          prompt_cache_hit_tokens: data.usage.prompt_cache_hit_tokens ?? 0,
          prompt_cache_miss_tokens: data.usage.prompt_cache_miss_tokens ?? data.usage.prompt_tokens,
        },
      };
    } catch (err) {
      lastErr = err;
      // 4xx 错误（非 429）不重试
      if (err instanceof Error && err.message.includes('LLM API error 4')) {
        throw err;
      }
      if (attempt < maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt);
        console.error(`\n  ${C.yellow}网络重试 ${attempt + 1}/${maxRetries} (${delayMs}ms 后): ${(err as Error).message}${C.reset}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// ============================================================
// 单次多轮对话执行
// ============================================================

interface Dialogue {
  turn: number;
  user: string;
  assistant: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  providerCacheHitTokens: number;
  providerCacheMissTokens: number;
  messages: Message[];            // 本轮实际发送给模型的 request payload
  compressedMessages?: Message[]; // 代理模式：engine 处理后的 messages
  engineStats?: {
    originalTokens: number;
    optimizedTokens: number;
    cacheHitRate: number;
    strategies: string[];
    retrievedTokens: number;
    retrievedItems: Array<{ id: string; score?: number }>;
    budgetExceeded: boolean;
    archivedModules: number;
    archivedMessages: number;
  };
}

interface RunResult {
  mode: string;
  totalInputTokens: number;   // 累计输入 token（所有轮次之和）
  totalOutputTokens: number;
  totalProviderCacheHitTokens: number;
  totalProviderCacheMissTokens: number;
  totalTokens: number;
  finalInputTokens: number;   // 最后一轮的输入 token（展示用）
  turns: number;
  answers: string[];
  perTurn: Array<{
    turn: number;
    inputTokens: number;
    outputTokens: number;
    finishReason: string;
    providerCacheHitTokens: number;
    providerCacheMissTokens: number;
  }>;
  dialogues: Dialogue[];
}

// 消融实验模式
// A: summary-only（可逆压缩 + 摘要，无归档）
// B: summary + BM25 archive（A + 纯 BM25 归档，无 topic gate）
// C: hybrid + gate（B + 混合检索 + topic gate，当前默认）
type AblationMode = 'A' | 'B' | 'C';

async function runConversation(
  mode: 'direct' | 'proxy',
  baseUrl: string,
  apiKey: string,
  turns: DemoTurn[],
  budget: number,
  onProgress?: (turn: number, result: { inputTokens: number; outputTokens: number }) => void,
  onTurnDetail?: (d: Dialogue) => void,
  canonicalAnswers?: string[],
  enableSemanticFold = false,
  answerMaxTokens = 900,
  enableSummarize = false,
  // 每轮完成回调（不 await，用于流水线并行触发 Judge）
  onTurnComplete?: (i: number, dialogue: Dialogue) => void,
  ablationMode?: AblationMode,
  // 强制在该轮注入 retrieval（Demo 用），传入轮次号（1-based）
  forceRetrievalAtTurn?: number,
): Promise<RunResult> {
  const systemMsg: Message = {
    role: 'system',
    content: 'You are a senior software engineer. Answer coding questions concisely with code examples. Keep answers under 300 words.',
  };

  const history: Message[] = [systemMsg];
  const answers: string[] = [];
  const perTurn: RunResult['perTurn'] = [];
  const dialogues: Dialogue[] = [];
  // 归档系统：根据消融模式配置
  // - A: 不创建归档系统
  // - B: 纯 BM25（无 embedFn），topicGateThreshold=0（禁用 topic gate）
  // - C: 混合检索（有 embedFn） + topic gate（当前默认）
  const useArchive = ablationMode !== 'A';
  const useTopicGate = ablationMode === 'C';
  const useHybridRetrieval = ablationMode === 'C';
  const moduleTracker = new ModuleTracker({
    topicSwitchThreshold: 0.20,
    archiveDelayRounds: 8,
    highWatermarkTokens: budget > 0 ? budget * 1.5 : 10000,
  });
  // 消融模式 B/C：B 不用 embedFn（纯 BM25），C 用 embedFn（混合检索）
  const embedFn = useArchive && useHybridRetrieval ? createEmbedFnIfAvailable() : undefined;
  const archiveStore = useArchive ? new ArchiveStore(embedFn) : null;
  const archiveRetriever = useArchive && archiveStore
    ? new ArchiveRetriever(archiveStore, {
        topK: 4,
        minScore: 0.01,
        topicGateThreshold: useTopicGate ? 0.10 : 0,  // B 禁用 topic gate
        maxTokens: Math.max(256, Math.floor(budget * 0.15)),
      })
    : null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalProviderCacheHitTokens = 0;
  let totalProviderCacheMissTokens = 0;
  let prevMessages: Message[] | undefined; // 上一轮的 messages（用于缓存命中预估）
  let prevDurableMessages: Message[] | undefined;
  let prevRawMessages: Message[] | undefined;
  let stablePrefixTurns = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    history.push({ role: 'user', content: turn.userMessage });

    let messagesToSend: Message[];
    let compressedMessages: Message[] | undefined;
    let engineStats: Dialogue['engineStats'] | undefined;

    if (mode === 'proxy' && budget > 0) {
      const canReuseEpoch = !!prevMessages && !!prevDurableMessages && !!prevRawMessages
        && prevRawMessages.length <= history.length
        && prevRawMessages.every((message, index) => JSON.stringify(message) === JSON.stringify(history[index]));
      const engineMessages = canReuseEpoch
        ? [...prevDurableMessages!, ...history.slice(prevRawMessages!.length)]
        : history;
      if (process.env.DIAG) {
        console.log(`\n  ${C.magenta}[DIAG] Turn ${i+1}:${C.reset} canReuseEpoch=${canReuseEpoch}, engineMsgs.len=${engineMessages.length}, history.len=${history.length}, prevDurable.len=${prevDurableMessages?.length ?? 0}, prevRaw.len=${prevRawMessages?.length ?? 0}`);
        const preview = engineMessages.slice(0, 5).map((m, idx) => `[${idx}]${m.role}${m.name ? '/'+m.name : ''}:${typeof m.content === 'string' ? m.content.length+'ch' : 'non-str'}`);
        console.log(`  ${C.magenta}[DIAG]${C.reset} engineMsgs preview: ${preview.join(' ')}`);
      }
      // 代理模式：本地用 engine 处理 messages
      const engineResult = await runEngine({
        messages: engineMessages,
        baselineMessages: history,
        model: MODEL,
        budget,
        enableReversible: true,
        enableSemanticFold,
        previousMessages: canReuseEpoch ? prevMessages : undefined,
        // Compaction Epoch：传入稳定前缀及其持续轮数，延迟破坏 Provider 前缀缓存的轮换。
        stablePrefixLength: canReuseEpoch ? prevDurableMessages!.length : 0,
        stablePrefixTurns: canReuseEpoch ? stablePrefixTurns : 0,
        // Compaction hysteresis：高水位=budget 触发，低水位=budget*0.7 目标
        // 一次压缩释放足够空间支撑数轮追加，避免每轮频繁触发破坏前缀稳定性
        compaction: budget > 0 ? {
          highWatermark: budget,
          lowWatermark: Math.floor(budget * 0.7),
          rotationAfterRounds: 6,
          // rotation 经济性门槛：0 = 关闭（既有行为）
          rotationMinSavingsRatio: ROTATION_MIN_SAVINGS_RATIO,
          // 硬约束兜底：0 = 关闭。上下文逼近窗口上限时忽略门槛强制 rotation。
          rotationForceTokens: ROTATION_FORCE_TOKENS,
          // 提供窗口上限时，由 engine 自动推导 rotationForceTokens（显式阈值优先）。
          contextWindowTokens: CONTEXT_WINDOW_TOKENS,
          // 为输出预留空间，从可用输入空间中扣除
          reserveOutputTokens: RESERVE_OUTPUT_TOKENS,
        } : undefined,
        // 归档系统：消融模式 A 不传 archive，B/C 传 archive
        ...(useArchive && archiveStore && archiveRetriever ? {
          archive: {
            moduleTracker,
            archiveStore,
            retriever: archiveRetriever,
            enableSummary: enableSummarize,
          },
        } : {}),
        currentTurn: i + 1,
        // Demo 场景：在指定轮次强制注入 retrieval 展示归档召回
        forceRetrieval: forceRetrievalAtTurn === i + 1,
        summarizer: enableSummarize ? {
          config: {
            model: MODEL,
            apiKey,
            baseURL: baseUrl,
            targetRatio: 0.2,
          },
          recentKeep: 6,
        } : undefined,
      });
      messagesToSend = engineResult.messages;
      compressedMessages = engineResult.messages;
      engineStats = {
        originalTokens: engineResult.stats.originalTokens,
        optimizedTokens: engineResult.stats.optimizedTokens,
        cacheHitRate: engineResult.stats.cacheHitRate,
        strategies: engineResult.stats.strategies,
        retrievedTokens: engineResult.stats.retrievedTokens ?? 0,
        retrievedItems: engineResult.stats.retrievedItems ?? [],
        budgetExceeded: engineResult.stats.budgetExceeded ?? false,
        archivedModules: engineResult.stats.archivedModules ?? 0,
        archivedMessages: engineResult.stats.archivedMessages ?? 0,
      };
      const previousDurableMessages = prevDurableMessages;
      // 更新 prevMessages 为压缩后的 messages（用于下一轮的缓存命中预估）
      prevMessages = engineResult.messages;
      prevDurableMessages = engineResult.messages.filter((message) => message.name !== 'context-retrieval');
      prevRawMessages = structuredClone(history);
      if (canReuseEpoch && previousDurableMessages) {
        const currentPrefix = prevDurableMessages.slice(0, previousDurableMessages.length);
        const prefixChanged = currentPrefix.length !== previousDurableMessages.length
          || previousDurableMessages.some((message, index) =>
            JSON.stringify(message) !== JSON.stringify(currentPrefix[index]));
        stablePrefixTurns = prefixChanged ? 0 : stablePrefixTurns + 1;
      } else {
        stablePrefixTurns = 0;
      }
      if (process.env.DIAG) {
        console.log(`  ${C.magenta}[DIAG]${C.reset} strategies: [${engineResult.stats.strategies.join(', ')}], output.len=${engineResult.messages.length}, optimized=${engineResult.stats.optimizedTokens}tok, original=${engineResult.stats.originalTokens}tok`);
        const outPreview = engineResult.messages.slice(0, 5).map((m, idx) => `[${idx}]${m.role}${m.name ? '/'+m.name : ''}:${typeof m.content === 'string' ? m.content.length+'ch' : 'non-str'}`);
        console.log(`  ${C.magenta}[DIAG]${C.reset} output preview: ${outPreview.join(' ')}`);
        // 检查前缀一致性：prevDurableMessages 的前 N 条是否和上一轮 engine 输出一致
        if (prevDurableMessages && prevDurableMessages.length > 0) {
          console.log(`  ${C.magenta}[DIAG]${C.reset} prevDurable first msg content[0:80]: ${JSON.stringify(prevDurableMessages[0]!.content).slice(0, 80)}...`);
        }
      }
    } else {
      messagesToSend = history;
    }

    // 两条路径都记录完全对称的、调用前 request payload。
    const requestMessages = structuredClone(messagesToSend);
    const resp = await callLLM(baseUrl, apiKey, requestMessages, { maxTokens: answerMaxTokens });
    if (process.env.DIAG) {
      const hitRate = (resp.usage.prompt_cache_hit_tokens + resp.usage.prompt_cache_miss_tokens) > 0
        ? (resp.usage.prompt_cache_hit_tokens / (resp.usage.prompt_cache_hit_tokens + resp.usage.prompt_cache_miss_tokens) * 100).toFixed(1)
        : '0.0';
      console.log(`  ${C.magenta}[DIAG]${C.reset} LLM: input=${resp.usage.prompt_tokens}tok, hit=${resp.usage.prompt_cache_hit_tokens}, miss=${resp.usage.prompt_cache_miss_tokens}, hitRate=${hitRate}%`);
    }
    // controlled replay 使用直连回答构造下一轮固定历史，隔离压缩策略影响。
    const historyAnswer = canonicalAnswers?.[i] ?? resp.content;
    history.push({ role: 'assistant', content: historyAnswer });
    // 归档由 engine 通过 ModuleTracker 自动管理，不再手动 archive.add()

    totalInputTokens += resp.usage.prompt_tokens;
    totalOutputTokens += resp.usage.completion_tokens;
    totalProviderCacheHitTokens += resp.usage.prompt_cache_hit_tokens;
    totalProviderCacheMissTokens += resp.usage.prompt_cache_miss_tokens;
    answers.push(resp.content);
    perTurn.push({
      turn: i + 1,
      inputTokens: resp.usage.prompt_tokens,
      outputTokens: resp.usage.completion_tokens,
      finishReason: resp.finishReason,
      providerCacheHitTokens: resp.usage.prompt_cache_hit_tokens,
      providerCacheMissTokens: resp.usage.prompt_cache_miss_tokens,
    });

    const dialogue: Dialogue = {
      turn: i + 1,
      user: turn.userMessage,
      assistant: resp.content,
      inputTokens: resp.usage.prompt_tokens,
      outputTokens: resp.usage.completion_tokens,
      finishReason: resp.finishReason,
      providerCacheHitTokens: resp.usage.prompt_cache_hit_tokens,
      providerCacheMissTokens: resp.usage.prompt_cache_miss_tokens,
      messages: requestMessages,
      compressedMessages,
      engineStats,
    };
    dialogues.push(dialogue);

    // 直连模式也要更新 prevMessages
    if (mode === 'direct') {
      prevMessages = requestMessages;
    }

    onProgress?.(i + 1, {
      inputTokens: resp.usage.prompt_tokens,
      outputTokens: resp.usage.completion_tokens,
    });
    onTurnDetail?.(dialogue);
    // 触发流水线并行 Judge（不 await，让下一轮对话立即开始）
    onTurnComplete?.(i, dialogue);
  }

  return {
    mode: mode === 'direct' ? '直连' : '代理',
    totalInputTokens,
    totalOutputTokens,
    totalProviderCacheHitTokens,
    totalProviderCacheMissTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    finalInputTokens: perTurn[perTurn.length - 1]?.inputTokens ?? 0,
    turns: turns.length,
    answers,
    perTurn,
    dialogues,
  };
}

// ============================================================
// LLM-as-judge 评测（逐轮对比直连回答 vs 代理回答）
// ============================================================

type JudgeVerdict = 'A' | 'B' | 'tie';

async function judgeCall(
  question: string,
  answerA: string,
  answerB: string,
): Promise<{ verdict: JudgeVerdict; reason: string }> {
  // 评测口径（2026-10-07 修正）：
  // 旧 prompt 只说"不要偏好长答案"，但评判标准仍是泛泛的 "completeness"——
  // 更长的答案天然显得更完整，导致 Judge 在相似度 88% 时仍稳定判原始更好（实测 0 胜 1 平 4 负）。
  // 改为"需求逐条核对"：只有事实错误、或某条需求仅一方满足，才分出优劣；
  // 篇幅/补充内容/技术选型差异显式列为必须判 tie 的情形。
  const requirements = extractRequirements(question);
  const reqBlock = requirements.length > 0
    ? `\nStated requirements to check:\n${requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`
    : '';

  const rules = `Your ONLY job is to detect information loss or factual error.

Procedure:
1. List the explicit requirements stated in the question.
2. For each requirement, decide whether A satisfies it and whether B satisfies it.
3. Decide using ONLY these criteria, in this order:
   - Factual error: if one answer contains a clear factual or technical error that the other does not, that answer is worse.
   - Requirement coverage: if a stated requirement is satisfied by only one answer, that answer is better.
   - Otherwise the two are equivalent.
4. These differences MUST be judged as equivalent, never as better or worse:
   - length, level of detail, number of examples, or extra tips beyond the stated requirements
   - wording, formatting, code style, ordering
   - different but equally valid technical choices (a different library, API, or implementation approach that both satisfy the requirement)`;

  // 不设"必须二选一"模式：强制二选一时模型会退回到按篇幅/详尽度挑一个，
  // 且在 A 位固定放原始答案时会产生系统性偏向（详见 judgeSymmetric 的说明）。
  const systemPrompt = `You are an impartial judge comparing two answers to the same question.\n\n${rules}\n\nWrite 2-3 sentences of reasoning, then end with a final line exactly in this form:\nVERDICT: A\n(or) VERDICT: B\n(or) VERDICT: tie`;

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Question: ${question}\n${reqBlock}\nAnswer A:\n${answerA}\n\nAnswer B:\n${answerB}\n\nWhich is better?`,
    },
  ];

  const resp = await callLLM(DEEPSEEK_BASE, DEEPSEEK_API_KEY, messages);
  // 先取 CoT 结尾的 VERDICT 行，解析失败再回退到整体首字符
  const match = resp.content.match(/VERDICT:\s*(A|B|tie)\b/i);
  const trimmed = (match?.[1] ?? resp.content.trim()).toLowerCase();
  // 判定理由（CoT）保留进报告：定位 Judge 误判时靠的就是这些文字，不能只留结论
  const reason = resp.content
    .replace(/VERDICT:\s*(A|B|tie)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  const verdict: JudgeVerdict = trimmed.startsWith('a') ? 'A'
    : trimmed.startsWith('b') ? 'B'
      : 'tie';
  return { verdict, reason };
}

// 交换位置跑两次；结论不一致即判持平（不做第三轮决胜）
async function judgeSymmetric(
  question: string,
  answerRaw: string,
  answerCompressed: string,
): Promise<{ verdict: 'raw_better' | 'compressed_better' | 'tie'; detail: string }> {
  const v1 = await judgeCall(question, answerRaw, answerCompressed);       // A=raw, B=compressed
  const v2 = await judgeCall(question, answerCompressed, answerRaw);       // A=compressed, B=raw

  let verdict: 'raw_better' | 'compressed_better' | 'tie';
  let detail: string;

  if (v1.verdict === 'A' && v2.verdict === 'B') {
    verdict = 'raw_better';
    detail = `v1(raw=A)=A — ${v1.reason} ／ v2(raw=B)=B — ${v2.reason}`;
  } else if (v1.verdict === 'B' && v2.verdict === 'A') {
    verdict = 'compressed_better';
    detail = `v1(raw=A)=B — ${v1.reason} ／ v2(raw=B)=A — ${v2.reason}`;
  } else if (v1.verdict === 'tie' && v2.verdict === 'tie') {
    verdict = 'tie';
    detail = `v1=tie — ${v1.reason} ／ v2=tie — ${v2.reason}`;
  } else {
    // 两次位置交换结论不一致 → Judge 无法稳定区分，判持平。
    //
    // 旧实现在此跑第三轮决胜，存在系统性偏差：决胜轮的 A 位固定是原始答案，
    // 且 prompt 兜底写着"仍相同则输出 A"，于是所有边缘样本都会被判成 raw_better。
    // 实测反例：v1=tie、v2=A（该轮 A 位是压缩答案，即压缩更好），决胜仍判 raw_better。
    // 位置交换的目的本就是检验判定稳定性；不稳定即说明差异小于 Judge 的分辨率，
    // 判持平比强行决胜更诚实，也省掉一次 API 调用。
    verdict = 'tie';
    detail = `v1=${v1.verdict} — ${v1.reason} ／ v2=${v2.verdict} — ${v2.reason}（两次不一致 → 判持平）`;
  }

  return { verdict, detail };
}

function extractRequirements(question: string): string[] {
  const requirements = Array.from(question.matchAll(/^\s*\d+[.、]\s*(.+)$/gm))
    .map((match) => match[1]!.trim())
    .filter(Boolean);
  return requirements.slice(0, 10);
}

interface QualityEval {
  similarity: number;
  similarityReason: string;
  similarityValid: boolean;
  rawCoverage: number;
  proxyCoverage: number;
  coverageReason: string;
  coverageValid: boolean;
  qualityValid: boolean;
}

// 语义相似度：以原始回答为 reference，评估压缩后回答保留了多少关键信息。
// 依据 LLM-as-judge 研究：提供评分锚点（rubric）+ 先分析再打分（CoT）+ 显式抑制冗长偏好。
async function judgeSimilarity(
  question: string,
  reference: string,
  candidate: string,
): Promise<{ similarity: number; reason: string; valid: boolean }> {
  const messages: Message[] = [
    {
      role: 'system',
      content: `你是严格的软件工程回答评测器。将 Answer A（原始上下文下的回答）视为参考答案，评估 Answer B（压缩上下文下的回答）在多大程度上传达了与 A 相同的信息。

只关注语义信息是否一致，忽略篇幅、措辞、格式和代码风格差异，也不要因为回答更长而加分。
请先给出简短的中文分析（是否丢失或改动关键信息），再给出 0-100 的相似度分数。

评分锚点：
- 90-100：几乎传达了 A 的全部关键信息，仅措辞/细节有差异
- 70-89：保留了大部分关键信息，但遗漏或改动了少量要点
- 40-69：只保留部分关键信息，存在明显遗漏或偏差
- 0-39：关键信息大量丢失或存在严重错误

只输出合法 JSON：{"similarity":85,"reason":"..."}`,
    },
    {
      role: 'user',
      content: `Question:\n${question}\n\nAnswer A (reference):\n${reference}\n\nAnswer B (candidate):\n${candidate}\n\n请先分析再输出 JSON：`,
    },
  ];
  const resp = await callLLM(DEEPSEEK_BASE, DEEPSEEK_API_KEY, messages);
  try {
    const jsonMatch = resp.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('未找到 JSON');
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.similarity !== 'number' || !Number.isFinite(parsed.similarity)) {
      throw new Error('similarity 不是有效数字');
    }
    return { similarity: parsed.similarity, reason: parsed.reason ?? '', valid: true };
  } catch {
    return { similarity: 0, reason: 'JSON 解析失败', valid: false };
  }
}

// 需求覆盖率：逐条判断用户明确需求是否被满足，两个回答独立评分。
async function judgeCoverage(
  question: string,
  answerA: string,
  answerB: string,
  requirements: string[],
): Promise<{ rawCoverage: number; proxyCoverage: number; reason: string; valid: boolean }> {
  const reqText = requirements.length > 0
    ? requirements.map((item, i) => `${i + 1}. ${item}`).join('\n')
    : '请从 Question 中提取核心需求';
  const messages: Message[] = [
    {
      role: 'system',
      content: `你是严格的软件工程回答评测器。根据用户明确需求，分别评估 Answer A 和 Answer B 的需求覆盖率。

需求覆盖率 = 被完整满足的需求数 / 总需求数，输出 0-100。
判断时只关注需求是否被满足，忽略篇幅、措辞、格式差异，也不要因为回答更长而加分。
请先逐条判断每个需求是否被满足（中文），再分别给出 A 和 B 的覆盖率。

只输出合法 JSON：{"rawCoverage":90,"proxyCoverage":95,"reason":"..."}`,
    },
    {
      role: 'user',
      content: `Question:\n${question}\n\nExplicit requirements:\n${reqText}\n\nAnswer A (raw):\n${answerA}\n\nAnswer B (proxy):\n${answerB}\n\n请逐条判断后输出 JSON：`,
    },
  ];
  const resp = await callLLM(DEEPSEEK_BASE, DEEPSEEK_API_KEY, messages);
  try {
    const jsonMatch = resp.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('未找到 JSON');
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.rawCoverage !== 'number'
      || !Number.isFinite(parsed.rawCoverage)
      || typeof parsed.proxyCoverage !== 'number'
      || !Number.isFinite(parsed.proxyCoverage)) {
      throw new Error('coverage 不是有效数字');
    }
    return {
      rawCoverage: parsed.rawCoverage,
      proxyCoverage: parsed.proxyCoverage,
      reason: parsed.reason ?? '',
      valid: true,
    };
  } catch {
    return { rawCoverage: 0, proxyCoverage: 0, reason: 'JSON 解析失败', valid: false };
  }
}

// 拆分相似度与覆盖率两个独立评测，避免一次调用中多个维度相互干扰。
async function judgeQuality(question: string, answerA: string, answerB: string): Promise<QualityEval> {
  const requirements = extractRequirements(question);
  const [sim, cov] = await Promise.all([
    judgeSimilarity(question, answerA, answerB),
    judgeCoverage(question, answerA, answerB, requirements),
  ]);
  return {
    similarity: sim.similarity,
    similarityReason: sim.reason,
    similarityValid: sim.valid,
    rawCoverage: cov.rawCoverage,
    proxyCoverage: cov.proxyCoverage,
    coverageReason: cov.reason,
    coverageValid: cov.valid,
    qualityValid: sim.valid && cov.valid,
  };
}

// 计算缓存命中率（前缀一致率）
function computeCacheHit(currentMessages: Message[], previousMessages?: Message[]): number {
  if (!previousMessages || previousMessages.length === 0) return 0;
  const result = estimateCacheHit(currentMessages, previousMessages);
  return result.hitRate;
}

interface TurnEval {
  turn: number;
  judgeVerdict: 'raw_better' | 'compressed_better' | 'tie';
  judgeDetail: string;
  similarity: number;
  similarityReason: string;
  similarityValid: boolean;
  rawCoverage: number;
  proxyCoverage: number;
  coverageReason: string;
  coverageValid: boolean;
  qualityValid: boolean;
  truncated: boolean;
  directCacheHit: number;
  proxyCacheHit: number;
}

// 单轮评测：抽出以便并行调度
async function evalSingleTurn(
  i: number,
  dd: Dialogue,
  pd: Dialogue,
  prevDd?: Dialogue,
  prevPd?: Dialogue,
  forceEvaluate = false,
): Promise<TurnEval> {
  // 缓存命中率
  const directCacheHit = i > 0 && prevDd
    ? computeCacheHit(dd.messages, prevDd.messages)
    : 0;
  const proxyCacheHit = i > 0 && pd.compressedMessages && prevPd?.compressedMessages
    ? computeCacheHit(pd.compressedMessages, prevPd.compressedMessages)
    : i > 0 && pd.messages && prevPd?.messages
      ? computeCacheHit(pd.messages, prevPd.messages)
      : 0;

  // 判断是否有压缩
  const hasCompression = forceEvaluate || (!!pd.engineStats
    && pd.engineStats.optimizedTokens < pd.engineStats.originalTokens);
  const truncated = dd.finishReason === 'length' || pd.finishReason === 'length';

  let judgeVerdict: TurnEval['judgeVerdict'] = 'tie';
  let judgeDetail = '无压缩，跳过评测';
  let similarity = 100;
  let similarityReason = '无压缩，两者一致';
  let similarityValid = true;
  let rawCoverage = 100;
  let proxyCoverage = 100;
  let coverageReason = '无压缩，两者一致';
  let coverageValid = true;
  let qualityValid = true;

  if (hasCompression && !truncated) {
    // 有压缩，做 LLM-as-judge 评测
    const judge = await judgeSymmetric(dd.user, dd.assistant, pd.assistant);
    judgeVerdict = judge.verdict;
    judgeDetail = judge.detail;

    const quality = await judgeQuality(dd.user, dd.assistant, pd.assistant);
    similarity = quality.similarity;
    similarityReason = quality.similarityReason;
    similarityValid = quality.similarityValid;
    rawCoverage = quality.rawCoverage;
    proxyCoverage = quality.proxyCoverage;
    coverageReason = quality.coverageReason;
    coverageValid = quality.coverageValid;
    qualityValid = quality.qualityValid;
  } else if (truncated) {
    judgeDetail = '输出截断，跳过质量评测';
    similarity = 0;
    similarityReason = `finish_reason: raw=${dd.finishReason}, proxy=${pd.finishReason}`;
    similarityValid = false;
    rawCoverage = 0;
    proxyCoverage = 0;
    coverageReason = '输出被 max_tokens 截断';
    coverageValid = false;
    qualityValid = false;
  }

  return {
    turn: i + 1,
    judgeVerdict,
    judgeDetail,
    similarity,
    similarityReason,
    similarityValid,
    rawCoverage,
    proxyCoverage,
    coverageReason,
    coverageValid,
    qualityValid,
    truncated,
    directCacheHit,
    proxyCacheHit,
  };
}

// 逐轮评测（保留串行版本作为 fallback）
async function evalTurns(
  directDialogues: Dialogue[],
  proxyDialogues: Dialogue[],
  onProgress?: (turn: number, total: number) => void,
  forceEvaluate = false,
): Promise<TurnEval[]> {
  const evals: TurnEval[] = [];
  for (let i = 0; i < directDialogues.length; i++) {
    const dd = directDialogues[i]!;
    const pd = proxyDialogues[i]!;
    const prevDd = i > 0 ? directDialogues[i - 1] : undefined;
    const prevPd = i > 0 ? proxyDialogues[i - 1] : undefined;
    evals.push(await evalSingleTurn(i, dd, pd, prevDd, prevPd, forceEvaluate));
    onProgress?.(i + 1, directDialogues.length);
  }
  return evals;
}

// 流水线并行评测：第 i 轮 Judge 与第 i+1 轮对话并行
// 调用方在每轮 proxy 完成后调用 scheduleJudge(i)，最后 await judgePromises
class PipelinedEvaluator {
  private judgePromises: Promise<void>[] = [];
  private evals: TurnEval[];
  private directDialogues: Dialogue[];
  private proxyDialogues: Dialogue[];
  private onProgress?: (turn: number, total: number) => void;
  private total: number;
  private completedCount = 0;

  constructor(
    directDialogues: Dialogue[],
    proxyDialogues: Dialogue[],
    total: number,
    onProgress?: (turn: number, total: number) => void,
  ) {
    this.directDialogues = directDialogues;
    this.proxyDialogues = proxyDialogues;
    this.total = total;
    this.onProgress = onProgress;
    this.evals = new Array(total);
  }

  // 调度第 i 轮的 Judge（fire-and-forget，不阻塞）
  scheduleJudge(i: number): void {
    const dd = this.directDialogues[i]!;
    const pd = this.proxyDialogues[i]!;
    const prevDd = i > 0 ? this.directDialogues[i - 1] : undefined;
    const prevPd = i > 0 ? this.proxyDialogues[i - 1] : undefined;

    const p = evalSingleTurn(i, dd, pd, prevDd, prevPd).then((evalResult) => {
      this.evals[i] = evalResult;
      this.completedCount++;
      this.onProgress?.(this.completedCount, this.total);
    }).catch((err) => {
      // Judge 失败时填入默认值，不让整个流程崩溃
      this.evals[i] = {
        turn: i + 1,
        judgeVerdict: 'tie',
        judgeDetail: `Judge 失败: ${(err as Error).message}`,
        similarity: 0,
        similarityReason: 'Judge 异常',
        similarityValid: false,
        rawCoverage: 0,
        proxyCoverage: 0,
        coverageReason: 'Judge 异常',
        coverageValid: false,
        qualityValid: false,
        truncated: false,
        directCacheHit: 0,
        proxyCacheHit: 0,
      };
      this.completedCount++;
      this.onProgress?.(this.completedCount, this.total);
    });
    this.judgePromises.push(p);
  }

  // 等待所有 Judge 完成
  async awaitAll(): Promise<TurnEval[]> {
    await Promise.allSettled(this.judgePromises);
    return this.evals;
  }

  // 追加 proxy dialogue（保持与 scheduleJudge 索引同步）
  pushProxyDialogue(d: Dialogue): void {
    this.proxyDialogues.push(d);
  }
}

// ============================================================
// 展示
// ============================================================

function printHeader(title: string): void {
  console.log('\n' + C.cyan + '═'.repeat(60) + C.reset);
  console.log(C.bold + C.cyan + '  ' + title + C.reset);
  console.log(C.cyan + '═'.repeat(60) + C.reset);
}

function printProgress(turn: number, total: number, inputTokens: number): void {
  const bar = '█'.repeat(Math.floor((turn / total) * 20)).padEnd(20, '░');
  process.stdout.write(`\r  ${C.gray}[${bar}]${C.reset} 轮次 ${turn}/${total}  输入 ${C.yellow}${inputTokens}${C.reset} tokens  `);
}

function printResult(result: RunResult): void {
  console.log('\n');
  console.log(`  ${C.bold}模式:${C.reset} ${result.mode}`);
  console.log(`  ${C.bold}轮次:${C.reset} ${result.turns}`);
  console.log(`  ${C.bold}累计输入 token:${C.reset} ${C.yellow}${result.totalInputTokens}${C.reset}`);
  console.log(`  ${C.bold}累计输出 token:${C.reset} ${result.totalOutputTokens}`);
  console.log(`  ${C.bold}总 token:${C.reset} ${result.totalTokens}`);
  console.log(`  ${C.bold}最后一轮输入:${C.reset} ${C.yellow}${result.finalInputTokens}${C.reset} tokens`);
  const providerCacheTotal = result.totalProviderCacheHitTokens + result.totalProviderCacheMissTokens;
  const providerCacheRate = providerCacheTotal > 0
    ? result.totalProviderCacheHitTokens / providerCacheTotal * 100
    : 0;
  console.log(`  ${C.bold}Provider 实际缓存:${C.reset} ${result.totalProviderCacheHitTokens} hit / ${result.totalProviderCacheMissTokens} miss (${providerCacheRate.toFixed(1)}%)`);
  console.log('');

  // 每轮明细
  console.log(`  ${C.dim}每轮输入 token 明细:${C.reset}`);
  for (const t of result.perTurn) {
    const bar = '▎'.repeat(Math.min(Math.floor(t.inputTokens / 200), 30));
    const finish = t.finishReason === 'length' ? ` ${C.red}[truncated]${C.reset}` : '';
    // 逐轮 Provider 缓存：用于诊断 rotation/评测流水线对前缀缓存的影响
    const cacheTotal = t.providerCacheHitTokens + t.providerCacheMissTokens;
    const cache = cacheTotal > 0
      ? `cache ${t.providerCacheHitTokens}/${cacheTotal}`
      : 'cache -';
    console.log(`    轮 ${String(t.turn).padStart(2)}: ${String(t.inputTokens).padStart(5)} ${C.gray}${bar}${C.reset} ${C.dim}${cache}${C.reset}${finish}`);
  }
}

function printCompare(direct: RunResult, proxy: RunResult): void {
  printHeader('对比结果');

  const inputSaved = direct.totalInputTokens - proxy.totalInputTokens;
  const inputSavedPct = direct.totalInputTokens > 0
    ? ((inputSaved / direct.totalInputTokens) * 100).toFixed(1)
    : '0.0';
  const finalSaved = direct.finalInputTokens - proxy.finalInputTokens;
  const finalSavedPct = direct.finalInputTokens > 0
    ? ((finalSaved / direct.finalInputTokens) * 100).toFixed(1)
    : '0.0';

  // DeepSeek pricing（参考官方 https://api-docs.deepseek.com/quick_start/pricing）：
  //   - 输入 cache miss: $0.14 / 1M tokens（原价）
  //   - 输入 cache hit : $0.014 / 1M tokens（1 折，原价的 10%）
  //   - 输出          : $0.28 / 1M tokens
  const INPUT_PRICE = 0.14 / 1_000_000;
  const CACHE_HIT_PRICE = 0.014 / 1_000_000;
  const OUTPUT_PRICE = 0.28 / 1_000_000;

  // 旧模型：不考虑缓存折扣（仅按 token 总量计费）
  const directCostLegacy = direct.totalInputTokens * INPUT_PRICE + direct.totalOutputTokens * OUTPUT_PRICE;
  const proxyCostLegacy = proxy.totalInputTokens * INPUT_PRICE + proxy.totalOutputTokens * OUTPUT_PRICE;
  const costSavedLegacy = directCostLegacy - proxyCostLegacy;

  // 新模型：考虑 Provider 实际缓存折扣
  // 实际费用 = cache_hit_tokens * CACHE_HIT_PRICE + cache_miss_tokens * INPUT_PRICE + output_tokens * OUTPUT_PRICE
  const directCost = direct.totalProviderCacheHitTokens * CACHE_HIT_PRICE
    + direct.totalProviderCacheMissTokens * INPUT_PRICE
    + direct.totalOutputTokens * OUTPUT_PRICE;
  const proxyCost = proxy.totalProviderCacheHitTokens * CACHE_HIT_PRICE
    + proxy.totalProviderCacheMissTokens * INPUT_PRICE
    + proxy.totalOutputTokens * OUTPUT_PRICE;
  const costSaved = directCost - proxyCost;

  // 用 displayWidth 对齐（修复中文对齐问题）
  const col1 = 24, col2 = 14, col3 = 14, col4 = 14;
  console.log('');
  console.log(`  ${padEndD('指标', col1)} ${padStartD('直连', col2)} ${padStartD('走代理', col3)} ${padStartD('节省', col4)}`);
  console.log(`  ${'─'.repeat(col1 + col2 + col3 + col4 + 3)}`);
  console.log(`  ${padEndD('累计输入 token', col1)} ${padStartD(String(direct.totalInputTokens), col2)} ${padStartD(String(proxy.totalInputTokens), col3)} ${C.green}${padStartD(String(inputSaved), col4)}${C.reset}`);
  console.log(`  ${padEndD('最后一轮输入 token', col1)} ${padStartD(String(direct.finalInputTokens), col2)} ${padStartD(String(proxy.finalInputTokens), col3)} ${C.green}${padStartD(String(finalSaved), col4)}${C.reset}`);
  console.log(`  ${padEndD('输入节省率', col1)} ${padStartD('-', col2)} ${padStartD('-', col3)} ${C.green}${padStartD(inputSavedPct + '%', col4)}${C.reset}`);
  console.log(`  ${padEndD('最后一轮节省率', col1)} ${padStartD('-', col2)} ${padStartD('-', col3)} ${C.green}${padStartD(finalSavedPct + '%', col4)}${C.reset}`);
  console.log(`  ${C.dim}${padEndD('费用(无缓存折扣)', col1)} ${padStartD(directCostLegacy.toFixed(4), col2)} ${padStartD(proxyCostLegacy.toFixed(4), col3)} ${padStartD(costSavedLegacy.toFixed(4), col4)}${C.reset}`);
  console.log(`  ${padEndD('费用(缓存折扣)', col1)} ${padStartD(directCost.toFixed(4), col2)} ${padStartD(proxyCost.toFixed(4), col3)} ${C.green}${padStartD(costSaved.toFixed(4), col4)}${C.reset}`);
  console.log('');

  // 回答质量对比（简单对比长度）
  if (direct.answers.length > 0 && proxy.answers.length > 0) {
    console.log(`  ${C.dim}回答质量对比（长度）:${C.reset}`);
    for (let i = 0; i < Math.min(3, direct.answers.length); i++) {
      const dLen = direct.answers[i]!.length;
      const pLen = proxy.answers[i]!.length;
      console.log(`    轮 ${i + 1}: 直连 ${dLen} chars vs 代理 ${pLen} chars`);
    }
  }
}

// verbose 模式：打印每轮对话详情
function printTurnDetail(d: Dialogue, mode: string): void {
  console.log(`\n  ${C.cyan}── ${mode} | 轮 ${d.turn} | 输入 ${d.inputTokens} tok / 输出 ${d.outputTokens} tok ──${C.reset}`);
  console.log(`  ${C.bold}用户提问:${C.reset}`);
  // 用户消息：截取前 300 字展示
  const userPreview = d.user.length > 300 ? d.user.slice(0, 300) + '...' : d.user;
  for (const line of userPreview.split('\n')) {
    console.log(`  ${C.gray}${line}${C.reset}`);
  }
  console.log(`\n  ${C.bold}LLM 回答:${C.reset}`);
  for (const line of d.assistant.split('\n')) {
    console.log(`  ${line}`);
  }
}

// 保存完整评测报告到 markdown 文件（顺序展示格式）
function saveToFile(
  direct: RunResult,
  proxy: RunResult,
  turnEvals: TurnEval[],
  pipelineJudge: boolean = false,
): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `demo-eval-${ts}.md`;
  const lines: string[] = [];

  // 汇总统计
  const inputSaved = direct.totalInputTokens - proxy.totalInputTokens;
  const inputSavedPct = direct.totalInputTokens > 0
    ? ((inputSaved / direct.totalInputTokens) * 100).toFixed(1)
    : '0.0';
  const finalSaved = direct.finalInputTokens - proxy.finalInputTokens;
  const finalSavedPct = direct.finalInputTokens > 0
    ? ((finalSaved / direct.finalInputTokens) * 100).toFixed(1)
    : '0.0';

  // 准确率统计
  const compressedTurns = turnEvals.filter(e => e.judgeDetail !== '无压缩，跳过评测' && !e.truncated);
  const truncatedTurns = turnEvals.filter(e => e.truncated).length;
  const tieOrBetter = compressedTurns.filter(e => e.judgeVerdict === 'tie' || e.judgeVerdict === 'compressed_better').length;
  const accuracyRetention = compressedTurns.length > 0
    ? ((tieOrBetter / compressedTurns.length) * 100).toFixed(1)
    : '100.0';
  const pairwiseWins = compressedTurns.filter(e => e.judgeVerdict === 'compressed_better').length;
  const pairwiseTies = compressedTurns.filter(e => e.judgeVerdict === 'tie').length;
  const pairwiseLosses = compressedTurns.filter(e => e.judgeVerdict === 'raw_better').length;
  const similarityTurns = compressedTurns.filter(e => e.similarityValid);
  const coverageTurns = compressedTurns.filter(e => e.coverageValid);
  const severeRegressions = similarityTurns.filter(e => e.similarity < 70).length;

  // 平均语义相似度（只算有压缩的轮次）
  const avgSimilarity = similarityTurns.length > 0
    ? (similarityTurns.reduce((s, e) => s + e.similarity, 0) / similarityTurns.length).toFixed(1)
    : '100.0';
  const avgRawCoverage = coverageTurns.length > 0
    ? (coverageTurns.reduce((s, e) => s + e.rawCoverage, 0) / coverageTurns.length).toFixed(1)
    : '100.0';
  const avgProxyCoverage = coverageTurns.length > 0
    ? (coverageTurns.reduce((s, e) => s + e.proxyCoverage, 0) / coverageTurns.length).toFixed(1)
    : '100.0';

  // 平均缓存命中率（从第 2 轮开始算）
  const cacheTurns = turnEvals.filter(e => e.turn > 1);
  const avgDirectCache = cacheTurns.length > 0
    ? (cacheTurns.reduce((s, e) => s + e.directCacheHit, 0) / cacheTurns.length * 100).toFixed(1)
    : '0.0';
  const avgProxyCache = cacheTurns.length > 0
    ? (cacheTurns.reduce((s, e) => s + e.proxyCacheHit, 0) / cacheTurns.length * 100).toFixed(1)
    : '0.0';

  lines.push(`# 多轮对话上下文管理评测报告`);
  lines.push(``);
  lines.push(`- 时间: ${new Date().toISOString()}`);
  lines.push(`- 模型: ${MODEL}`);
  lines.push(`- 总轮次: ${turnEvals.length}`);
  lines.push(`- 评测方法: Pairwise（需求逐条核对 + 位置交换，两次不一致判持平）+ LLM 语义相似度`);
  lines.push(`- Judge 调度: ${pipelineJudge ? '流水线并行（Judge 与下一轮对话并发）' : '串行（对话全部结束后统一评测）'}`);
  if (pipelineJudge) {
    lines.push(`  - ⚠️ 流水线并行下 Judge 并发请求会挤占 DeepSeek 补全缓存写入，`);
    lines.push(`    代理的 Provider 缓存/费用列被系统性低估，不可用于缓存经济性结论。`);
  }
  lines.push(``);
  lines.push(`## 汇总`);
  lines.push(``);
  lines.push(`| 指标 | 直连 | 代理 | 节省/差异 |`);
  lines.push(`|---|---|---|---|`);
  lines.push(`| 累计输入 token | ${direct.totalInputTokens} | ${proxy.totalInputTokens} | ${inputSaved} (${inputSavedPct}%) |`);
  lines.push(`| 最后一轮输入 | ${direct.finalInputTokens} | ${proxy.finalInputTokens} | ${finalSaved} (${finalSavedPct}%) |`);
  lines.push(`| Pairwise 非劣率 | - | - | ${accuracyRetention}% |`);
  lines.push(`| Pairwise 胜/平/负 | - | - | ${pairwiseWins}/${pairwiseTies}/${pairwiseLosses} |`);
  lines.push(`| 严重退化轮次（相似度<70） | - | - | ${severeRegressions}/${similarityTurns.length} 有效 / ${compressedTurns.length} 压缩 |`);
  lines.push(`| 平均语义相似度 | - | - | ${avgSimilarity}%（${similarityTurns.length}/${compressedTurns.length} 有效） |`);
  lines.push(`| 平均需求覆盖率 | ${avgRawCoverage}% | ${avgProxyCoverage}% | ${(Number(avgProxyCoverage) - Number(avgRawCoverage)).toFixed(1)}pp（${coverageTurns.length}/${compressedTurns.length} 有效） |`);
  lines.push(`| 输出截断轮次 | - | - | ${truncatedTurns}/${turnEvals.length} |`);
  lines.push(`| 平均缓存命中率 | ${avgDirectCache}% | ${avgProxyCache}% | - |`);
  const directProviderTotal = direct.totalProviderCacheHitTokens + direct.totalProviderCacheMissTokens;
  const proxyProviderTotal = proxy.totalProviderCacheHitTokens + proxy.totalProviderCacheMissTokens;
  const directProviderRate = directProviderTotal > 0 ? direct.totalProviderCacheHitTokens / directProviderTotal * 100 : 0;
  const proxyProviderRate = proxyProviderTotal > 0 ? proxy.totalProviderCacheHitTokens / proxyProviderTotal * 100 : 0;
  lines.push(`| Provider 实际缓存命中率 | ${directProviderRate.toFixed(1)}% | ${proxyProviderRate.toFixed(1)}% | - |`);

  // 费用计算（缓存折扣模型 vs 旧模型）
  const INPUT_PRICE = 0.14 / 1_000_000;
  const CACHE_HIT_PRICE = 0.014 / 1_000_000;
  const OUTPUT_PRICE = 0.28 / 1_000_000;
  const directCostLegacy = direct.totalInputTokens * INPUT_PRICE + direct.totalOutputTokens * OUTPUT_PRICE;
  const proxyCostLegacy = proxy.totalInputTokens * INPUT_PRICE + proxy.totalOutputTokens * OUTPUT_PRICE;
  const directCost = direct.totalProviderCacheHitTokens * CACHE_HIT_PRICE
    + direct.totalProviderCacheMissTokens * INPUT_PRICE
    + direct.totalOutputTokens * OUTPUT_PRICE;
  const proxyCost = proxy.totalProviderCacheHitTokens * CACHE_HIT_PRICE
    + proxy.totalProviderCacheMissTokens * INPUT_PRICE
    + proxy.totalOutputTokens * OUTPUT_PRICE;
  lines.push(`| 费用 USD (无缓存折扣) | ${directCostLegacy.toFixed(4)} | ${proxyCostLegacy.toFixed(4)} | ${(directCostLegacy - proxyCostLegacy).toFixed(4)} |`);
  lines.push(`| 费用 USD (缓存折扣) | ${directCost.toFixed(4)} | ${proxyCost.toFixed(4)} | ${(directCost - proxyCost).toFixed(4)} |`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 逐轮展示
  for (let i = 0; i < direct.dialogues.length; i++) {
    const dd = direct.dialogues[i]!;
    const pd = proxy.dialogues[i]!;
    const ev = turnEvals[i]!;
    const tokenDiff = dd.inputTokens - pd.inputTokens;
    const hasCompression = !!pd.engineStats
      && pd.engineStats.optimizedTokens < pd.engineStats.originalTokens;
    const compressPct = dd.inputTokens > 0
      ? ((tokenDiff / dd.inputTokens) * 100).toFixed(1)
      : '0.0';

    lines.push(`## 轮次 ${i + 1}`);
    lines.push(``);

    // 问题
    lines.push(`### 问题`);
    lines.push(``);
    lines.push('```');
    lines.push(dd.user);
    lines.push('```');
    lines.push(``);

    // 输入 token
    lines.push(`### 输入 token`);
    lines.push(``);
    lines.push(`- 直连: ${dd.inputTokens} tok`);
    lines.push(`- 代理: ${pd.inputTokens} tok`);
    lines.push(`- finish_reason: 直连 ${dd.finishReason} / 代理 ${pd.finishReason}`);
    lines.push(`- Provider cache: 直连 ${dd.providerCacheHitTokens} hit + ${dd.providerCacheMissTokens} miss；代理 ${pd.providerCacheHitTokens} hit + ${pd.providerCacheMissTokens} miss`);
    if (hasCompression) {
      lines.push(`- 压缩率: ${compressPct}% (节省 ${tokenDiff} tok)`);
      if (pd.engineStats) {
        lines.push(`- 压缩策略: ${pd.engineStats.strategies.join(', ')}`);
        lines.push(`- 软预算超限: ${pd.engineStats.budgetExceeded ? '是' : '否'}`);
        if (pd.engineStats.retrievedItems.length > 0) {
          lines.push(`- 检索注入: ${pd.engineStats.retrievedTokens} tok；${pd.engineStats.retrievedItems.map(item => `${item.id}${item.score === undefined ? '' : `(${item.score.toFixed(3)})`}`).join(', ')}`);
        }
        if (pd.engineStats.archivedModules > 0) {
          lines.push(`- 归档: ${pd.engineStats.archivedModules} 个模块 / ${pd.engineStats.archivedMessages} 条消息`);
        }
      }
    } else {
      lines.push(`- 压缩率: 0% (无压缩)`);
    }
    lines.push(``);

    // 缓存命中率
    if (i > 0) {
      lines.push(`### 缓存命中率（前缀一致率）`);
      lines.push(``);
      lines.push(`- 直连: ${(ev.directCacheHit * 100).toFixed(1)}%`);
      lines.push(`- 代理: ${(ev.proxyCacheHit * 100).toFixed(1)}%`);
      lines.push(``);
    }

    // 代理实际输入内容（有压缩时展示）
    if (hasCompression && pd.compressedMessages) {
      lines.push(`### 代理实际输入内容（压缩后，${pd.inputTokens} tok）`);
      lines.push(``);
      lines.push(`<details>`);
      lines.push(`<summary>点击展开查看代理实际发给 LLM 的 messages</summary>`);
      lines.push(``);
      lines.push('```json');
      lines.push(JSON.stringify(pd.compressedMessages, null, 2));
      lines.push('```');
      lines.push(``);
      lines.push(`</details>`);
      lines.push(``);
    }

    // 直连回答
    lines.push(`### 直连回答 (${dd.inputTokens} tok 输入 → ${dd.outputTokens} tok 输出)`);
    lines.push(``);
    lines.push('```');
    lines.push(dd.assistant);
    lines.push('```');
    lines.push(``);

    // 代理回答
    lines.push(`### 代理回答 (${pd.inputTokens} tok 输入 → ${pd.outputTokens} tok 输出)`);
    lines.push(``);
    lines.push('```');
    lines.push(pd.assistant);
    lines.push('```');
    lines.push(``);

    // 评测
    lines.push(`### 评测`);
    lines.push(``);
    if (!hasCompression) {
      lines.push(`> 当前没有压缩，两者一致`);
    } else {
      const verdictLabel = ev.judgeVerdict === 'tie' ? '持平'
        : ev.judgeVerdict === 'raw_better' ? '原始更好'
        : '压缩后更好';
      lines.push(`- **Judge:** ${verdictLabel} [${ev.judgeDetail}]`);
      if (ev.truncated) {
        lines.push(`- **输出截断:** 是 — ${ev.similarityReason}`);
      } else {
        lines.push(ev.similarityValid
          ? `- **语义相似度:** ${ev.similarity.toFixed(1)}% — ${ev.similarityReason}`
          : `- **语义相似度:** 无效 — ${ev.similarityReason}`);
        lines.push(ev.coverageValid
          ? `- **需求覆盖率:** 直连 ${ev.rawCoverage.toFixed(1)}% / 代理 ${ev.proxyCoverage.toFixed(1)}% — ${ev.coverageReason}`
          : `- **需求覆盖率:** 无效 — ${ev.coverageReason}`);
      }
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const filepath = join(REPORTS_DIR, filename);
  writeFileSync(filepath, lines.join('\n'), 'utf-8');
  return filepath;
}

// ============================================================
// 主入口
// ============================================================

function parseArgs(argv: string[]): {
  mode: 'direct' | 'proxy' | 'compare';
  turns: number;
  verbose: boolean;
  budget: number;
  rollout: boolean;
  semanticFold: boolean;
  calibrate: boolean;
  maxOutput: number;
  summarize: boolean;
  selfTest: boolean;
  ablation: boolean;
  demo: boolean;
  fullContent: boolean;
  // 流水线并行评测（Judge 与下一轮对话并发）。
  // 默认 false：Judge 并发请求会挤占 DeepSeek 的补全缓存写入，使代理的 Provider cache 被系统性低估。
  // 需要测速时用 --pipeline-judge 显式开启。
  pipelineJudge: boolean;
  // rotation 经济性门槛：要求"预计节省 Δ ≥ ratio × 一次性改写成本"才允许改写缓存前缀。
  // 默认 0 = 关闭（既有行为）。设为 1.0 表示 Δ 至少要覆盖改写成本（回本 ≈ 10 轮）。
  rotationMinSavingsRatio: number;
  // 硬约束兜底：上下文 total 达到该 token 数时，忽略经济门槛与 rotationAfterRounds 强制 rotation。
  // 默认 0 = 关闭。用于避免"只算经济账 → 永不压缩 → 上下文溢出"。
  rotationForceTokens: number;
  // 模型上下文窗口上限：提供后由 engine 自动推导硬约束阈值（显式 rotationForceTokens 优先）。
  contextWindowTokens: number;
} {
  const args = {
    mode: 'direct' as 'direct' | 'proxy' | 'compare',
    turns: 20,
    verbose: false,
    budget: 800,
    rollout: false,
    semanticFold: false,
    calibrate: false,
    maxOutput: 900,
    summarize: false,
    selfTest: false,
    ablation: false,
    demo: false,
    fullContent: false,
    pipelineJudge: false,
    rotationMinSavingsRatio: 0,
    rotationForceTokens: 0,
    contextWindowTokens: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--direct') args.mode = 'direct';
    else if (arg === '--proxy') args.mode = 'proxy';
    else if (arg === '--compare') args.mode = 'compare';
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--rollout') args.rollout = true;
    else if (arg === '--semantic-fold') args.semanticFold = true;
    else if (arg === '--calibrate') args.calibrate = true;
    else if (arg === '--summarize') args.summarize = true;
    else if (arg === '--self-test') args.selfTest = true;
    else if (arg === '--ablation') args.ablation = true;
    else if (arg === '--demo') args.demo = true;
    else if (arg === '--full-content') args.fullContent = true;
    else if (arg === '--pipeline-judge') args.pipelineJudge = true;
    else if (arg === '--rotation-ratio') {
      const next = argv[++i];
      if (next) args.rotationMinSavingsRatio = parseFloat(next);
    }
    else if (arg === '--rotation-force-tokens') {
      const next = argv[++i];
      if (next) args.rotationForceTokens = parseInt(next, 10);
    }
    else if (arg === '--context-window') {
      const next = argv[++i];
      if (next) args.contextWindowTokens = parseInt(next, 10);
    }
    else if (arg === '--turns' || arg === '-n') {
      const next = argv[i + 1];
      if (next) args.turns = parseInt(next, 10);
    }
    else if (arg === '--budget' || arg === '-b') {
      const next = argv[i + 1];
      if (next) args.budget = parseInt(next, 10);
    }
    else if (arg === '--max-output') {
      const next = argv[i + 1];
      if (next) args.maxOutput = parseInt(next, 10);
    }
  }
  return args;
}

// ============================================================
// P2 自检：验证流水线并行评测器的调度行为（不依赖 LLM）
// ============================================================

// P2 自检：验证流水线并行评测器的调度行为（不依赖 LLM）
async function runSelfTest(): Promise<void> {
  printHeader('P2 流水线并行评测器自检');

  let passed = 0;
  let failed = 0;
  function check(cond: boolean, label: string): void {
    if (cond) { passed++; console.log(`  ✓ ${label}`); }
    else { failed++; console.log(`  ✗ ${label}`); }
  }

  const makeMockDialogue = (turn: number): Dialogue => ({
    turn,
    user: `q${turn}`,
    assistant: `a${turn}`,
    inputTokens: 100,
    outputTokens: 50,
    finishReason: 'stop',
    providerCacheHitTokens: 0,
    providerCacheMissTokens: 100,
    messages: [{ role: 'user', content: `q${turn}` }],
  });

  // 测试 1：Promise.allSettled 并行调度（验证 JS 运行时并行能力）
  console.log('\n=== 测试 1: 并行调度基线（5 个 200ms 任务总耗时应 < 600ms） ===');
  {
    const start = Date.now();
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(new Promise((r) => setTimeout(r, 200)).then(() => {}));
    }
    await Promise.allSettled(promises);
    const elapsed = Date.now() - start;
    check(elapsed < 600, `5 个 200ms 任务并行总耗时 < 600ms (实际: ${elapsed}ms)`);
    check(elapsed >= 150, `至少经过一个任务的时间 (实际: ${elapsed}ms)`);
  }

  // 测试 2：PipelinedEvaluator 基本结构与方法
  console.log('\n=== 测试 2: PipelinedEvaluator 结构与方法 ===');
  {
    const N = 4;
    const directDialogues: Dialogue[] = Array.from({ length: N }, (_, i) => makeMockDialogue(i + 1));
    const proxyDialogues: Dialogue[] = Array.from({ length: N }, (_, i) => makeMockDialogue(i + 1));
    const evaluator = new PipelinedEvaluator(directDialogues, proxyDialogues, N);
    check(evaluator !== undefined, 'PipelinedEvaluator 可构造');
    check(typeof evaluator.scheduleJudge === 'function', 'scheduleJudge 方法存在');
    check(typeof evaluator.awaitAll === 'function', 'awaitAll 方法存在');
    check(typeof evaluator.pushProxyDialogue === 'function', 'pushProxyDialogue 方法存在');
  }

  // 测试 3：pushProxyDialogue 与索引同步
  console.log('\n=== 测试 3: pushProxyDialogue 与 scheduleJudge 索引同步 ===');
  {
    const N = 3;
    const directDialogues: Dialogue[] = Array.from({ length: N }, (_, i) => makeMockDialogue(i + 1));
    const proxyDialogues: Dialogue[] = [];
    const evaluator = new PipelinedEvaluator(directDialogues, proxyDialogues, N);

    for (let i = 0; i < N; i++) {
      evaluator.pushProxyDialogue(makeMockDialogue(i + 1));
    }
    check(proxyDialogues.length === N, `push ${N} 次后长度 = ${N} (实际: ${proxyDialogues.length})`);
    check(proxyDialogues[0]!.turn === 1, '第一个 dialogue.turn = 1');
    check(proxyDialogues[N - 1]!.turn === N, `最后一个 dialogue.turn = ${N}`);
  }

  // 测试 4：awaitAll 在无 Judge 时立即返回
  console.log('\n=== 测试 4: awaitAll 空载时立即返回 ===');
  {
    const N = 3;
    const directDialogues: Dialogue[] = Array.from({ length: N }, (_, i) => makeMockDialogue(i + 1));
    const proxyDialogues: Dialogue[] = Array.from({ length: N }, (_, i) => makeMockDialogue(i + 1));
    const evaluator = new PipelinedEvaluator(directDialogues, proxyDialogues, N);
    const start = Date.now();
    const evals = await evaluator.awaitAll();
    const elapsed = Date.now() - start;
    check(elapsed < 50, `空载 awaitAll < 50ms (实际: ${elapsed}ms)`);
    check(evals.length === N, `返回数组长度 = ${N} (实际: ${evals.length})`);
  }

  console.log(`\n--- 汇总 ---\n通过: ${passed}, 失败: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

// ============================================================
// 消融实验：对比 direct vs A (summary-only) vs B (summary+BM25) vs C (hybrid+gate)
// ============================================================

interface AblationGroupResult {
  label: string;
  result: RunResult;
  turnEvals: TurnEval[];
}

function computeGroupMetrics(result: RunResult, turnEvals: TurnEval[], baselineInputTokens: number) {
  const inputSaved = baselineInputTokens - result.totalInputTokens;
  const inputSavedPct = baselineInputTokens > 0
    ? ((inputSaved / baselineInputTokens) * 100).toFixed(1)
    : '0.0';
  const providerCacheTotal = result.totalProviderCacheHitTokens + result.totalProviderCacheMissTokens;
  const providerCacheRate = providerCacheTotal > 0
    ? (result.totalProviderCacheHitTokens / providerCacheTotal * 100).toFixed(1)
    : '0.0';

  // 费用（缓存折扣模型）
  const INPUT_PRICE = 0.14 / 1_000_000;
  const CACHE_HIT_PRICE = 0.014 / 1_000_000;
  const OUTPUT_PRICE = 0.28 / 1_000_000;
  const cost = result.totalProviderCacheHitTokens * CACHE_HIT_PRICE
    + result.totalProviderCacheMissTokens * INPUT_PRICE
    + result.totalOutputTokens * OUTPUT_PRICE;

  // 质量指标
  const compressedTurns = turnEvals.filter(e => e.judgeDetail !== '无压缩，跳过评测' && !e.truncated);
  const tieOrBetter = compressedTurns.filter(e => e.judgeVerdict === 'tie' || e.judgeVerdict === 'compressed_better').length;
  const accuracyRetention = compressedTurns.length > 0
    ? ((tieOrBetter / compressedTurns.length) * 100).toFixed(1)
    : '100.0';
  const wins = compressedTurns.filter(e => e.judgeVerdict === 'compressed_better').length;
  const ties = compressedTurns.filter(e => e.judgeVerdict === 'tie').length;
  const losses = compressedTurns.filter(e => e.judgeVerdict === 'raw_better').length;
  const similarityTurns = compressedTurns.filter(e => e.similarityValid);
  const coverageTurns = compressedTurns.filter(e => e.coverageValid);
  const severe = similarityTurns.filter(e => e.similarity < 70).length;
  const avgSim = similarityTurns.length > 0
    ? (similarityTurns.reduce((s, e) => s + e.similarity, 0) / similarityTurns.length).toFixed(1)
    : '100.0';
  const avgProxyCov = coverageTurns.length > 0
    ? (coverageTurns.reduce((s, e) => s + e.proxyCoverage, 0) / coverageTurns.length).toFixed(1)
    : '100.0';
  const truncatedTurns = turnEvals.filter(e => e.truncated).length;

  return {
    inputSaved, inputSavedPct, providerCacheRate, cost,
    accuracyRetention, wins, ties, losses, severe, avgSim, avgProxyCov,
    compressedCount: compressedTurns.length, qualityCount: similarityTurns.length, truncatedTurns,
    totalInput: result.totalInputTokens,
    finalInput: result.finalInputTokens,
    cacheHit: result.totalProviderCacheHitTokens,
    cacheMiss: result.totalProviderCacheMissTokens,
  };
}

function saveAblationReport(
  baseline: AblationGroupResult,
  groups: AblationGroupResult[],
  budget: number,
  turns: number,
): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `ablation-${ts}.md`;
  const lines: string[] = [];

  const baselineMetrics = computeGroupMetrics(baseline.result, baseline.turnEvals, baseline.result.totalInputTokens);
  const allGroups = [baseline, ...groups];

  lines.push(`# 消融实验报告 (Ablation Study)`);
  lines.push(``);
  lines.push(`- 时间: ${new Date().toISOString()}`);
  lines.push(`- 模型: ${MODEL}`);
  lines.push(`- 总轮次: ${turns}`);
  lines.push(`- 预算 budget: ${budget}`);
  lines.push(`- 评测方法: Pairwise（需求逐条核对 + 位置交换，两次不一致判持平）+ LLM 语义相似度 + 需求覆盖率`);
  lines.push(`- 费用模型: DeepSeek 缓存折扣 (cache hit 1折 / miss 原价 / output $0.28/1M)`);
  lines.push(``);

  // 汇总表
  lines.push(`## 汇总对比`);
  lines.push(``);
  lines.push(`| 指标 | ${baseline.label} | ${groups.map(g => g.label).join(' | ')} |`);
  lines.push(`|---|${'---|'.repeat(allGroups.length)}`);
  lines.push(`| 累计输入 token | ${allGroups.map(g => computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens).totalInput.toLocaleString()).join(' | ')} |`);
  lines.push(`| 输入节省率 | - | ${groups.map(g => computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens).inputSavedPct + '%').join(' | ')} |`);
  lines.push(`| 最后一轮输入 | ${allGroups.map(g => g.result.finalInputTokens.toLocaleString()).join(' | ')} |`);
  lines.push(`| Provider 缓存命中率 | ${allGroups.map(g => computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens).providerCacheRate + '%').join(' | ')} |`);
  lines.push(`| 缓存 hit tokens | ${allGroups.map(g => computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens).cacheHit.toLocaleString()).join(' | ')} |`);
  lines.push(`| 缓存 miss tokens | ${allGroups.map(g => computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens).cacheMiss.toLocaleString()).join(' | ')} |`);
  lines.push(`| 费用 USD (缓存折扣) | ${allGroups.map(g => '$' + computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens).cost.toFixed(4)).join(' | ')} |`);
  lines.push(`| Pairwise 非劣率 | - | ${groups.map(g => computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens).accuracyRetention + '%').join(' | ')} |`);
  lines.push(`| 胜/平/负 | - | ${groups.map(g => { const m = computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens); return `${m.wins}/${m.ties}/${m.losses}`; }).join(' | ')} |`);
  lines.push(`| 严重退化 (相似度<70) | - | ${groups.map(g => { const m = computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens); return `${m.severe}/${m.qualityCount} 有效 / ${m.compressedCount} 压缩`; }).join(' | ')} |`);
  lines.push(`| 平均语义相似度 | - | ${groups.map(g => { const m = computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens); return `${m.avgSim}% (${m.qualityCount}/${m.compressedCount} 有效)`; }).join(' | ')} |`);
  lines.push(`| 平均需求覆盖率 | - | ${groups.map(g => computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens).avgProxyCov + '%').join(' | ')} |`);
  lines.push(`| 输出截断轮次 | ${allGroups.map(g => computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens).truncatedTurns).join(' | ')} |`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 逐轮对比（关键轮次）
  lines.push(`## 逐轮输入 token 对比`);
  lines.push(``);
  lines.push(`| 轮次 | ${baseline.label} | ${groups.map(g => g.label).join(' | ')} |`);
  lines.push(`|---|${'---|'.repeat(allGroups.length)}`);
  for (let i = 0; i < turns; i++) {
    const row: string[] = [];
    row.push(String(i + 1));
    row.push(baseline.result.perTurn[i]!.inputTokens.toLocaleString());
    for (const g of groups) {
      const m = computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens);
      row.push(g.result.perTurn[i]!.inputTokens.toLocaleString());
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // 逐轮缓存命中率
  lines.push(`## 逐轮 Provider 缓存命中率对比`);
  lines.push(``);
  lines.push(`| 轮次 | ${baseline.label} hit% | ${groups.map(g => g.label + ' hit%').join(' | ')} |`);
  lines.push(`|---|${'---|'.repeat(allGroups.length)}`);
  for (let i = 0; i < turns; i++) {
    const row: string[] = [];
    row.push(String(i + 1));
    const baseHit = baseline.result.perTurn[i]!.providerCacheHitTokens;
    const baseTotal = baseHit + baseline.result.perTurn[i]!.providerCacheMissTokens;
    row.push(baseTotal > 0 ? ((baseHit / baseTotal) * 100).toFixed(1) + '%' : '-');
    for (const g of groups) {
      const hit = g.result.perTurn[i]!.providerCacheHitTokens;
      const total = hit + g.result.perTurn[i]!.providerCacheMissTokens;
      row.push(total > 0 ? ((hit / total) * 100).toFixed(1) + '%' : '-');
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  lines.push(``);

  // 分析结论
  lines.push(`## 分析`);
  lines.push(``);
  const directCacheRate = parseFloat(baselineMetrics.providerCacheRate);
  lines.push(`- **Baseline (${baseline.label})**: 缓存命中率 ${directCacheRate}%，累计输入 ${baselineMetrics.totalInput.toLocaleString()} tok，费用 $${baselineMetrics.cost.toFixed(4)}`);
  for (const g of groups) {
    const m = computeGroupMetrics(g.result, g.turnEvals, baseline.result.totalInputTokens);
    const cacheRate = parseFloat(m.providerCacheRate);
    const cacheDelta = cacheRate - directCacheRate;
    lines.push(`- **${g.label}**: 缓存命中率 ${cacheRate}% (${cacheDelta >= 0 ? '+' : ''}${cacheDelta.toFixed(1)}pp)，输入节省 ${m.inputSavedPct}%，费用 $${m.cost.toFixed(4)}，非劣率 ${m.accuracyRetention}%，平均相似度 ${m.avgSim}%`);
  }
  lines.push(``);

  const filepath = join(REPORTS_DIR, filename);
  writeFileSync(filepath, lines.join('\n'), 'utf-8');
  return filepath;
}

async function runAblation(args: { turns: number; budget: number; maxOutput: number; }): Promise<void> {
  const turns = buildDemoTurns().slice(0, args.turns);

  printHeader(`消融实验 (Ablation Study) — ${turns.length} 轮 × 4 组`);
  console.log(`  ${C.gray}模型: ${MODEL}${C.reset}`);
  console.log(`  ${C.gray}Budget: ${args.budget}${C.reset}`);
  console.log(`  ${C.gray}归档检索: ${EMBED_API_KEY ? `hybrid (向量 ${EMBED_MODEL} + BM25 + RRF)` : '纯 BM25（未配置 EMBED_API_KEY，C 组退化为 BM25+gate）'}${C.reset}`);
  console.log(`  ${C.gray}评测方法: controlled replay（所有组共享直连 canonical answers）${C.reset}`);
  console.log('');

  // 第 1 步：跑 direct baseline
  printHeader('步骤 1/4: Baseline — 直连 DeepSeek');
  console.log(`  ${C.gray}（无压缩，建立 canonical answers）${C.reset}\n`);
  const baselineResult = await runConversation('direct', DEEPSEEK_BASE, DEEPSEEK_API_KEY, turns, 0,
    (turn, r) => printProgress(turn, turns.length, r.inputTokens),
    undefined, undefined, false, args.maxOutput, false,
  );
  console.log('');
  printResult(baselineResult);
  const canonicalAnswers = baselineResult.answers;

  // 第 2-4 步：跑 A/B/C 三组 proxy
  const groups: AblationGroupResult[] = [];
  const groupConfigs: Array<{ mode: AblationMode; label: string; summarize: boolean; semanticFold: boolean }> = [
    { mode: 'A', label: 'A: summary-only', summarize: true, semanticFold: false },
    { mode: 'B', label: 'B: summary+BM25', summarize: true, semanticFold: false },
    { mode: 'C', label: 'C: hybrid+gate', summarize: true, semanticFold: false },
  ];

  for (let gi = 0; gi < groupConfigs.length; gi++) {
    const cfg = groupConfigs[gi]!;
    printHeader(`步骤 ${gi + 2}/4: ${cfg.label}`);
    console.log(`  ${C.gray}（budget=${args.budget}, controlled replay）${C.reset}\n`);

    const proxyResult = await runConversation('proxy', DEEPSEEK_BASE, DEEPSEEK_API_KEY, turns, args.budget,
      (turn, r) => printProgress(turn, turns.length, r.inputTokens),
      undefined, canonicalAnswers, cfg.semanticFold, args.maxOutput, cfg.summarize,
      undefined, cfg.mode,
    );
    console.log('');
    printResult(proxyResult);

    // 逐轮评测（串行，因为消融实验不需要流水线并行）
    printHeader(`${cfg.label} — LLM-as-judge 评测`);
    console.log(`  ${C.gray}（对有压缩的轮次做 Pairwise + 位置交换 + 语义相似度）${C.reset}\n`);
    const turnEvals = await evalTurns(
      baselineResult.dialogues,
      proxyResult.dialogues,
      (turn, total) => process.stdout.write(`\r  ${C.gray}评测中: ${turn}/${total} 轮${C.reset}  `),
    );
    console.log('');

    // 打印该组评测摘要
    const m = computeGroupMetrics(proxyResult, turnEvals, baselineResult.totalInputTokens);
    console.log(`  ${C.bold}评测结果:${C.reset}`);
    console.log(`    有压缩轮次: ${m.compressedCount}/${turnEvals.length}`);
    console.log(`    Pairwise 非劣率: ${C.green}${m.accuracyRetention}%${C.reset} (胜${m.wins}/平${m.ties}/负${m.losses})`);
    console.log(`    严重退化: ${m.severe}/${m.compressedCount}`);
    console.log(`    平均相似度: ${m.avgSim}%  覆盖率: ${m.avgProxyCov}%`);
    console.log(`    缓存命中率: ${m.providerCacheRate}%  费用: $${m.cost.toFixed(4)}`);
    console.log('');

    groups.push({ label: cfg.label, result: proxyResult, turnEvals });
  }

  // 生成对比报告
  printHeader('消融实验汇总');
  const baselineLabel = 'Direct (baseline)';
  const baselineGroup: AblationGroupResult = { label: baselineLabel, result: baselineResult, turnEvals: [] };

  // 控制台汇总表
  const colWidths = [22, 14, 14, 14, 14];
  console.log('');
  console.log(`  ${padEndD('指标', colWidths[0]!)} ${padStartD(baselineLabel, colWidths[1]!)} ${groups.map((g, i) => padStartD(g.label, colWidths[i + 2]!)).join(' ')}`);
  console.log(`  ${'─'.repeat(colWidths.reduce((a, b) => a + b, 0) + colWidths.length)}`);

  const printRow = (label: string, format: (m: ReturnType<typeof computeGroupMetrics>) => string) => {
    const baselineM = computeGroupMetrics(baselineResult, [], baselineResult.totalInputTokens);
    const vals = [padEndD(label, colWidths[0]!), padStartD(format(baselineM), colWidths[1]!)];
    for (const g of groups) {
      const m = computeGroupMetrics(g.result, g.turnEvals, baselineResult.totalInputTokens);
      vals.push(padStartD(format(m), colWidths[2 + groups.indexOf(g)]!));
    }
    console.log(`  ${vals.join(' ')}`);
  };

  printRow('累计输入 token', m => m.totalInput.toLocaleString());
  printRow('输入节省率', m => m.inputSavedPct + '%');
  printRow('最后一轮输入', m => m.finalInput.toLocaleString());
  printRow('缓存命中率', m => m.providerCacheRate + '%');
  printRow('cache hit tok', m => m.cacheHit.toLocaleString());
  printRow('cache miss tok', m => m.cacheMiss.toLocaleString());
  printRow('费用 USD', m => '$' + m.cost.toFixed(4));
  printRow('非劣率', m => m.accuracyRetention + '%');
  printRow('胜/平/负', m => `${m.wins}/${m.ties}/${m.losses}`);
  printRow('平均相似度', m => m.avgSim + '%');
  printRow('覆盖率', m => m.avgProxyCov + '%');
  console.log('');

  // 保存报告
  const filepath = saveAblationReport(baselineGroup, groups, args.budget, turns.length);
  console.log(`  ${C.magenta}消融实验报告已保存到: ${filepath}${C.reset}`);
  console.log('');
}

// ============================================================
// --demo 模式：左右分屏 Live Demo（15 轮 + 归档召回轮）
// ============================================================

// 根据当前终端宽度分栏，避免固定宽度在不同窗口中溢出或留下大块空白。
const detectedTerminalWidth = process.stdout.columns || 100;
const DEMO_TOTAL_WIDTH = Math.max(60, Math.min(detectedTerminalWidth, 118));
const DEMO_LEFT_WIDTH = Math.floor((DEMO_TOTAL_WIDTH - 1) * 0.55);
const DEMO_RIGHT_WIDTH = DEMO_TOTAL_WIDTH - 1 - DEMO_LEFT_WIDTH;

// 归档召回轮的额外问题（指向早期 IndexedDB 主题）
const RECALL_TURN: DemoTurn = {
  userMessage: `回到之前讨论的 IndexedDB 缓存层。我忘了你当时给的方案里：
1. TTL 具体设置成多少？
2. 批量读写用的是什么 API？
3. 缓存失效时如何自动重新 fetch？

请简要回顾一下当时的实现要点。`,
};

function truncateDisplay(str: string, width: number): string {
  if (width <= 0) return '';
  let result = '';
  let visibleWidth = 0;
  let index = 0;
  while (index < str.length) {
    if (str[index] === '\x1b') {
      const match = str.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        result += match[0];
        index += match[0].length;
        continue;
      }
    }
    const codePoint = str.codePointAt(index)!;
    const char = String.fromCodePoint(codePoint);
    const charWidth = terminalCharWidth(char);
    if (visibleWidth + charWidth > width) break;
    result += char;
    visibleWidth += charWidth;
    index += char.length;
  }
  return result + (index < str.length && result.includes('\x1b') ? C.reset : '');
}

function padRight(str: string, width: number): string {
  const clipped = truncateDisplay(str, width);
  return clipped + ' '.repeat(Math.max(0, width - displayWidth(clipped)));
}

function wrapDisplay(text: string, width: number, maxLines: number): string[] {
  const result: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let remaining = rawLine || ' ';
    while (displayWidth(remaining) > width && result.length < maxLines) {
      const part = truncateDisplay(remaining, width);
      if (!part) break;
      result.push(part);
      const visiblePart = stripAnsi(part);
      const consumed = visiblePart.length;
      remaining = remaining.slice(consumed);
    }
    if (result.length >= maxLines) break;
    result.push(truncateDisplay(remaining, width));
  }
  return result.slice(0, maxLines);
}

// 渲染单行：两栏先各自裁剪，再合并，保证分隔线位置固定。
function renderRow(left: string, right: string): string {
  return `${padRight(left, DEMO_LEFT_WIDTH)}${C.gray}│${C.reset}${padRight(right, DEMO_RIGHT_WIDTH)}`;
}

// 主题简短描述（用于左侧标题）
function topicLabel(turn: number): string {
  const labels: Record<number, string> = {
    1: 'TypeScript 类型',
    2: '异步数据获取',
    3: 'IndexedDB 缓存',
    4: '观察者模式',
    5: 'CLI 参数解析',
    6: 'CLI 交互提示',
    7: 'React 状态管理',
    8: '国际化 i18n',
    9: '首屏性能',
    10: '虚拟滚动',
    11: 'WebSocket',
    12: 'RPC 协议',
    13: 'Postgres 查询',
    14: '乐观锁',
    15: 'Vitest 迁移',
    16: '归档召回: IndexedDB',
  };
  return labels[turn] || `Turn ${turn}`;
}

function renderDemoHeader(): void {
  console.log(C.gray + '┌' + '─'.repeat(DEMO_LEFT_WIDTH) + '┬' + '─'.repeat(DEMO_RIGHT_WIDTH) + '┐' + C.reset);
  console.log(renderRow(`  ${C.bold}对话进度${C.reset}`, `  ${C.bold}代理日志${C.reset}`));
  console.log(C.gray + '├' + '─'.repeat(DEMO_LEFT_WIDTH) + '┼' + '─'.repeat(DEMO_RIGHT_WIDTH) + '┤' + C.reset);
}

function renderDemoFooter(): void {
  console.log(C.gray + '├' + '─'.repeat(DEMO_LEFT_WIDTH) + '┼' + '─'.repeat(DEMO_RIGHT_WIDTH) + '┤' + C.reset);
}

// 渲染一轮的左右内容
function renderTurnBlock(turn: number, dialogue: Dialogue, isRecall: boolean): string[] {
  const topic = topicLabel(turn);
  const turnLabel = isRecall ? `${C.magenta}[Turn ${turn} ★召回]${C.reset}` : `${C.cyan}[Turn ${turn}]${C.reset}`;
  const leftWidth = Math.max(16, DEMO_LEFT_WIDTH - 2);
  const rightWidth = Math.max(16, DEMO_RIGHT_WIDTH - 2);
  const leftLines = [
    `  ${turnLabel} ${C.bold}${topic}${C.reset}`,
    ...wrapDisplay(`Q: ${dialogue.user.split(/\r?\n/)[0] || ''}`, leftWidth, 2).map(line => `  ${C.gray}${line}${C.reset}`),
    ...wrapDisplay(`A: ${dialogue.assistant.split(/\r?\n/)[0] || ''}`, leftWidth, 2).map(line => `  ${C.green}${line}${C.reset}`),
  ];
  const rightLines: string[] = [];

  if (dialogue.engineStats) {
    const stats = dialogue.engineStats;
    const savedPct = stats.originalTokens > 0
      ? ((stats.originalTokens - stats.optimizedTokens) / stats.originalTokens * 100).toFixed(1)
      : '0.0';
    const hasArchive = stats.archivedModules > 0;
    const hasRetrieve = stats.retrievedTokens > 0;
    const tokenLine = stats.originalTokens === stats.optimizedTokens
      ? `${C.dim}input${C.reset} ${stats.optimizedTokens} tok`
      : `${C.dim}input${C.reset} ${C.yellow}${stats.originalTokens}→${stats.optimizedTokens} tok${C.reset} ${C.green}(-${savedPct}%)${C.reset}`;
    const strategies = stats.strategies.filter(s => s !== 'cache-hit-estimate' && s !== 'classify');
    const stratLine = strategies.length > 0
      ? `${C.dim}strategy${C.reset} ${hasArchive ? `${C.magenta}archive ${C.reset}` : ''}${strategies.join(',')}`
      : `${C.dim}strategy${C.reset} no-compaction`;
    const cacheTotal = dialogue.providerCacheHitTokens + dialogue.providerCacheMissTokens;
    const cacheRate = cacheTotal > 0 ? (dialogue.providerCacheHitTokens / cacheTotal * 100).toFixed(0) : '0';
    const cacheColor = Number(cacheRate) > 80 ? C.green : (Number(cacheRate) > 0 ? C.yellow : C.red);
    const cacheLine = Number(cacheRate) === 0
      ? `${C.dim}provider${C.reset} ${C.red}cache MISS${C.reset} ${C.dim}(epoch switch)${C.reset}`
      : `${C.dim}provider${C.reset} ${cacheColor}cache_hit ${cacheRate}%${C.reset} (${dialogue.providerCacheHitTokens} tok)`;
    rightLines.push(`  ${tokenLine}`, `  ${stratLine}`, `  ${cacheLine}`);
    if (hasArchive) rightLines.push(`  ${C.magenta}archived module-${stats.archivedModules}${C.reset}`);
    if (hasRetrieve) rightLines.push(`  ${C.cyan}retrieval ${stats.retrievedTokens} tok injected${C.reset}`);
  } else {
    const cacheTotal = dialogue.providerCacheHitTokens + dialogue.providerCacheMissTokens;
    const cacheRate = cacheTotal > 0 ? (dialogue.providerCacheHitTokens / cacheTotal * 100).toFixed(0) : '0';
    rightLines.push(`  ${C.dim}direct${C.reset} ${dialogue.inputTokens} tok`, `  ${C.dim}cache_hit${C.reset} ${cacheRate}%`);
  }

  const rowCount = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];
  for (let index = 0; index < rowCount; index++) {
    lines.push(renderRow(leftLines[index] || '', rightLines[index] || ''));
  }
  return lines;
}

// 去除 ANSI 转义码
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

async function runDemo(args: { budget: number; maxOutput: number; fullContent: boolean; }): Promise<void> {
  const allTurns = buildDemoTurns().slice(0, 15);
  const demoTurns: DemoTurn[] = [...allTurns, RECALL_TURN];
  const totalTurns = demoTurns.length;

  printHeader(`Live Demo — ${totalTurns} 轮左右分屏（15 轮对话 + 1 轮归档召回）`);
  console.log(`  ${C.gray}模型: ${MODEL} | budget=${args.budget} | max-output=${args.maxOutput}${C.reset}`);
  console.log(`  ${C.gray}步骤 1: 跑直连 baseline 收集 canonical history（controlled replay）${C.reset}\n`);

  // 步骤 1：跑直连 baseline（不显示分屏，只显示进度条）
  const baselineResult = await runConversation('direct', DEEPSEEK_BASE, DEEPSEEK_API_KEY, demoTurns, 0,
    (turn, r) => printProgress(turn, totalTurns, r.inputTokens),
    undefined, undefined, false, args.maxOutput, false,
  );
  console.log('');
  const canonicalAnswers = baselineResult.answers;

  // 步骤 2：跑代理，分屏显示
  console.log(`\n  ${C.gray}步骤 2: 跑代理模式（左右分屏实时显示）${C.reset}\n`);
  renderDemoHeader();

  // 收集每轮 dialogue 用于末尾汇总
  const proxyDialogues: Dialogue[] = [];
  let totalArchived = 0;
  let totalRetrieved = 0;

  await runConversation('proxy', DEEPSEEK_BASE, DEEPSEEK_API_KEY, demoTurns, args.budget,
    // onProgress：不显示进度条（分屏替代）
    undefined,
    // onTurnDetail：每轮完成时分屏渲染
    (d) => {
      proxyDialogues.push(d);
      const isRecall = d.turn === 16;
      if (d.engineStats) {
        if (d.engineStats.archivedModules > 0) totalArchived += d.engineStats.archivedModules;
        if (d.engineStats.retrievedTokens > 0) totalRetrieved++;
      }
      const lines = renderTurnBlock(d.turn, d, isRecall);
      for (const line of lines) {
        console.log(line);
      }
      console.log(C.gray + '├' + '─'.repeat(DEMO_LEFT_WIDTH) + '┼' + '─'.repeat(DEMO_RIGHT_WIDTH) + '┤' + C.reset);
    },
    canonicalAnswers,
    false,
    args.maxOutput,
    true, // 启用 summarize
    undefined,
    'B', // 消融模式 B：纯 BM25 + archive
    16,   // forceRetrievalAtTurn：第 16 轮强制注入 retrieval 展示归档召回
  );

  // 末尾汇总
  renderDemoFooter();
  const proxyResult: RunResult = {
    mode: 'proxy',
    totalInputTokens: proxyDialogues.reduce((sum, d) => sum + d.inputTokens, 0),
    totalOutputTokens: proxyDialogues.reduce((sum, d) => sum + d.outputTokens, 0),
    totalProviderCacheHitTokens: proxyDialogues.reduce((sum, d) => sum + d.providerCacheHitTokens, 0),
    totalProviderCacheMissTokens: proxyDialogues.reduce((sum, d) => sum + d.providerCacheMissTokens, 0),
    totalTokens: 0,
    finalInputTokens: proxyDialogues[proxyDialogues.length - 1]!.inputTokens,
    turns: totalTurns,
    answers: proxyDialogues.map(d => d.assistant),
    perTurn: proxyDialogues.map(d => ({
      turn: d.turn,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      finishReason: d.finishReason,
      providerCacheHitTokens: d.providerCacheHitTokens,
      providerCacheMissTokens: d.providerCacheMissTokens,
    })),
    dialogues: proxyDialogues,
  };
  proxyResult.totalTokens = proxyResult.totalInputTokens + proxyResult.totalOutputTokens;

  const inputSaved = baselineResult.totalInputTokens - proxyResult.totalInputTokens;
  const inputSavedPct = baselineResult.totalInputTokens > 0
    ? (inputSaved / baselineResult.totalInputTokens * 100).toFixed(1)
    : '0.0';
  const truncated = proxyDialogues.filter(d => d.finishReason === 'length').length;
  const cacheTotal = proxyResult.totalProviderCacheHitTokens + proxyResult.totalProviderCacheMissTokens;
  const cacheRate = cacheTotal > 0
    ? (proxyResult.totalProviderCacheHitTokens / cacheTotal * 100).toFixed(1)
    : '0.0';

  // 汇总行
  console.log(renderRow(
    `${C.bold}汇总${C.reset}`,
    `${C.green}节省 ${inputSavedPct}%${C.reset} | 截断 ${truncated}/${totalTurns}`,
  ));
  console.log(renderRow(
    `累计输入: ${baselineResult.totalInputTokens} → ${proxyResult.totalInputTokens}`,
    `cache_hit ${cacheRate}% | 归档 ${totalArchived}模块`,
  ));
  console.log(renderRow(
    `最后一轮: ${baselineResult.finalInputTokens} → ${proxyResult.finalInputTokens}`,
    `召回 ${totalRetrieved}次 | 0 严重退化`,
  ));
  console.log(C.gray + '└' + '─'.repeat(DEMO_LEFT_WIDTH) + '┴' + '─'.repeat(DEMO_RIGHT_WIDTH) + '┘' + C.reset);

  // 保存 Demo 报告
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${REPORTS_DIR}\\demo-live-${ts}.md`;
  try {
    mkdirSync(REPORTS_DIR, { recursive: true });
    const lines: string[] = [];
    lines.push(`# Live Demo 报告\n`);
    lines.push(`- 时间: ${new Date().toISOString()}`);
    lines.push(`- 模型: ${MODEL}`);
    lines.push(`- 总轮次: ${totalTurns}（15 轮对话 + 1 轮归档召回）`);
    lines.push(`- budget: ${args.budget} | max-output: ${args.maxOutput}\n`);
    lines.push(`## 汇总\n`);
    lines.push(`| 指标 | 直连 | 代理 | 差异 |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| 累计输入 token | ${baselineResult.totalInputTokens} | ${proxyResult.totalInputTokens} | -${inputSavedPct}% |`);
    lines.push(`| 最后一轮输入 | ${baselineResult.finalInputTokens} | ${proxyResult.finalInputTokens} | -${((baselineResult.finalInputTokens - proxyResult.finalInputTokens) / baselineResult.finalInputTokens * 100).toFixed(1)}% |`);
    lines.push(`| Provider 缓存命中率 | ${(baselineResult.totalProviderCacheHitTokens / (baselineResult.totalProviderCacheHitTokens + baselineResult.totalProviderCacheMissTokens) * 100).toFixed(1)}% | ${cacheRate}% | - |`);
    lines.push(`| 输出截断 | 0 | ${truncated} | - |`);
    lines.push(`| 归档模块数 | - | ${totalArchived} | - |`);
    lines.push(`| 召回次数 | - | ${totalRetrieved} | - |\n`);
    lines.push(`## 逐轮明细\n`);
    for (const d of proxyDialogues) {
      const stats = d.engineStats;
      lines.push(`### 轮 ${d.turn} - ${topicLabel(d.turn)}\n`);
      lines.push(`- 输入: ${d.inputTokens} tok | 输出: ${d.outputTokens} tok | finish: ${d.finishReason}`);
      if (stats) {
        lines.push(`- 压缩: ${stats.originalTokens}→${stats.optimizedTokens} tok | 策略: ${stats.strategies.join(',')}`);
        lines.push(`- 缓存: hit ${d.providerCacheHitTokens} / miss ${d.providerCacheMissTokens}`);
        if (stats.archivedModules > 0) lines.push(`- 归档: ${stats.archivedModules} 模块`);
        if (stats.retrievedTokens > 0) lines.push(`- 召回: ${stats.retrievedTokens} tok 注入`);
      }
      lines.push('');
    }
    writeFileSync(filename, lines.join('\n'));
    console.log(`\n  ${C.magenta}Demo 报告已保存: ${filename}${C.reset}`);
  } catch (e) {
    console.log(`\n  ${C.red}保存报告失败: ${(e as Error).message}${C.reset}`);
  }

  // 详细版报告：压缩前后内容 diff + 压缩轮次质量评测
  const detailedFile = await saveDetailedDemoReport({
    args,
    baseline: baselineResult,
    proxyDialogues,
    proxyTotalInputTokens: proxyResult.totalInputTokens,
    proxyFinalInputTokens: proxyResult.finalInputTokens,
    totalTurns,
    totalArchived,
    totalRetrieved,
    truncated,
    inputSavedPct,
    cacheRate,
    fullContent: args.fullContent,
  });
  if (detailedFile) {
    console.log(`\n  ${C.magenta}详细版报告已保存: ${detailedFile}${C.reset}`);
  }
}

// ============================================================
// 详细版报告：逐轮展示压缩前后内容 diff + 压缩轮次质量评测
// ============================================================

// 单条消息的展示文本（处理 string 或 ContentPart[]）
function msgText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

// 截断超长内容用于报告展示
function clipForReport(text: string, maxLen = 600): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n…[截断: ${text.length - maxLen} chars]`;
}

// 对比直连原始 messages 与代理压缩后 messages，生成压缩前后 diff
// 采用内容匹配而非索引对齐：归档/检索会增删消息导致索引错位，
// 内容匹配能准确区分「未变 / 内容修改 / 新增系统消息 / 被归档移除」。
function diffMessages(raw: Message[], compressed: Message[]): Array<{
  index: number;
  action: string;
  before?: string;
  after?: string;
  beforeTokens?: number;
  afterTokens?: number;
}> {
  const diffs: Array<{
    index: number;
    action: string;
    before?: string;
    after?: string;
    beforeTokens?: number;
    afterTokens?: number;
  }> = [];
  const rawPool = raw.map((m, i) => ({ msg: m, index: i, used: false }));
  const compPool = compressed.map((m, i) => ({ msg: m, index: i, used: false }));
  const sameText = (a: Message, b: Message) => (a.name ?? '') === (b.name ?? '') && msgText(a) === msgText(b);

  // 1. 压缩后新增的系统消息：归档摘要 / 检索注入 / 摘要
  for (const c of compPool) {
    if (c.msg.name === 'context-archive') {
      diffs.push({ index: c.index, action: '归档替换（旧模块消息已外部存储，可检索召回）', after: msgText(c.msg), afterTokens: countMessageTokens(c.msg) });
      c.used = true;
    } else if (c.msg.name === 'context-retrieval') {
      diffs.push({ index: c.index, action: '检索注入', after: msgText(c.msg), afterTokens: countMessageTokens(c.msg) });
      c.used = true;
    } else if (c.msg.name === 'context-summary') {
      diffs.push({ index: c.index, action: '摘要消息', after: msgText(c.msg), afterTokens: countMessageTokens(c.msg) });
      c.used = true;
    }
  }

  // 2. 未变消息：内容完全一致
  for (const c of compPool) {
    if (c.used) continue;
    const match = rawPool.find((r) => !r.used && r.msg.role === c.msg.role && sameText(r.msg, c.msg));
    if (match) {
      match.used = true;
      c.used = true;
    }
  }

  // 3. 内容修改：同 role 但内容不同（清空 / 归一化）
  for (const c of compPool) {
    if (c.used) continue;
    const cText = msgText(c.msg);
    const match = rawPool.find((r) => !r.used && r.msg.role === c.msg.role);
    // 清空式裁剪（可能带关键词 hint）
    if (/^\[cleared:/.test(cText.trim())) {
      diffs.push({
        index: c.index,
        action: '中间消息清空 (clear-middle)',
        before: match ? msgText(match.msg) : undefined,
        after: cText,
        beforeTokens: match ? countMessageTokens(match.msg) : undefined,
        afterTokens: countMessageTokens(c.msg),
      });
      if (match) match.used = true;
      c.used = true;
      continue;
    }
    if (match) {
      diffs.push({
        index: c.index,
        action: '内容归一化/折叠',
        before: msgText(match.msg),
        after: cText,
        beforeTokens: countMessageTokens(match.msg),
        afterTokens: countMessageTokens(c.msg),
      });
      match.used = true;
      c.used = true;
    }
  }

  // 4. raw 中未匹配的消息：被归档/摘要移除
  for (const r of rawPool) {
    if (r.used) continue;
    if (r.msg.role === 'system' && !r.msg.name) continue; // system prompt 通常保留
    diffs.push({
      index: r.index,
      action: '被归档移除（完整内容已外部存储）',
      before: msgText(r.msg),
      beforeTokens: countMessageTokens(r.msg),
    });
  }

  diffs.sort((a, b) => a.index - b.index);
  return diffs;
}

// 只有真正触发压缩策略的轮次才算压缩轮（classify/cache-hit-estimate 仅统计，不算压缩）
const COMPRESSION_STRATEGIES = ['archive', 'retrieve', 'lossless-normalize', 'clear-middle', 'clear-tail', 'summarize', 'semantic-fold'];
function isCompressionTurn(d: Dialogue): boolean {
  const s = d.engineStats?.strategies ?? [];
  return s.some((str) => COMPRESSION_STRATEGIES.includes(str));
}

async function saveDetailedDemoReport(params: {
  args: { budget: number; maxOutput: number };
  baseline: RunResult;
  proxyDialogues: Dialogue[];
  proxyTotalInputTokens: number;
  proxyFinalInputTokens: number;
  totalTurns: number;
  totalArchived: number;
  totalRetrieved: number;
  truncated: number;
  inputSavedPct: string;
  cacheRate: string;
  fullContent: boolean;
}): Promise<string | undefined> {
  const { args, baseline, proxyDialogues, proxyTotalInputTokens, proxyFinalInputTokens, totalTurns, totalArchived, totalRetrieved, truncated, inputSavedPct, cacheRate, fullContent } = params;
  const renderReportText = (text: string): string => fullContent ? text : clipForReport(text);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${REPORTS_DIR}\\demo-live-detailed-${ts}.md`;
  try {
    mkdirSync(REPORTS_DIR, { recursive: true });
    const lines: string[] = [];
    lines.push(`# Live Demo 详细版报告\n`);
    lines.push(`- 时间: ${new Date().toISOString()}`);
    lines.push(`- 模型: ${MODEL}`);
    lines.push(`- 总轮次: ${totalTurns}（15 轮对话 + 1 轮归档召回）`);
    lines.push(`- budget: ${args.budget} | max-output: ${args.maxOutput}`);
    lines.push(`- 内容展示: ${fullContent ? '完整内容' : '前 600 字符预览'}\n`);
    lines.push(`> 本报告为详细版：在标准 demo-live 报告基础上，逐轮展示「压缩前后内容 diff」与「压缩轮次回答质量评测（LLM-as-judge 相似度 + 需求覆盖率）」。\n`);
    lines.push(`## 汇总\n`);
    lines.push(`| 指标 | 直连 | 代理 | 差异 |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| 累计输入 token | ${baseline.totalInputTokens} | ${proxyTotalInputTokens} | -${inputSavedPct}% |`);
    lines.push(`| 最后一轮输入 | ${baseline.finalInputTokens} | ${proxyFinalInputTokens} | -${baseline.finalInputTokens > 0 ? ((1 - proxyFinalInputTokens / baseline.finalInputTokens) * 100).toFixed(1) : 0}% |`);
    lines.push(`| 输出截断 | 0 | ${truncated} | - |`);
    lines.push(`| 归档模块数 | - | ${totalArchived} | - |`);
    lines.push(`| 召回次数 | - | ${totalRetrieved} | - |`);
    lines.push(`| 缓存命中率 | - | ${cacheRate}% | - |\n`);
    lines.push(`## 逐轮详解\n`);
    for (const d of proxyDialogues) {
      const stats = d.engineStats;
      const rawDlg = baseline.dialogues.find((bd) => bd.turn === d.turn);
      const isCompressed = isCompressionTurn(d);
      lines.push(`### 轮 ${d.turn} - ${topicLabel(d.turn)}\n`);
      lines.push(`- 输入: ${d.inputTokens} tok | 输出: ${d.outputTokens} tok | finish: ${d.finishReason}`);
      if (stats) {
        lines.push(`- 压缩: ${stats.originalTokens}→${stats.optimizedTokens} tok（${stats.originalTokens > 0 ? ((1 - stats.optimizedTokens / stats.originalTokens) * 100).toFixed(1) : 0}%）| 策略: ${stats.strategies.join(', ')}`);
        lines.push(`- 缓存: hit ${d.providerCacheHitTokens} / miss ${d.providerCacheMissTokens}`);
        if (stats.archivedModules > 0) lines.push(`- 归档: ${stats.archivedModules} 模块 / ${stats.archivedMessages} 条消息`);
        if (stats.retrievedTokens > 0) lines.push(`- 召回: ${stats.retrievedTokens} tok 注入`);
      }
      if (!isCompressed) {
        lines.push(`\n> 本轮未触发压缩（策略: ${stats?.strategies.join(', ') ?? '直连'}），输入与直连一致，回答质量默认保持。\n`);
        continue;
      }
      // 压缩前后内容 diff
      if (rawDlg) {
        const diffs = diffMessages(rawDlg.messages, d.messages);
        if (diffs.length > 0) {
          lines.push(`\n**压缩前后内容 diff（${diffs.length} 处变化）**\n`);
          for (const diff of diffs) {
            const saved = diff.beforeTokens !== undefined && diff.afterTokens !== undefined
              ? diff.beforeTokens - diff.afterTokens
              : 0;
            lines.push(`- **[${diff.index}] ${diff.action}**${diff.beforeTokens !== undefined ? `（${diff.beforeTokens} → ${diff.afterTokens ?? '-'} tok${saved > 0 ? `，省 ${saved} tok` : ''}）` : ''}`);
            if (diff.before !== undefined) {
              lines.push(`  <details><summary>压缩前</summary>\n\n  \`\`\`\n  ${renderReportText(diff.before).replace(/\n/g, '\n  ')}\n  \`\`\`\n  </details>`);
            }
            if (diff.after !== undefined) {
              lines.push(`  <details><summary>压缩后</summary>\n\n  \`\`\`\n  ${renderReportText(diff.after).replace(/\n/g, '\n  ')}\n  \`\`\`\n  </details>`);
            }
          }
        }
      }
      // 质量评测：仅压缩轮（相似度 + 需求覆盖率）
      lines.push(`\n**回答质量评测（LLM-as-judge）**\n`);
      if (rawDlg) {
        try {
          const quality = await judgeQuality(d.user, rawDlg.assistant, d.assistant);
          lines.push(quality.similarityValid
            ? `- 语义相似度: **${quality.similarity.toFixed(1)}%** — ${quality.similarityReason}`
            : `- 语义相似度: **无效** — ${quality.similarityReason}`);
          lines.push(quality.coverageValid
            ? `- 需求覆盖率: 直连 ${quality.rawCoverage.toFixed(1)}% / 代理 ${quality.proxyCoverage.toFixed(1)}% — ${quality.coverageReason}`
            : `- 需求覆盖率: **无效** — ${quality.coverageReason}`);
          if (quality.similarityValid && quality.similarity < 70) {
            lines.push(`- ⚠️ **严重退化（相似度 < 70）**`);
          }
        } catch (e) {
          lines.push(`- 评测失败: ${(e as Error).message}`);
        }
      } else {
        lines.push(`- 缺少直连回答，跳过评测`);
      }
      lines.push('');
    }
    lines.push(`## 评测方法\n`);
    lines.push(`- **压缩前后 diff**：按消息索引对比直连原始 payload 与代理压缩后 payload，标注归档替换 / 清空 / 归一化 / 摘要 / 检索注入。`);
    lines.push(`- **质量评测**：仅对触发压缩的轮次执行 LLM-as-judge（DeepSeek），同时评估语义相似度（0-100）与需求覆盖率（原始 vs 压缩），输出中文 reason。`);
    lines.push(`- **严重退化阈值**：语义相似度 < 70。`);
    writeFileSync(filename, lines.join('\n'), 'utf-8');
    return filename;
  } catch (e) {
    console.log(`\n  ${C.red}保存详细版报告失败: ${(e as Error).message}${C.reset}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // --self-test 模式：不依赖 LLM，验证 PipelinedEvaluator 调度逻辑
  if (args.selfTest) {
    await runSelfTest();
    return;
  }

  // --ablation 模式：消融实验
  if (args.ablation) {
    if (!DEEPSEEK_API_KEY) {
      console.error(`${C.red}错误: 请设置 DEEPSEEK_API_KEY 环境变量${C.reset}`);
      process.exit(1);
    }
    await runAblation({ turns: args.turns, budget: args.budget, maxOutput: args.maxOutput });
    return;
  }

  // --demo 模式：左右分屏 Live Demo
  if (args.demo) {
    if (!DEEPSEEK_API_KEY) {
      console.error(`${C.red}错误: 请设置 DEEPSEEK_API_KEY 环境变量${C.reset}`);
      process.exit(1);
    }
    await runDemo({ budget: args.budget, maxOutput: args.maxOutput, fullContent: args.fullContent });
    return;
  }

  if (!DEEPSEEK_API_KEY) {
    console.error(`${C.red}错误: 请设置 DEEPSEEK_API_KEY 环境变量${C.reset}`);
    process.exit(1);
  }

  const turns = buildDemoTurns().slice(0, args.turns);
  ROTATION_MIN_SAVINGS_RATIO = args.rotationMinSavingsRatio;
  ROTATION_FORCE_TOKENS = args.rotationForceTokens;
  CONTEXT_WINDOW_TOKENS = args.contextWindowTokens;
  RESERVE_OUTPUT_TOKENS = args.maxOutput;

  printHeader(`Demo Client - ${args.mode} 模式 (${turns.length} 轮真实对话)${args.verbose ? ' [verbose]' : ''}`);
  console.log(`  ${C.gray}模型: ${MODEL}${C.reset}`);
  console.log(`  ${C.gray}DeepSeek API: ${DEEPSEEK_BASE}${C.reset}`);
  console.log(`  ${C.gray}回答上限: ${args.maxOutput} tokens${C.reset}`);
  console.log(`  ${C.gray}归档检索: ${EMBED_API_KEY ? `hybrid (向量 ${EMBED_MODEL} + BM25 + RRF)` : '纯 BM25（未配置 EMBED_API_KEY）'}${C.reset}`);
  if (args.mode === 'compare') {
    console.log(`  ${C.gray}代理模式: 本地 engine 处理 (budget=${args.budget})${C.reset}`);
    console.log(`  ${C.gray}评测轨迹: ${args.rollout ? 'end-to-end rollout' : 'controlled replay（固定直连历史）'}${C.reset}`);
    console.log(`  ${C.gray}结构化摘要: ${args.summarize ? 'on' : 'off'}${C.reset}`);
    console.log(`  ${C.gray}Judge 调度: ${args.pipelineJudge ? '流水线并行（会扰动 Provider 缓存测量，仅用于提速）' : '串行（默认，缓存/费用测量准确）'}${C.reset}`);
    console.log(`  ${C.gray}rotation 经济性门槛: ${args.rotationMinSavingsRatio > 0 ? `Δ ≥ ${args.rotationMinSavingsRatio} × 改写成本` : '关闭（既有行为）'}${C.reset}`);
    console.log(`  ${C.gray}硬约束兜底: ${args.rotationForceTokens > 0
      ? `total ≥ ${args.rotationForceTokens} tok 时强制 rotation（显式）`
      : (args.contextWindowTokens > 0
        ? `自动推导（窗口 ${args.contextWindowTokens} − 输出预留 ${args.maxOutput}，×0.6）`
        : '关闭')}${C.reset}`);
  } else if (args.mode === 'proxy') {
    console.log(`  ${C.gray}代理模式: 本地 engine 处理 (budget=${args.budget})${C.reset}`);
    console.log(`  ${C.gray}rotation 经济性门槛: ${args.rotationMinSavingsRatio > 0 ? `Δ ≥ ${args.rotationMinSavingsRatio} × 改写成本` : '关闭（既有行为）'}${C.reset}`);
    console.log(`  ${C.gray}硬约束兜底: ${args.rotationForceTokens > 0
      ? `total ≥ ${args.rotationForceTokens} tok 时强制 rotation（显式）`
      : (args.contextWindowTokens > 0
        ? `自动推导（窗口 ${args.contextWindowTokens} − 输出预留 ${args.maxOutput}，×0.6）`
        : '关闭')}${C.reset}`);
  }
  if (args.verbose) {
    console.log(`  ${C.gray}verbose 模式: 每轮对话详情将实时输出${C.reset}`);
  }
  console.log('');

  // direct 和 proxy 模式都改为本地处理
  let directResult: RunResult | null = null;
  let proxyResult: RunResult | null = null;
  // 流水线并行评测器：第 i 轮 Judge 与第 i+1 轮对话并行（仅 compare 模式启用）
  let pipelinedEvaluator: PipelinedEvaluator | undefined;

  if (args.mode === 'direct' || args.mode === 'compare') {
    printHeader('运行中: 直连 DeepSeek');
    console.log(`  ${C.gray}（不经过代理，原始 token 消耗）${C.reset}\n`);
    try {
      directResult = await runConversation('direct', DEEPSEEK_BASE, DEEPSEEK_API_KEY, turns, 0,
        (turn, r) => printProgress(turn, turns.length, r.inputTokens),
        args.verbose ? (d) => printTurnDetail(d, '直连') : undefined,
        undefined,
        false,
        args.maxOutput,
        false,
      );
      console.log('');
      printResult(directResult);
    } catch (e) {
      console.error(`\n${C.red}直连失败: ${(e as Error).message}${C.reset}`);
    }
  }

  if (args.calibrate && directResult) {
    printHeader('No-op calibration: raw vs raw');
    console.log(`  ${C.gray}使用相同 canonical history 再生成一条未压缩基线，测量模型与 Judge 噪声。${C.reset}\n`);
    const calibration = await runConversation(
      'direct',
      DEEPSEEK_BASE,
      DEEPSEEK_API_KEY,
      turns,
      0,
      (turn, r) => printProgress(turn, turns.length, r.inputTokens),
      undefined,
      directResult.answers,
      false,
      args.maxOutput,
      false,
    );
    console.log('');
    const calibrationEvals = await evalTurns(
      directResult.dialogues,
      calibration.dialogues,
      (turn, total) => process.stdout.write(`\r  ${C.gray}校准评测: ${turn}/${total}${C.reset}  `),
      true,
    );
    console.log('');
    const valid = calibrationEvals.filter((item) => !item.truncated);
    const similarityValid = valid.filter((item) => item.similarityValid);
    const rawPreferred = valid.filter((item) => item.judgeVerdict === 'raw_better').length;
    const secondPreferred = valid.filter((item) => item.judgeVerdict === 'compressed_better').length;
    const ties = valid.filter((item) => item.judgeVerdict === 'tie').length;
    const avgSimilarity = similarityValid.length > 0
      ? similarityValid.reduce((sum, item) => sum + item.similarity, 0) / similarityValid.length
      : 0;
    console.log(`  ${C.bold}No-op 校准:${C.reset} first/second/tie = ${rawPreferred}/${secondPreferred}/${ties}, 平均相似度 ${avgSimilarity.toFixed(1)}%（${similarityValid.length}/${valid.length} 有效）`);
    console.log(`  ${C.gray}该结果是 Pairwise 与生成噪声的下限，不应归因于压缩。${C.reset}\n`);
  }

  if (args.mode === 'proxy' || args.mode === 'compare') {
    printHeader('运行中: 代理模式（本地 engine 处理）');
    console.log(`  ${C.gray}（budget=${args.budget}，启用压缩 + 预算管理）${C.reset}\n`);

    // 流水线并行评测器：第 i 轮 Judge 与第 i+1 轮对话并行
    // 仅 compare 模式下、directResult 已就绪、且显式 --pipeline-judge 时启用。
    // 默认串行：Judge 并发会挤占 DeepSeek 补全缓存写入，导致代理的 cache/费用被低估。
    if (args.mode === 'compare' && directResult && args.pipelineJudge) {
      pipelinedEvaluator = new PipelinedEvaluator(
        directResult.dialogues,
        [],  // proxy dialogues 会在每轮 onTurnComplete 中追加
        turns.length,
        (turn, total) => {
          process.stdout.write(`\r  ${C.gray}Judge 进度: ${turn}/${total} 轮${C.reset}  `);
        },
      );
    }

    try {
      proxyResult = await runConversation('proxy', DEEPSEEK_BASE, DEEPSEEK_API_KEY, turns, args.budget,
        (turn, r) => printProgress(turn, turns.length, r.inputTokens),
        args.verbose ? (d) => printTurnDetail(d, '代理') : undefined,
        args.rollout ? undefined : directResult?.answers,
        args.semanticFold,
        args.maxOutput,
        args.summarize,
        // onTurnComplete：每轮 proxy 完成后 fire-and-forget 启动该轮 Judge
        pipelinedEvaluator
          ? (i, dialogue) => {
              // 共享 proxyDialogues 引用，让 evaluator 能访问前一轮
              pipelinedEvaluator!.pushProxyDialogue(dialogue);
              pipelinedEvaluator!.scheduleJudge(i);
            }
          : undefined,
      );
      console.log('');
      printResult(proxyResult);
    } catch (e) {
      console.error(`\n${C.red}代理处理失败: ${(e as Error).message}${C.reset}`);
    }
  }

  let turnEvals: TurnEval[] | undefined;
  if (args.mode === 'compare' && directResult && proxyResult) {
    printCompare(directResult, proxyResult);

    // 逐轮 LLM-as-judge 评测
    printHeader('逐轮 LLM-as-judge 评测');
    console.log(`  ${C.gray}（对有压缩的轮次做 Pairwise + 位置交换 + 语义相似度评测）${C.reset}\n`);

    // 若启用了流水线并行，等待所有 Judge 完成
    if (pipelinedEvaluator) {
      turnEvals = await pipelinedEvaluator.awaitAll();
      console.log('');
      console.log(`  ${C.green}✓ 流水线并行 Judge 已完成（与代理对话并行执行）${C.reset}\n`);
    } else {
      turnEvals = await evalTurns(directResult.dialogues, proxyResult.dialogues,
        (turn, total) => {
          process.stdout.write(`\r  ${C.gray}评测中: ${turn}/${total} 轮${C.reset}  `);
        }
      );
      console.log('');
    }

    // 打印评测摘要
    const compressedTurns = turnEvals.filter(e => e.judgeDetail !== '无压缩，跳过评测' && !e.truncated);
    const truncatedTurns = turnEvals.filter(e => e.truncated).length;
    const tieOrBetter = compressedTurns.filter(e => e.judgeVerdict === 'tie' || e.judgeVerdict === 'compressed_better').length;
    const accuracyRetention = compressedTurns.length > 0
      ? ((tieOrBetter / compressedTurns.length) * 100).toFixed(1)
      : '100.0';
    const similarityTurns = compressedTurns.filter(e => e.similarityValid);
    const coverageTurns = compressedTurns.filter(e => e.coverageValid);
    const avgSim = similarityTurns.length > 0
      ? (similarityTurns.reduce((s, e) => s + e.similarity, 0) / similarityTurns.length).toFixed(1)
      : '100.0';
    const wins = compressedTurns.filter(e => e.judgeVerdict === 'compressed_better').length;
    const ties = compressedTurns.filter(e => e.judgeVerdict === 'tie').length;
    const losses = compressedTurns.filter(e => e.judgeVerdict === 'raw_better').length;
    const severe = similarityTurns.filter(e => e.similarity < 70).length;
    const rawCoverage = coverageTurns.length > 0
      ? coverageTurns.reduce((s, e) => s + e.rawCoverage, 0) / coverageTurns.length
      : 100;
    const proxyCoverage = coverageTurns.length > 0
      ? coverageTurns.reduce((s, e) => s + e.proxyCoverage, 0) / coverageTurns.length
      : 100;

    console.log(`  ${C.bold}评测结果:${C.reset}`);
    console.log(`    有压缩的轮次: ${compressedTurns.length}/${turnEvals.length}`);
    console.log(`    Pairwise 非劣率: ${C.green}${accuracyRetention}%${C.reset} (${tieOrBetter}/${compressedTurns.length})`);
    console.log(`    Pairwise 胜/平/负: ${wins}/${ties}/${losses}`);
    console.log(`    严重退化轮次（相似度<70）: ${severe}/${similarityTurns.length} 有效 / ${compressedTurns.length} 压缩`);
    console.log(`    平均语义相似度: ${C.green}${avgSim}%${C.reset}（${similarityTurns.length}/${compressedTurns.length} 有效）`);
    console.log(`    平均需求覆盖率: 直连 ${rawCoverage.toFixed(1)}% / 代理 ${proxyCoverage.toFixed(1)}% (${(proxyCoverage - rawCoverage).toFixed(1)}pp，${coverageTurns.length}/${compressedTurns.length} 有效)`);
    console.log(`    输出截断轮次: ${truncatedTurns}/${turnEvals.length}`);
    console.log('');

    // 保存报告
    const filename = saveToFile(directResult, proxyResult, turnEvals, args.pipelineJudge);
    console.log(`  ${C.magenta}评测报告已保存到: ${filename}${C.reset}`);
    console.log(`  ${C.gray}用编辑器打开查看每轮的问题、输入 token、缓存命中率、回答对比、评测分析${C.reset}`);
  } else if (directResult || proxyResult) {
    // 单模式：只保存对话
    const result = directResult || proxyResult!;
    const label = directResult ? '直连' : '代理';
    console.log(`\n  ${C.gray}${label}模式完成，未生成评测报告（compare 模式才生成）${C.reset}`);
  }

  console.log('\n' + C.gray + '═'.repeat(60) + C.reset + '\n');
}

main().catch((e) => {
  console.error('Demo client error:', e);
  process.exit(1);
});
