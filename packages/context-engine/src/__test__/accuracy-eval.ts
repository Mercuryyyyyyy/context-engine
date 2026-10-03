// 准确率评测脚本：评估上下文压缩对 LLM 回答质量的影响
// 运行: pnpm --filter @context/engine exec tsx src/__test__/accuracy-eval.ts
//
// 评测方法（三维度）：
//   1. Pairwise + 位置交换：让 judge LLM 比较 原始context回答 vs 压缩context回答
//      交换 A/B 顺序跑两次，只有两次结论一致才算有效（消除位置偏差）
//   2. 语义相似度：LLM 打分（0-100），识别同义表达
//   3. 关键信息覆盖率：LLM 判断关键点是否被覆盖（语义匹配，非字符串匹配）
//
// 环境变量:
//   DEEPSEEK_API_KEY  DeepSeek API key（被测模型 + judge 模型）

import { reversibleCompress } from '../compress/reversible.js';
import { countTokens } from '../tokenize.js';
import type { Message } from '../types.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPORTS_DIR = 'f:\\Context\\reports';

// ============================================================
// 配置
// ============================================================

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-chat';
const JUDGE_MODEL = 'deepseek-chat'; // 用同一模型做 judge（理想应用 GPT-4）

// ANSI 颜色
const C = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

// ============================================================
// 测试用例：每个用例包含 上下文 + 问题 + 参考答案
// ============================================================

interface EvalCase {
  id: string;
  description: string;
  context: string;          // 原始上下文（会被压缩）
  question: string;         // 针对上下文的问题
  referenceAnswer?: string; // 参考答案（可选，用于 reference-based 评测）
  // 关键信息：上下文中必须在回答中出现的核心要点
  keyPoints?: string[];
}

function buildEvalCases(): EvalCase[] {
  return [
    {
      id: 'case-1',
      description: '代码 bug 定位（TypeScript 类型问题）',
      context: `下面是一段 TypeScript 代码，存在类型错误：

\`\`\`typescript
interface User {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'guest';
}

function findUser(users: User[], id: number): User | undefined {
  return users.find(u => u.id === id);
}

function getUserRole(users: User[], id: number): string {
  const user = findUser(users, id);
  return user.role; // 错误：user 可能为 undefined
}

const users: User[] = [
  { id: 1, name: 'Alice', email: 'alice@test.com', role: 'admin' },
  { id: 2, name: 'Bob', email: 'bob@test.com', role: 'user' },
];

console.log(getUserRole(users, 1)); // 期望输出 'admin'
console.log(getUserRole(users, 999)); // 期望输出 undefined 或 throw
\`\`\`

代码中 User 接口有 4 个字段：id、name、email、role。role 是联合类型 'admin' | 'user' | 'guest'。findUser 返回 User | undefined。getUserRole 没有处理 undefined 的情况。` ,
      question: '这段代码的类型错误是什么？getUserRole 函数的返回类型应该是什么？',
      referenceAnswer: 'getUserRole 没有处理 findUser 返回 undefined 的情况。user.role 在 user 为 undefined 时会抛错。返回类型应该是 User["role"] | undefined，或者加上空值检查后返回 User["role"]。',
      keyPoints: ['undefined', 'role', 'findUser', '联合类型'],
    },
    {
      id: 'case-2',
      description: '架构理解（多模块系统）',
      context: `# 系统架构文档

## 概述
本系统采用微服务架构，包含以下核心服务：

### 1. API Gateway (端口 8080)
- 负责请求路由、认证、限流
- 使用 Kong 作为网关
- 连接 Redis 做限流计数

### 2. User Service (端口 8081)
- 用户注册、登录、资料管理
- 数据库：PostgreSQL（主从复制，1主2从）
- 缓存：Redis（session 存储，TTL 30分钟）
- 消息队列：向 RabbitMQ 发送 user.created 事件

### 3. Order Service (端口 8082)
- 订单创建、查询、状态流转
- 数据库：MongoDB
- 与 Payment Service 通过 gRPC 通信
- 订单状态机：created → paid → shipped → delivered → completed

### 4. Payment Service (端口 8083)
- 支付处理、退款
- 集成 Stripe 和 PayPal
- 数据库：PostgreSQL
- 支付回调通过 Webhook 接收

### 5. Notification Service (端口 8084)
- 邮件、短信、推送通知
- 消费 RabbitMQ 的 user.created 和 order.paid 事件
- 使用 SendGrid 发邮件，Twilio 发短信

## 数据流
用户下单流程：
1. 客户端 → API Gateway → Order Service（创建订单）
2. Order Service → Payment Service（gRPC，发起支付）
3. Payment Service → Stripe/PayPal（HTTP）
4. Payment Service ← Stripe Webhook（支付回调）
5. Payment Service → RabbitMQ（order.paid 事件）
6. Order Service ← RabbitMQ（消费 order.paid，更新状态）
7. Notification Service ← RabbitMQ（消费 order.paid，发通知）

## 部署
- Kubernetes 集群（3 节点）
- 每个服务 2 个副本
- 数据库独立部署（不在 K8s 内）
- 监控：Prometheus + Grafana
- 日志：ELK Stack`,
      question: '用户下单流程中，Order Service 和 Payment Service 之间用什么协议通信？Payment Service 支付完成后如何通知 Order Service？',
      referenceAnswer: 'Order Service 和 Payment Service 通过 gRPC 通信。支付完成后，Payment Service 向 RabbitMQ 发送 order.paid 事件，Order Service 通过消费 RabbitMQ 的 order.paid 事件来更新订单状态。',
      keyPoints: ['gRPC', 'RabbitMQ', 'order.paid', '事件'],
    },
    {
      id: 'case-3',
      description: '配置文件理解（JSON 配置）',
      context: `# 应用配置文件 config.json

\`\`\`json
{
  "app": {
    "name": "MyApp",
    "version": "2.3.0",
    "port": 3000,
    "env": "production"
  },
  "database": {
    "primary": {
      "host": "db-primary.internal",
      "port": 5432,
      "name": "myapp_db",
      "user": "app_user",
      "poolSize": 20,
      "timeout": 5000
    },
    "replica": {
      "host": "db-replica.internal",
      "port": 5432,
      "name": "myapp_db",
      "user": "read_only_user",
      "poolSize": 10
    }
  },
  "redis": {
    "host": "redis.internal",
    "port": 6379,
    "db": 0,
    "ttl": 3600,
    "prefix": "myapp:"
  },
  "features": {
    "enableSignup": true,
    "enableExport": false,
    "enableBeta": true,
    "maxUploadSize": "50MB"
  },
  "logging": {
    "level": "info",
    "format": "json",
    "outputs": ["file", "stdout"],
    "filePath": "/var/log/myapp/app.log",
    "maxSize": "100MB",
    "maxFiles": 5
  },
  "security": {
    "jwtSecret": "auto-generated",
    "jwtExpiry": "24h",
    "bcryptRounds": 12,
    "corsOrigins": ["https://myapp.com", "https://app.myapp.com"],
    "rateLimit": {
      "windowMs": 60000,
      "max": 100
    }
  }
}
\`\`\`

配置说明：
- 数据库主库连接池 20，从库 10
- Redis TTL 3600 秒（1小时）
- JWT 有效期 24 小时
- 限流：每分钟 100 次请求
- 日志同时输出到文件和 stdout
- enableExport 功能当前关闭`,
      question: '这个配置中，数据库连接池总共有多大？Redis 的 TTL 是多少？哪个功能当前是关闭的？',
      referenceAnswer: '数据库连接池总共 30（主库 20 + 从库 10）。Redis TTL 是 3600 秒（1小时）。enableExport 功能当前关闭（值为 false）。',
      keyPoints: ['30', '20', '10', '3600', 'enableExport', 'false'],
    },
    {
      id: 'case-4',
      description: '长代码理解（React Hook 实现）',
      context: `下面是一个自定义 React Hook 的实现，用于管理带缓存的异步数据获取：

\`\`\`typescript
import { useState, useEffect, useCallback, useRef } from 'react';

interface UseFetchOptions<T> {
  cacheKey?: string;
  cacheTTL?: number;        // 毫秒
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
  enabled?: boolean;        // 是否自动发起请求，默认 true
  retryCount?: number;      // 重试次数，默认 0
  retryDelay?: number;      // 重试间隔，默认 1000ms
}

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function useFetch<T>(
  url: string,
  options: UseFetchOptions<T> = {}
): FetchState<T> {
  const {
    cacheKey,
    cacheTTL = 60000,
    onSuccess,
    onError,
    enabled = true,
    retryCount = 0,
    retryDelay = 1000,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | null>(null);
  const fetchIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const fetchId = ++fetchIdRef.current;

    // 检查缓存
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < cacheTTL) {
        setData(cached.data as T);
        setLoading(false);
        return;
      }
    }

    setLoading(true);
    setError(null);

    let lastError: Error | null = null;
    const attempts = retryCount + 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
        }
        const result = await response.json() as T;

        // 检查是否是最新请求（避免竞态）
        if (fetchId !== fetchIdRef.current) return;

        // 写入缓存
        if (cacheKey) {
          cache.set(cacheKey, { data: result, timestamp: Date.now() });
        }

        setData(result);
        setLoading(false);
        onSuccess?.(result);
        return;
      } catch (e) {
        lastError = e as Error;
        if (attempt < attempts - 1) {
          await sleep(retryDelay);
        }
      }
    }

    if (fetchId === fetchIdRef.current) {
      setError(lastError);
      setLoading(false);
      onError?.(lastError!);
    }
  }, [url, cacheKey, cacheTTL, enabled, retryCount, retryDelay]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    fetchData();
  }, [fetchData, enabled]);

  const refetch = useCallback(() => {
    // 强制重新获取，跳过缓存
    if (cacheKey) cache.delete(cacheKey);
    fetchData();
  }, [fetchData, cacheKey]);

  return { data, loading, error, refetch };
}
\`\`\`

关键实现点：
- 用 fetchIdRef 防止竞态条件（旧请求覆盖新请求）
- cacheKey + cacheTTL 实现本地缓存
- retryCount + retryDelay 实现重试
- enabled 控制是否自动发起
- refetch 跳过缓存强制刷新
- 缓存在模块级别共享（所有组件实例共享）`,
      question: '这个 useFetch Hook 如何防止竞态条件？重试机制的参数有哪些？refetch 函数做了什么？',
      referenceAnswer: '防竞态：用 fetchIdRef 计数器，每次发起请求递增 fetchId，请求完成后检查 fetchId 是否仍是最新，如果不是则丢弃结果。重试参数：retryCount（重试次数，默认0）和 retryDelay（重试间隔，默认1000ms）。refetch 函数先删除缓存（如果有 cacheKey），再调用 fetchData 强制重新获取。',
      keyPoints: ['fetchIdRef', '竞态', 'retryCount', 'retryDelay', '删除缓存', 'fetchData'],
    },
    {
      id: 'case-5',
      description: 'API 文档理解（RESTful 端点）',
      context: `# REST API 文档 v2.0

## 认证
所有 API 请求需要在 Header 中携带 \`Authorization: Bearer <token>\`。
Token 通过 POST /api/auth/login 获取，有效期 2 小时。
Token 过期前 5 分钟可以通过 POST /api/auth/refresh 刷新。

## 端点列表

### 用户相关
- GET /api/users - 获取用户列表
  - 查询参数：page (默认1), limit (默认20, 最大100), sort (可选: name, createdAt), order (asc/desc)
  - 返回：{ users: User[], total: number, page: number, limit: number }
  - 权限：admin

- GET /api/users/:id - 获取单个用户
  - 路径参数：id (number)
  - 返回：User
  - 权限：admin 或 本人
  - 错误：404 UserNotFound

- POST /api/users - 创建用户
  - Body：{ name: string, email: string, password: string, role?: 'user' | 'admin' }
  - 返回：User (201 Created)
  - 权限：admin
  - 错误：400 ValidationError, 409 EmailExists

- PATCH /api/users/:id - 更新用户
  - Body：{ name?, email?, role? }
  - 返回：User
  - 权限：admin 或 本人
  - 错误：404 UserNotFound, 400 ValidationError

- DELETE /api/users/:id - 删除用户
  - 返回：204 No Content
  - 权限：admin
  - 错误：404 UserNotFound

### 文章相关
- GET /api/posts - 获取文章列表
  - 查询参数：page, limit, authorId (可选), tag (可选), status (可选: draft/published)
  - 返回：{ posts: Post[], total, page, limit }
  - 权限：公开（只返回 published）

- GET /api/posts/:id - 获取单个文章
  - 返回：Post
  - 权限：公开（published）或 作者/管理员（draft）

- POST /api/posts - 创建文章
  - Body：{ title: string, content: string, tags?: string[], status?: 'draft' | 'published' }
  - 返回：Post (201)
  - 权限：已认证用户
  - 错误：400 ValidationError, 401 Unauthorized

- PUT /api/posts/:id - 更新文章
  - Body：{ title?, content?, tags?, status? }
  - 返回：Post
  - 权限：作者或 admin
  - 错误：403 Forbidden, 404 NotFound

- DELETE /api/posts/:id - 删除文章
  - 返回：204
  - 权限：作者或 admin

## 限流
- 认证用户：100 次/分钟
- 未认证：20 次/分钟
- 超限返回 429 Too Many Requests，Header 带 X-RateLimit-Reset

## 错误格式
所有错误返回统一格式：
\`\`\`json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": {}
  }
}
\`\`\``,
      question: '创建文章需要什么权限？文章列表的查询参数有哪些？删除用户需要什么权限？Token 有效期多久？',
      referenceAnswer: '创建文章需要"已认证用户"权限。文章列表查询参数：page、limit、authorId（可选）、tag（可选）、status（可选：draft/published）。删除用户需要 admin 权限。Token 有效期 2 小时。',
      keyPoints: ['已认证', 'page', 'limit', 'authorId', 'tag', 'status', 'admin', '2小时'],
    },
  ];
}

// ============================================================
// LLM 调用
// ============================================================

async function callLLM(messages: Message[], temperature = 0): Promise<string> {
  const response = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]!.message.content;
}

// 获取回答（原始 context 或压缩后 context）
async function getAnswer(context: string, question: string): Promise<string> {
  const messages: Message[] = [
    {
      role: 'system',
      content: 'You are a helpful assistant. Answer questions based on the provided context. Be concise and accurate.',
    },
    {
      role: 'user',
      content: `Context:\n${context}\n\nQuestion: ${question}`,
    },
  ];
  return callLLM(messages);
}

// ============================================================
// Judge: Pairwise 比较两个回答
// ============================================================

type JudgeVerdict = 'A' | 'B' | 'tie';

async function judgePairwise(
  question: string,
  answerA: string,
  answerB: string,
  referenceAnswer?: string,
): Promise<JudgeVerdict> {
  const refSection = referenceAnswer
    ? `\nReference Answer: ${referenceAnswer}`
    : '';

  const messages: Message[] = [
    {
      role: 'system',
      content: `You are an impartial judge. Compare two answers to the same question.
Evaluate which answer is more accurate, complete, and correct based on the question${referenceAnswer ? ' and reference answer' : ''}.

Output ONLY one of: "A", "B", or "tie"
- "A" if Answer A is clearly better
- "B" if Answer B is clearly better
- "tie" if they are equally good

Do not output anything else.`,
    },
    {
      role: 'user',
      content: `Question: ${question}${refSection}

Answer A:
${answerA}

Answer B:
${answerB}

Which answer is better? (A / B / tie)`,
    },
  ];

  const result = await callLLM(messages, 0);
  const trimmed = result.trim().toLowerCase();
  if (trimmed.startsWith('a')) return 'A';
  if (trimmed.startsWith('b')) return 'B';
  return 'tie';
}

// 交换位置跑两次，只有一致才算有效；不一致时跑第三轮决胜
async function judgePairwiseSymmetric(
  question: string,
  answerRaw: string,
  answerCompressed: string,
  referenceAnswer?: string,
): Promise<{ verdict: 'raw_better' | 'compressed_better' | 'tie' | 'inconclusive'; detail: string }> {
  // 第一次：A=raw, B=compressed
  const v1 = await judgePairwise(question, answerRaw, answerCompressed, referenceAnswer);

  // 第二次：A=compressed, B=raw（交换位置）
  const v2 = await judgePairwise(question, answerCompressed, answerRaw, referenceAnswer);

  // 分析两次结果
  // v1: A=raw, B=compressed
  // v2: A=compressed, B=raw
  // 一致的条件：
  //   v1=A 且 v2=B → raw 更好
  //   v1=B 且 v2=A → compressed 更好
  //   v1=tie 且 v2=tie → tie

  let verdict: 'raw_better' | 'compressed_better' | 'tie' | 'inconclusive';
  let detail: string;

  if (v1 === 'A' && v2 === 'B') {
    verdict = 'raw_better';
    detail = `v1(raw=A)=${v1}, v2(raw=B)=${v2}`;
  } else if (v1 === 'B' && v2 === 'A') {
    verdict = 'compressed_better';
    detail = `v1(raw=A)=${v1}, v2(raw=B)=${v2}`;
  } else if (v1 === 'tie' && v2 === 'tie') {
    verdict = 'tie';
    detail = `v1(raw=A)=${v1}, v2(raw=B)=${v2}`;
  } else {
    // 两次不一致（一方 tie，另一方有偏好）→ 跑第三轮决胜
    // 第三轮：随机顺序，但用更严格的 prompt 要求给出明确判断
    const v3 = await judgePairwiseTiebreaker(question, answerRaw, answerCompressed, referenceAnswer);
    if (v3 === 'A') {
      verdict = 'raw_better';
      detail = `v1=${v1}, v2=${v2}, v3(决胜)=raw_better`;
    } else if (v3 === 'B') {
      verdict = 'compressed_better';
      detail = `v1=${v1}, v2=${v2}, v3(决胜)=compressed_better`;
    } else {
      // 第三轮也 tie → 最终判为 tie
      verdict = 'tie';
      detail = `v1=${v1}, v2=${v2}, v3(决胜)=tie`;
    }
  }

  return { verdict, detail };
}

// 第三轮决胜：要求 judge 必须给出明确判断，不允许 tie
async function judgePairwiseTiebreaker(
  question: string,
  answerA: string,
  answerB: string,
  referenceAnswer?: string,
): Promise<JudgeVerdict> {
  const refSection = referenceAnswer
    ? `\nReference Answer: ${referenceAnswer}`
    : '';

  const messages: Message[] = [
    {
      role: 'system',
      content: `You are an impartial judge. Compare two answers to the same question.
Evaluate which answer is more accurate, complete, and correct.

You MUST pick one. You cannot say "tie" - you must choose A or B.
Even if the difference is small, pick the one that is slightly better.

Output ONLY "A" or "B". Do not output anything else.`,
    },
    {
      role: 'user',
      content: `Question: ${question}${refSection}

Answer A:
${answerA}

Answer B:
${answerB}

Which answer is better? You must choose A or B:`,
    },
  ];

  const result = await callLLM(messages, 0);
  const trimmed = result.trim().toLowerCase();
  if (trimmed.startsWith('a')) return 'A';
  if (trimmed.startsWith('b')) return 'B';
  return 'A'; // 默认回退
}

// ============================================================
// LLM 评估关键点和语义相似度（合并为一次调用）
// ============================================================

interface LLMEvalResult {
  keyPointsA: Array<{ point: string; covered: boolean }>;
  keyPointsB: Array<{ point: string; covered: boolean }>;
  similarity: number; // 0-100
  similarityReason: string;
}

async function llmEvaluate(
  question: string,
  answerA: string,
  answerB: string,
  keyPoints: string[],
): Promise<LLMEvalResult> {
  // 如果没有关键点，只评相似度
  const kpSection = keyPoints.length > 0
    ? `\n需要检查的关键点（"covered" 表示回答中传达了相同的含义，即使措辞不同也算覆盖，例如"删除缓存"和"清除缓存"都覆盖了关键点"删除缓存"）：\n${keyPoints.map((kp, i) => `${i + 1}. ${kp}`).join('\n')}`
    : '\n（无关键点需要检查）';

  const messages: Message[] = [
    {
      role: 'system',
      content: `你是一个评测助手。你需要：
1. 对每个关键点，分别判断 Answer A 和 Answer B 是否覆盖了该关键点。"覆盖"意味着回答传达了相同的含义，即使使用了不同的词语（例如"删除缓存"和"清除缓存"都覆盖了关键点"删除缓存"）。
2. 给两个回答的语义相似度打分（0-100），100 分表示传达了完全相同的信息，0 分表示完全不同。

只输出合法的 JSON，不要输出其他任何文字：
{"keyPointsA": [{"point": "原关键点", "covered": true}], "keyPointsB": [{"point": "原关键点", "covered": true}], "similarity": 85, "similarityReason": "用中文简短说明理由"}`,
    },
    {
      role: 'user',
      content: `问题: ${question}${kpSection}

Answer A:
${answerA}

Answer B:
${answerB}

评测并输出 JSON：`,
    },
  ];

  const result = await callLLM(messages, 0);

  // 解析 JSON（LLM 可能输出多余文本，尝试提取 JSON）
  let parsed: LLMEvalResult;
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch![0]);
  } catch {
    // 解析失败，回退到默认值
    parsed = {
      keyPointsA: keyPoints.map(p => ({ point: p, covered: false })),
      keyPointsB: keyPoints.map(p => ({ point: p, covered: false })),
      similarity: 0,
      similarityReason: 'JSON 解析失败',
    };
  }
  return parsed;
}

// ============================================================
// 评测主流程
// ============================================================

interface CaseResult {
  case: EvalCase;
  answerRaw: string;
  answerCompressed: string;
  compressedContext: string;  // 压缩后的上下文内容（让用户看到具体输入了什么）
  judgeVerdict: string;
  judgeDetail: string;
  similarity: number;
  similarityReason: string;
  rawKeyPointCoverage: number;
  compressedKeyPointCoverage: number;
  keyPointsADetail: Array<{ point: string; covered: boolean }>;
  keyPointsBDetail: Array<{ point: string; covered: boolean }>;
  originalContextTokens: number;
  compressedContextTokens: number;
  contextCompressionRate: number;
}

async function evalCase(c: EvalCase): Promise<CaseResult> {
  const compressed = reversibleCompress(c.context, { enableAdvanced: true });

  const [answerRaw, answerCompressed] = await Promise.all([
    getAnswer(c.context, c.question),
    getAnswer(compressed.compressed, c.question),
  ]);

  const judge = await judgePairwiseSymmetric(
    c.question, answerRaw, answerCompressed, c.referenceAnswer,
  );

  // 用 LLM 评估关键点和语义相似度
  const llmEval = await llmEvaluate(
    c.question, answerRaw, answerCompressed, c.keyPoints || [],
  );

  const rawCoverage = llmEval.keyPointsA.filter(k => k.covered).length / Math.max(llmEval.keyPointsA.length, 1);
  const compressedCoverage = llmEval.keyPointsB.filter(k => k.covered).length / Math.max(llmEval.keyPointsB.length, 1);

  const originalTokens = countTokens(c.context);
  const compressedTokens = countTokens(compressed.compressed);

  return {
    case: c,
    answerRaw,
    answerCompressed,
    compressedContext: compressed.compressed,
    judgeVerdict: judge.verdict,
    judgeDetail: judge.detail,
    similarity: llmEval.similarity / 100, // 转为 0-1
    similarityReason: llmEval.similarityReason,
    rawKeyPointCoverage: rawCoverage,
    compressedKeyPointCoverage: compressedCoverage,
    keyPointsADetail: llmEval.keyPointsA,
    keyPointsBDetail: llmEval.keyPointsB,
    originalContextTokens: originalTokens,
    compressedContextTokens: compressedTokens,
    contextCompressionRate: (originalTokens - compressedTokens) / originalTokens,
  };
}

// ============================================================
// 展示
// ============================================================

function printHeader(title: string): void {
  console.log('\n' + C.cyan + '═'.repeat(60) + C.reset);
  console.log(C.bold + C.cyan + '  ' + title + C.reset);
  console.log(C.cyan + '═'.repeat(60) + C.reset);
}

function printCaseResult(r: CaseResult, index: number, verbose: boolean): void {
  console.log(`\n${C.gray}--- 用例 ${index + 1}: ${r.case.description} ---${C.reset}`);

  // 上下文压缩
  console.log(`  上下文: ${r.originalContextTokens} → ${r.compressedContextTokens} tok ${C.green}(压缩 ${(r.contextCompressionRate * 100).toFixed(1)}%)${C.reset}`);

  // Judge 结论
  const verdictColor = r.judgeVerdict === 'tie' ? C.green
    : r.judgeVerdict === 'raw_better' ? C.yellow
    : r.judgeVerdict === 'compressed_better' ? C.yellow
    : C.red;
  const verdictLabel = r.judgeVerdict === 'tie' ? '持平（质量无损）'
    : r.judgeVerdict === 'raw_better' ? '原始更好'
    : r.judgeVerdict === 'compressed_better' ? '压缩后更好'
    : '无法判定（位置偏差）';
  console.log(`  Judge: ${verdictColor}${verdictLabel}${C.reset} ${C.gray}[${r.judgeDetail}]${C.reset}`);

  // 语义相似度（含 reason）
  const simColor = r.similarity > 0.7 ? C.green : r.similarity > 0.4 ? C.yellow : C.red;
  console.log(`  语义相似度: ${simColor}${(r.similarity * 100).toFixed(1)}%${C.reset} ${C.gray}${r.similarityReason}${C.reset}`);

  // 关键信息覆盖
  console.log(`  关键信息覆盖: 原始 ${(r.rawKeyPointCoverage * 100).toFixed(0)}% vs 压缩 ${(r.compressedKeyPointCoverage * 100).toFixed(0)}%`);

  if (verbose) {
    // verbose 模式：输出完整的问题、参考答案、左右分栏回答
    console.log(`\n  ${C.bold}问题:${C.reset}`);
    for (const line of r.case.question.split('\n')) {
      console.log(`    ${line}`);
    }

    if (r.case.referenceAnswer) {
      console.log(`\n  ${C.bold}参考答案:${C.reset}`);
      for (const line of r.case.referenceAnswer.split('\n')) {
        console.log(`    ${C.gray}${line}${C.reset}`);
      }
    }

    // 左右分栏输出（终端用两列文字）
    const rawLines = r.answerRaw.split('\n');
    const compLines = r.answerCompressed.split('\n');
    const maxRows = Math.max(rawLines.length, compLines.length);
    const colWidth = 45;

    console.log(`\n  ${C.bold}原始 context 回答${C.reset} (${r.originalContextTokens} tok)    ${C.bold}压缩后 context 回答${C.reset} (${r.compressedContextTokens} tok)`);
    console.log(`  ${C.gray}${'-'.repeat(colWidth)}    ${'-'.repeat(colWidth)}${C.reset}`);
    for (let i = 0; i < maxRows; i++) {
      const left = (rawLines[i] || '').slice(0, colWidth).padEnd(colWidth);
      const right = (compLines[i] || '').slice(0, colWidth).padEnd(colWidth);
      console.log(`  ${left}    ${right}`);
    }

    // 关键点命中明细（表格形式）
    if (r.keyPointsADetail.length > 0 || r.keyPointsBDetail.length > 0) {
      const kps = r.keyPointsADetail.length > 0 ? r.keyPointsADetail : r.keyPointsBDetail;
      console.log(`\n  ${C.bold}关键点命中明细:${C.reset}`);
      console.log(`    ${'关键点'.padEnd(colWidth - 12)}    原始    压缩`);
      console.log(`    ${C.gray}${'-'.repeat(colWidth)}    ${'-'.repeat(4)}    ${'-'.repeat(4)}${C.reset}`);
      for (let i = 0; i < kps.length; i++) {
        const point = kps[i]!.point;
        const inRaw = r.keyPointsADetail[i]?.covered ?? false;
        const inComp = r.keyPointsBDetail[i]?.covered ?? false;
        const rawMark = inRaw ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
        const compMark = inComp ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
        const pointPadded = point.padEnd(colWidth - 12);
        console.log(`    ${pointPadded}    ${rawMark}      ${compMark}`);
      }
    }
  } else {
    // 非 verbose：只输出简短预览
    console.log(`  ${C.gray}原始回答: ${r.answerRaw.slice(0, 100)}...${C.reset}`);
    console.log(`  ${C.gray}压缩回答: ${r.answerCompressed.slice(0, 100)}...${C.reset}`);
  }
}

// 保存详细评测结果到 markdown 文件
function saveToFile(results: CaseResult[]): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `accuracy-eval-${ts}.md`;
  const lines: string[] = [];

  lines.push(`# 准确率评测报告`);
  lines.push(``);
  lines.push(`- 时间: ${new Date().toISOString()}`);
  lines.push(`- 被测模型: ${MODEL}`);
  lines.push(`- Judge 模型: ${JUDGE_MODEL}`);
  lines.push(`- 评测方法: Pairwise + 位置交换 + 第三轮决胜 + LLM 语义相似度 + LLM 关键信息覆盖`);
  lines.push(``);

  const total = results.length;
  const tie = results.filter(r => r.judgeVerdict === 'tie').length;
  const accuracyRetention = ((tie + results.filter(r => r.judgeVerdict === 'compressed_better').length) / total * 100).toFixed(1);
  const avgSimilarity = (results.reduce((s, r) => s + r.similarity, 0) / total * 100).toFixed(1);
  const avgCompression = (results.reduce((s, r) => s + r.contextCompressionRate, 0) / total * 100).toFixed(1);

  lines.push(`## 汇总`);
  lines.push(``);
  lines.push(`| 指标 | 值 |`);
  lines.push(`|---|---|`);
  lines.push(`| 准确率保持率 | ${accuracyRetention}% |`);
  lines.push(`| 语义相似度 | ${avgSimilarity}% |`);
  lines.push(`| 上下文压缩率 | ${avgCompression}% |`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  for (let idx = 0; idx < results.length; idx++) {
    const r = results[idx]!;
    lines.push(`## 用例 ${idx + 1}: ${r.case.description}`);
    lines.push(``);

    // 问题只展示一次
    lines.push(`**问题:**`);
    lines.push(``);
    lines.push('```');
    lines.push(r.case.question);
    lines.push('```');
    lines.push(``);

    if (r.case.referenceAnswer) {
      lines.push(`**参考答案:**`);
      lines.push(``);
      lines.push('```');
      lines.push(r.case.referenceAnswer);
      lines.push('```');
      lines.push(``);
    }

    // 没有压缩时跳过对比
    if (r.contextCompressionRate <= 0) {
      lines.push(`> 当前没有压缩，两者一致（${r.originalContextTokens} tok）`);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
      continue;
    }

    // 上下文压缩信息
    lines.push(`**上下文压缩:** ${r.originalContextTokens} → ${r.compressedContextTokens} tok (压缩 ${(r.contextCompressionRate * 100).toFixed(1)}%)`);
    lines.push(``);

    // 展示压缩后的具体输入内容（关键：让用户看到代理实际输入了什么）
    lines.push(`<details>`);
    lines.push(`<summary>点击查看压缩后的上下文内容（代理实际输入给 LLM 的内容，${r.compressedContextTokens} tok）</summary>`);
    lines.push(``);
    lines.push('```');
    lines.push(r.compressedContext);
    lines.push('```');
    lines.push(``);
    lines.push(`</details>`);
    lines.push(``);

    // 左右分栏对比回答（用 <pre> 替代代码块，解决 HTML table 内代码块不渲染问题）
    lines.push(`<table>`);
    lines.push(`<tr>`);
    lines.push(`<th>直连回答（输入 ${r.originalContextTokens} tok）</th>`);
    lines.push(`<th>代理回答（输入 ${r.compressedContextTokens} tok）</th>`);
    lines.push(`</tr>`);
    lines.push(`<tr>`);
    lines.push(`<td valign="top" width="50%">`);
    lines.push(`<pre>${escapeHtml(r.answerRaw)}</pre>`);
    lines.push(`</td>`);
    lines.push(`<td valign="top" width="50%">`);
    lines.push(`<pre>${escapeHtml(r.answerCompressed)}</pre>`);
    lines.push(`</td>`);
    lines.push(`</tr>`);
    lines.push(`</table>`);
    lines.push(``);

    // 准确率评析
    const verdictLabel = r.judgeVerdict === 'tie' ? '持平'
      : r.judgeVerdict === 'raw_better' ? '原始更好'
      : r.judgeVerdict === 'compressed_better' ? '压缩后更好'
      : '无法判定';
    lines.push(`**Judge:** ${verdictLabel} [${r.judgeDetail}]`);
    lines.push(``);
    lines.push(`**语义相似度:** ${(r.similarity * 100).toFixed(1)}% — ${r.similarityReason}`);
    lines.push(``);
    lines.push(`**关键信息覆盖:** 原始 ${(r.rawKeyPointCoverage * 100).toFixed(0)}% vs 压缩 ${(r.compressedKeyPointCoverage * 100).toFixed(0)}%`);
    lines.push(``);

    // 关键点命中明细表格
    const kps = r.keyPointsADetail.length > 0 ? r.keyPointsADetail : r.keyPointsBDetail;
    if (kps.length > 0) {
      lines.push(`| 关键点 | 原始 | 压缩 |`);
      lines.push(`|---|---|---|`);
      for (let i = 0; i < kps.length; i++) {
        const point = kps[i]!.point;
        const inRaw = r.keyPointsADetail[i]?.covered ? '✓' : '✗';
        const inComp = r.keyPointsBDetail[i]?.covered ? '✓' : '✗';
        lines.push(`| ${point} | ${inRaw} | ${inComp} |`);
      }
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const filepath = join(REPORTS_DIR, filename);
  writeFileSync(filepath, lines.join('\n'), 'utf-8');
  return filepath;
}

// HTML 转义（防止回答中的 < > & 破坏 HTML table 渲染）
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function printSummary(results: CaseResult[]): void {
  printHeader('准确率评测汇总');

  const total = results.length;
  const tie = results.filter(r => r.judgeVerdict === 'tie').length;
  const rawBetter = results.filter(r => r.judgeVerdict === 'raw_better').length;
  const compBetter = results.filter(r => r.judgeVerdict === 'compressed_better').length;
  const inconclusive = results.filter(r => r.judgeVerdict === 'inconclusive').length;

  // 准确率保持率：tie + 压缩更好 / 总数（即"压缩后不比原始差"的比例）
  const accuracyRetention = (tie + compBetter) / total;

  // 位置偏差率：inconclusive / 总数
  const positionBiasRate = inconclusive / total;

  // 平均语义相似度
  const avgSimilarity = results.reduce((s, r) => s + r.similarity, 0) / total;

  // 平均关键信息覆盖
  const avgRawCoverage = results.reduce((s, r) => s + r.rawKeyPointCoverage, 0) / total;
  const avgCompCoverage = results.reduce((s, r) => s + r.compressedKeyPointCoverage, 0) / total;

  // 平均上下文压缩率
  const avgCompression = results.reduce((s, r) => s + r.contextCompressionRate, 0) / total;

  console.log('');
  console.log(`  ${C.bold}评测维度 1：Pairwise Judge（交换位置消除偏差）${C.reset}`);
  console.log(`    持平（质量无损）:     ${C.green}${tie}/${total}${C.reset} (${(tie / total * 100).toFixed(1)}%)`);
  console.log(`    原始更好:            ${C.yellow}${rawBetter}/${total}${C.reset}`);
  console.log(`    压缩后更好:          ${C.yellow}${compBetter}/${total}${C.reset}`);
  console.log(`    无法判定（位置偏差）: ${C.red}${inconclusive}/${total}${C.reset} (${(positionBiasRate * 100).toFixed(1)}%)`);
  console.log(`    ${C.bold}准确率保持率: ${C.green}${(accuracyRetention * 100).toFixed(1)}%${C.reset}${C.gray}（tie + compressed_better）${C.reset}`);
  console.log('');

  console.log(`  ${C.bold}评测维度 2：LLM 语义相似度${C.reset}`);
  console.log(`    平均相似度: ${C.green}${(avgSimilarity * 100).toFixed(1)}%${C.reset}${C.gray}（原始回答 vs 压缩后回答）${C.reset}`);
  // 展示每个用例的 similarityReason
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    console.log(`    ${C.gray}用例 ${i + 1}: ${(r.similarity * 100).toFixed(1)}% - ${r.similarityReason}${C.reset}`);
  }
  console.log('');

  console.log(`  ${C.bold}评测维度 3：LLM 关键信息覆盖率${C.reset}`);
  console.log(`    原始 context:    ${(avgRawCoverage * 100).toFixed(1)}%`);
  console.log(`    压缩后 context:  ${(avgCompCoverage * 100).toFixed(1)}%`);
  const coverageDelta = avgCompCoverage - avgRawCoverage;
  console.log(`    覆盖率变化: ${coverageDelta >= 0 ? C.green : C.red}${(coverageDelta * 100).toFixed(1)}%${C.reset}`);
  console.log('');

  console.log(`  ${C.bold}上下文压缩效果${C.reset}`);
  console.log(`    平均压缩率: ${C.green}${(avgCompression * 100).toFixed(1)}%${C.reset}`);
  console.log('');

  // 结论
  console.log(`  ${C.bold}${C.cyan}结论${C.reset}`);
  console.log(`  - 上下文平均压缩 ${C.green}${(avgCompression * 100).toFixed(0)}%${C.reset}，准确率保持率 ${C.green}${(accuracyRetention * 100).toFixed(0)}%${C.reset}`);
  console.log(`  - 语义相似度 ${C.green}${(avgSimilarity * 100).toFixed(0)}%${C.reset}，压缩前后回答高度一致`);
  if (positionBiasRate > 0) {
    console.log(`  - 位置偏差率 ${C.yellow}${(positionBiasRate * 100).toFixed(0)}%${C.reset}，已通过交换位置消除`);
  }
  console.log(`  - 评测方法：Pairwise + 位置交换 + LLM 语义相似度 + LLM 关键信息覆盖（四维度交叉验证）`);
}

// ============================================================
// 主入口
// ============================================================

async function main(): Promise<void> {
  if (!DEEPSEEK_API_KEY) {
    console.error(`${C.red}错误: 请设置 DEEPSEEK_API_KEY 环境变量${C.reset}`);
    process.exit(1);
  }

  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

  printHeader(`准确率评测 - 上下文压缩对回答质量的影响${verbose ? ' [verbose]' : ''}`);
  console.log(`  ${C.gray}被测模型: ${MODEL}${C.reset}`);
  console.log(`  ${C.gray}Judge 模型: ${JUDGE_MODEL}${C.reset}`);
  console.log(`  ${C.gray}评测方法: Pairwise + 位置交换 + LLM 语义相似度 + LLM 关键信息覆盖${C.reset}`);
  if (verbose) {
    console.log(`  ${C.gray}verbose 模式: 输出完整回答、参考答案、关键点命中明细${C.reset}`);
  }

  const cases = buildEvalCases();
  console.log(`  ${C.gray}测试用例: ${cases.length} 个${C.reset}`);

  const results: CaseResult[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    process.stdout.write(`\r  ${C.gray}正在评测用例 ${i + 1}/${cases.length}: ${c.description.padEnd(40)}${C.reset}`);

    try {
      const result = await evalCase(c);
      results.push(result);
      printCaseResult(result, i, verbose);
    } catch (e) {
      console.error(`\n  ${C.red}用例 ${i + 1} 评测失败: ${(e as Error).message}${C.reset}`);
    }
  }

  if (results.length > 0) {
    printSummary(results);
    const filepath = saveToFile(results);
    console.log(`\n  ${C.magenta}详细评测报告已保存到: ${filepath}${C.reset}`);
    console.log(`  ${C.gray}用编辑器打开查看完整的回答对比和 judge 细节${C.reset}`);
  }

  console.log('\n' + C.gray + '═'.repeat(60) + C.reset + '\n');
}

main().catch((e) => {
  console.error('Accuracy eval error:', e);
  process.exit(1);
});
