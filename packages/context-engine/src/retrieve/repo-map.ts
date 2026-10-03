// tree-sitter repo map：解析代码库，提取符号定义和引用，用 PageRank 排序生成树状索引
// 借鉴 Aider repo map 思路：def+ref 构建文件级有向图 → PageRank → 按重要性排序

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language, Query } from 'web-tree-sitter';
import { countTokens } from '../tokenize.js';
import { computePageRank, buildGraphFromSymbols } from './pagerank.js';

const require = createRequire(import.meta.url);

// 语言配置
interface LangConfig {
  name: string;
  extensions: string[];
  wasmFile: string;
  queryStr: string;
}

const LANGS: LangConfig[] = [
  {
    name: 'typescript',
    extensions: ['.ts'],
    wasmFile: 'tree-sitter-typescript.wasm',
    queryStr: `
      (class_declaration name: (type_identifier) @name) @definition.class
      (interface_declaration name: (type_identifier) @name) @definition.interface
      (function_declaration name: (identifier) @name) @definition.function
      (method_definition name: (property_identifier) @name) @definition.method
      (type_alias_declaration name: (type_identifier) @name) @definition.type
      (enum_declaration name: (identifier) @name) @definition.enum
      (call_expression function: (identifier) @name) @reference.call
      (call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
      (new_expression constructor: (identifier) @name) @reference.class
      (type_annotation (type_identifier) @name) @reference.type
    `,
  },
  {
    name: 'tsx',
    extensions: ['.tsx'],
    wasmFile: 'tree-sitter-tsx.wasm',
    queryStr: `
      (class_declaration name: (type_identifier) @name) @definition.class
      (interface_declaration name: (type_identifier) @name) @definition.interface
      (function_declaration name: (identifier) @name) @definition.function
      (method_definition name: (property_identifier) @name) @definition.method
      (type_alias_declaration name: (type_identifier) @name) @definition.type
      (call_expression function: (identifier) @name) @reference.call
      (call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
      (new_expression constructor: (identifier) @name) @reference.class
      (type_annotation (type_identifier) @name) @reference.type
    `,
  },
  {
    name: 'javascript',
    extensions: ['.js', '.mjs', '.cjs'],
    wasmFile: 'tree-sitter-javascript.wasm',
    queryStr: `
      (class_declaration name: (identifier) @name) @definition.class
      (function_declaration name: (identifier) @name) @definition.function
      (method_definition name: (property_identifier) @name) @definition.method
      (call_expression function: (identifier) @name) @reference.call
      (call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
      (new_expression constructor: (identifier) @name) @reference.class
    `,
  },
];

// 符号定义
interface SymbolDef {
  name: string;
  kind: string;
  line: number;
}

// 文件的解析结果（含定义和引用）
interface FileSymbols {
  path: string;
  symbols: SymbolDef[];     // 定义
  references: string[];     // 引用的符号名列表
}

// 忽略的目录
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.cache', '.turbo', '.vscode', '.idea',
]);

let parserInstance: Parser | null = null;
const langCache = new Map<string, Language>();
const queryCache = new Map<string, Query>();

async function ensureInit(): Promise<void> {
  if (!parserInstance) {
    await Parser.init();
    parserInstance = new Parser();
  }
}

async function getLanguage(ext: string): Promise<{ lang: Language; query: Query; config: LangConfig } | null> {
  const config = LANGS.find((l) => l.extensions.includes(ext));
  if (!config) return null;

  let lang = langCache.get(config.name);
  if (!lang) {
    await ensureInit();
    const pkgPath = await resolveGrammarPath(config.name);
    const wasmPath = join(pkgPath, config.wasmFile);
    lang = await Language.load(wasmPath);
    langCache.set(config.name, lang);
  }

  let query = queryCache.get(config.name);
  if (!query) {
    query = new Query(lang, config.queryStr);
    queryCache.set(config.name, query);
  }

  return { lang, query, config };
}

async function resolveGrammarPath(langName: string): Promise<string> {
  const pkgName = `tree-sitter-${langName}`;
  try {
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
    return dirname(pkgJsonPath);
  } catch {
    throw new Error(`Cannot find grammar package: ${pkgName}. Make sure it's installed.`);
  }
}

// 解析单个文件，提取定义和引用
async function parseFile(
  filePath: string,
  rootDir: string
): Promise<FileSymbols | null> {
  const ext = extname(filePath);
  const langResult = await getLanguage(ext);
  if (!langResult) return null;

  const { lang, query } = langResult;
  await ensureInit();
  parserInstance!.setLanguage(lang);

  let source: string;
  try {
    source = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  const tree = parserInstance!.parse(source);
  if (!tree) return null;

  // 用 matches API：每个 match 内的 captures 是成对的
  const matches = query.matches(tree.rootNode);
  const symbols: SymbolDef[] = [];
  const references: string[] = [];

  for (const match of matches) {
    let defKind: string | null = null;
    let isReference = false;
    let name: string | null = null;

    for (const cap of match.captures) {
      if (cap.name === 'name') {
        name = cap.node.text;
      } else if (cap.name.startsWith('definition.')) {
        defKind = cap.name.replace('definition.', '');
      } else if (cap.name.startsWith('reference.')) {
        isReference = true;
      }
    }

    if (defKind && name) {
      symbols.push({
        name,
        kind: defKind,
        line: match.captures.find((c) => c.name.startsWith('definition.'))!.node.startPosition.row,
      });
    } else if (isReference && name) {
      references.push(name);
    }
  }

  tree.delete();

  return {
    path: relative(rootDir, filePath).replace(/\\/g, '/'),
    symbols,
    references,
  };
}

async function walkDir(dir: string, files: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        await walkDir(fullPath, files);
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (LANGS.some((l) => l.extensions.includes(ext))) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export interface RepoMapOptions {
  maxTokens?: number;
  extensions?: string[];
  // 用户当前关注的文件（PageRank 个性化向量加权）
  focusFiles?: string[];
  // 是否禁用 PageRank，退回字母序排序
  disablePageRank?: boolean;
}

export interface RepoMapResult {
  text: string;
  fileCount: number;
  symbolCount: number;
  truncated: boolean;
  // PageRank 相关信息
  ranking?: Array<{ path: string; rank: number }>;
}

// 主入口：生成 repo map
export async function buildRepoMap(
  rootDir: string,
  options?: RepoMapOptions
): Promise<RepoMapResult> {
  const maxTokens = options?.maxTokens ?? 2048;

  // 1. 遍历收集文件
  const files = await walkDir(rootDir);

  // 2. 解析每个文件
  const fileSymbols: FileSymbols[] = [];
  for (const file of files) {
    const result = await parseFile(file, rootDir);
    if (result && result.symbols.length > 0) {
      fileSymbols.push(result);
    }
  }

  // 3. 计算排序
  let ordering: number[];
  let ranking: Array<{ path: string; rank: number }> | undefined;

  if (options?.disablePageRank || fileSymbols.length <= 1) {
    // 字母序
    ordering = fileSymbols
      .map((_, i) => i)
      .sort((a, b) => fileSymbols[a]!.path.localeCompare(fileSymbols[b]!.path));
  } else {
    // PageRank 排序
    // 构建 defMap: 符号名 → 定义所在文件列表
    const defMap = new Map<string, string[]>();
    for (const file of fileSymbols) {
      for (const sym of file.symbols) {
        const existing = defMap.get(sym.name);
        if (existing) {
          if (!existing.includes(file.path)) existing.push(file.path);
        } else {
          defMap.set(sym.name, [file.path]);
        }
      }
    }

    // 构建 fileRefs: 文件 → 引用符号名列表
    const fileRefs = new Map<string, string[]>();
    for (const file of fileSymbols) {
      if (file.references.length > 0) {
        fileRefs.set(file.path, file.references);
      }
    }

    // 构建图
    const edges = buildGraphFromSymbols(defMap, fileRefs);
    const allNodes = new Set(fileSymbols.map((f) => f.path));

    // 个性化向量
    let personalization: Map<string, number> | undefined;
    if (options?.focusFiles && options.focusFiles.length > 0) {
      personalization = new Map();
      for (const file of fileSymbols) {
        const isFocus = options.focusFiles.some((f) => file.path.endsWith(f) || file.path === f);
        // focusFiles 表示当前任务的显式工作集，应显著高于普通图中心性。
        personalization.set(file.path, isFocus ? 100 : 1);
      }
    }

    const prResult = computePageRank(edges, allNodes, { personalization });

    // 按 rank 降序排序
    const rankList = fileSymbols.map((f, i) => ({
      index: i,
      path: f.path,
      rank: prResult.ranks.get(f.path) || 0,
    }));
    rankList.sort((a, b) => b.rank - a.rank);
    ordering = rankList.map((r) => r.index);
    ranking = rankList.map((r) => ({ path: r.path, rank: r.rank }));
  }

  // 4. 生成树状文本
  const lines: string[] = [];
  let symbolCount = 0;
  let currentTokens = 0;
  let truncated = false;

  const canAppend = (line: string): boolean => {
    const candidate = [...lines, line].join('\n');
    return countTokens(candidate) <= maxTokens;
  };

  for (const idx of ordering) {
    const file = fileSymbols[idx]!;
    const fileHeader = file.path;
    if (!canAppend(fileHeader)) {
      truncated = true;
      break;
    }

    lines.push(fileHeader);
    currentTokens = countTokens(lines.join('\n'));

    // 符号按行号排序
    const sortedSyms = [...file.symbols].sort((a, b) => a.line - b.line);
    for (const sym of sortedSyms) {
      const symLine = `  ${sym.kind.padEnd(10)} L${String(sym.line + 1).padStart(4)}  ${sym.name}`;
      if (!canAppend(symLine)) {
        truncated = true;
        break;
      }

      lines.push(symLine);
      currentTokens = countTokens(lines.join('\n'));
      symbolCount++;
    }

    if (truncated) break;
    if (canAppend('')) lines.push('');
  }

  return {
    text: lines.join('\n'),
    fileCount: fileSymbols.length,
    symbolCount,
    truncated,
    ranking,
  };
}
