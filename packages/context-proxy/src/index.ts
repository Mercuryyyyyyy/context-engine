#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { createServer, type ProxyConfig, type ArchiveConfig } from './server.js';
import type { SummarizerOptions } from '@context/engine';
import { createEmbedder } from '@context/engine';

interface Args {
  port: number;
  upstream: string;
  anthropicUpstream?: string;
  budget: number;
  noReversible: boolean;
  semanticFold: boolean;
  quiet: boolean;
  summarizeModel?: string;
  summarizeKeep: number;
  archive: boolean;
  archiveDelay: number;
  archiveTopicThreshold: number;
  embedApiKey?: string;
  embedModel?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: 8787,
    upstream: process.env.OPENAI_BASE_URL || 'https://api.openai.com',
    budget: 0,
    noReversible: false,
    semanticFold: false,
    quiet: false,
    summarizeKeep: 6,
    archive: false,
    archiveDelay: 2,
    archiveTopicThreshold: 0.20,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case '-p':
      case '--port':
        if (next) args.port = parseInt(next, 10);
        break;
      case '-u':
      case '--upstream':
        if (next) args.upstream = next;
        break;
      case '--anthropic-upstream':
        if (next) args.anthropicUpstream = next;
        break;
      case '-b':
      case '--budget':
        if (next) args.budget = parseInt(next, 10);
        break;
      case '--no-reversible':
        args.noReversible = true;
        break;
      case '--semantic-fold':
        args.semanticFold = true;
        break;
      case '-q':
      case '--quiet':
        args.quiet = true;
        break;
      case '--summarize':
        if (next) args.summarizeModel = next;
        break;
      case '--summarize-keep':
        if (next) args.summarizeKeep = parseInt(next, 10);
        break;
      case '--archive':
        args.archive = true;
        break;
      case '--archive-delay':
        if (next) args.archiveDelay = parseInt(next, 10);
        break;
      case '--archive-topic-threshold':
        if (next) args.archiveTopicThreshold = parseFloat(next);
        break;
      case '--embed-api-key':
        if (next) args.embedApiKey = next;
        break;
      case '--embed-model':
        if (next) args.embedModel = next;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
context-proxy - AI 上下文管理代理

用法:
  context-proxy [options]

选项:
  -p, --port <num>            监听端口 (默认: 8787)
  -u, --upstream <url>        OpenAI 上游 API 地址 (默认: https://api.openai.com)
      --anthropic-upstream <url>  Anthropic 上游 (如 https://api.anthropic.com)
  -b, --budget <num>          token 预算上限，0 表示不裁剪 (默认: 0)
      --no-reversible         关闭可逆压缩
      --semantic-fold         显式启用有损代码/JSON折叠（默认关闭）
      --summarize <model>     启用摘要压缩，指定小模型 (如 gpt-4o-mini)
      --summarize-keep <num>  保留最近 N 条原文 (默认: 6)
      --archive               启用 Hermes 归档系统（主题切换检测 + 模块化归档）
      --archive-delay <num>   归档滞后轮数 (默认: 2)
      --archive-topic-threshold <num>  主题切换相似度阈值 (默认: 0.20)
      --embed-api-key <key>   向量检索 API key（留空则仅用 BM25）
      --embed-model <model>   向量模型名 (默认: text-embedding-3-small)
  -q, --quiet                 静默模式，不输出 stats 日志
  -h, --help                  显示帮助

环境变量:
  OPENAI_BASE_URL             OpenAI 上游 (等同 -u)
  ANTHROPIC_BASE_URL          Anthropic 上游 (等同 --anthropic-upstream)
  OPENAI_API_KEY              摘要器用的 API key (也透传给上游)
  SUMMARIZER_API_KEY          摘要器专用 key (优先级高于 OPENAI_API_KEY)
  EMBED_API_KEY               向量检索 API key (等同 --embed-api-key)

示例:
  context-proxy -b 32000
  context-proxy -b 32000 --summarize gpt-4o-mini --archive
  context-proxy --anthropic-upstream https://api.anthropic.com -b 32000 --archive

然后在客户端配置:
  OpenAI:    OPENAI_BASE_URL=http://localhost:8787
  Anthropic: ANTHROPIC_BASE_URL=http://localhost:8787
`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // 构造摘要配置（仅当 --summarize 指定时）
  let summarizer: SummarizerOptions | undefined;
  if (args.summarizeModel) {
    const apiKey = process.env.SUMMARIZER_API_KEY || process.env.OPENAI_API_KEY || '';
    if (!apiKey) {
      console.error('错误: 启用摘要需要 OPENAI_API_KEY 或 SUMMARIZER_API_KEY');
      process.exit(1);
    }
    summarizer = {
      config: {
        model: args.summarizeModel,
        apiKey,
        baseURL: args.upstream,
        targetRatio: 0.2,
      },
      recentKeep: args.summarizeKeep,
    };
  }

  // 构造归档配置（仅当 --archive 指定时）
  let archive: ArchiveConfig | undefined;
  if (args.archive) {
    const embedApiKey = args.embedApiKey || process.env.EMBED_API_KEY || process.env.OPENAI_API_KEY || '';
    const embedModel = args.embedModel || 'text-embedding-3-small';
    // 有 key 才构造 embedder，否则 ArchiveStore 自动 fallback 到纯 BM25
    const embedFn = embedApiKey ? createEmbedder({ apiKey: embedApiKey, model: embedModel, baseURL: args.upstream }) : undefined;
    archive = {
      topicSwitchThreshold: args.archiveTopicThreshold,
      archiveDelayRounds: args.archiveDelay,
      embedFn,
    };
  }

  const config: ProxyConfig = {
    port: args.port,
    upstream: args.upstream,
    anthropicUpstream: args.anthropicUpstream || process.env.ANTHROPIC_BASE_URL,
    budget: args.budget,
    enableReversible: !args.noReversible,
    enableSemanticFold: args.semanticFold,
    log: !args.quiet,
    summarizer,
    archive,
  };

  const app = createServer(config);

  serve(
    { fetch: app.fetch, port: config.port },
    (info) => {
      const archiveStatus = config.archive
        ? `on (delay=${args.archiveDelay}, topic<${args.archiveTopicThreshold})`
        : 'off';
      console.log(`\n  ┌──────────────────────────────────────────────┐`);
      console.log(`  │  context-proxy v0.1.0                        │`);
      console.log(`  │  listening on http://localhost:${info.port}          │`);
      console.log(`  │  upstream: ${config.upstream.padEnd(33)}│`);
      console.log(`  │  anthropic: ${(config.anthropicUpstream || 'off').padEnd(33)}│`);
      console.log(`  │  budget: ${(config.budget > 0 ? config.budget + ' tokens' : 'off').padEnd(35)}│`);
      console.log(`  │  reversible: ${(config.enableReversible ? 'on' : 'off').padEnd(32)}│`);
      console.log(`  │  semantic fold: ${(config.enableSemanticFold ? 'on (lossy)' : 'off').padEnd(29)}│`);
      console.log(`  │  summarize: ${(config.summarizer ? args.summarizeModel! : 'off').padEnd(32)}│`);
      console.log(`  │  archive: ${archiveStatus.padEnd(35)}│`);
      console.log(`  └──────────────────────────────────────────────┘\n`);
      console.log(`  配置客户端: OPENAI_BASE_URL=http://localhost:${config.port}`);
      if (config.anthropicUpstream) {
        console.log(`              ANTHROPIC_BASE_URL=http://localhost:${config.port}\n`);
      } else {
        console.log('');
      }
    }
  );
}

main();
