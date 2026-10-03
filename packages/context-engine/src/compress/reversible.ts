// 文本压缩工具。
// 基础模式（losslessNormalize）是真正无损的空白归一化：仅 trimTrailingWhitespace + collapseBlankLines。
// advanced 模式（semanticFold）会丢失正文（折叠长行/重复行/JSON/代码块等），只能显式启用。
// 借鉴 Headroom / Manus Compaction 的思路：折叠冗余、归一空白、mask 重复
// P2 进阶：JSON折叠、代码块折叠、注释折叠、字典去重、URL折叠

export interface ReversibleResult {
  compressed: string;
  saved: number;       // 节省的字符数
  strategies: string[];// 命中的手法
}

// 规整行尾空白
function trimTrailingWhitespace(text: string): string {
  return text.replace(/[ \t]+$/gm, '');
}

// 连续 3+ 空行 → 2 空行
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

// 折叠超长单行（minified JS、长 JSON、stack trace）
function foldLongLines(text: string, threshold = 500): string {
  return text
    .split('\n')
    .map((line) => (line.length > threshold ? `<folded:${line.length} chars>` : line))
    .join('\n');
}

// 折叠连续重复行（如日志刷屏）
function collapseRepeatedLines(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let count = 1;
    while (i + count < lines.length && lines[i + count] === line) {
      count++;
    }
    if (count >= 4) {
      result.push(line);
      result.push(`  [repeated ${count - 1} more times]`);
    } else {
      for (let j = 0; j < count; j++) result.push(line);
    }
    i += count;
  }
  return result.join('\n');
}

// --- P2 进阶手法 ---

// 折叠 JSON/对象结构：检测 {...} 或 [...] 形式的长结构
function foldJsonStructures(text: string, threshold = 200): string {
  // 逐行处理，在每行内查找大括号配对
  return text.split('\n').map(line => {
    // 查找 = {...}; 或 = [...]; 形式
    const match = line.match(/=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*;?\s*$/);
    if (match && match[1]!.length > threshold) {
      const jsonStr = match[1]!;
      try {
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          const first = parsed[0];
          const keys = first && typeof first === 'object' ? Object.keys(first).slice(0, 3).join(',') : '';
          return line.replace(match[1]!, `<json-array:${parsed.length} items, keys:${keys}>`);
        } else if (typeof parsed === 'object' && parsed !== null) {
          const keys = Object.keys(parsed).slice(0, 3).join(',');
          return line.replace(match[1]!, `<json-object:${jsonStr.length} chars, keys:${keys}>`);
        }
      } catch {
        // 不是合法 JSON，用通用折叠
        return line.replace(match[1]!, `<folded:${jsonStr.length} chars>`);
      }
    }
    return line;
  }).join('\n');
}

// 折叠代码块：长函数体 → 保留签名
function foldCodeBlocks(text: string, threshold = 300): string {
  // 匹配 function/method 体内长代码块
  // 简化：匹配 { ... } 中内容超过 threshold 的
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 检测函数/方法定义行
    const funcMatch = line.match(/^(\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+\w+.*)\{/);
    if (funcMatch) {
      // 找到匹配的闭合大括号
      let braceCount = 1;
      let blockEnd = i + 1;
      let blockContent = '';

      while (blockEnd < lines.length && braceCount > 0) {
        const blockLine = lines[blockEnd]!;
        for (const ch of blockLine) {
          if (ch === '{') braceCount++;
          else if (ch === '}') braceCount--;
        }
        blockContent += blockLine + '\n';
        blockEnd++;
      }

      // 如果代码块足够长，折叠
      if (blockContent.length > threshold) {
        const signature = funcMatch[1]!.trim();
        result.push(`${signature} { <folded:${blockContent.length} chars> }`);
        i = blockEnd;
        continue;
      }
    }

    result.push(line);
    i++;
  }

  return result.join('\n');
}

// 折叠注释块：连续多行注释 → 单行摘要
function foldCommentBlocks(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 检测多行注释开始 /* ... */
    if (line.trim().startsWith('/*')) {
      const commentLines: string[] = [line];
      let end = i;

      // 如果不是单行注释 /* ... */
      if (!line.trim().endsWith('*/')) {
        end = i + 1;
        while (end < lines.length && !lines[end]!.includes('*/')) {
          commentLines.push(lines[end]!);
          end++;
        }
        if (end < lines.length) commentLines.push(lines[end]!);
      } else {
        end = i;
      }

      // 如果注释块够长（>3行或>150字符），折叠
      const commentText = commentLines.join('\n');
      if (commentLines.length >= 4 || commentText.length > 150) {
        // 提取注释首行内容作为摘要
        const firstContent = line.trim().replace(/^\/\*\s*/, '').slice(0, 60);
        result.push(`/* ${firstContent}... <folded:${commentText.length} chars> */`);
      } else {
        result.push(...commentLines);
      }

      i = end + 1;
      continue;
    }

    // 折叠连续单行注释 //
    if (line.trim().startsWith('//')) {
      const commentLines = [line];
      let end = i + 1;
      while (end < lines.length && lines[end]!.trim().startsWith('//')) {
        commentLines.push(lines[end]!);
        end++;
      }

      if (commentLines.length >= 4) {
        const firstContent = line.trim().replace(/^\/\/\s*/, '').slice(0, 60);
        result.push(`// ${firstContent}... <folded:${commentLines.length} lines>`);
      } else {
        result.push(...commentLines);
      }

      i = end;
      continue;
    }

    result.push(line);
    i++;
  }

  return result.join('\n');
}

// 字典去重：检测重复的长片段，用引用替代
function deduplicateChunks(text: string, threshold = 100): string {
  // 提取所有长度 >= threshold 的行块
  const lines = text.split('\n');
  const seen = new Map<string, number>(); // 内容哈希 → 第一次出现位置
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // 只处理足够长的行
    if (line.length >= threshold) {
      // 简单哈希：前 50 + 后 50 字符
      const hash = line.slice(0, 50) + '|' + line.slice(-50);

      if (seen.has(hash)) {
        const firstPos = seen.get(hash)!;
        result.push(`<dup:ref to line ${firstPos + 1}, ${line.length} chars>`);
        continue;
      } else {
        seen.set(hash, i);
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

// 折叠 URL 和长文件路径
function foldUrlsAndPaths(text: string): string {
  // 长 URL
  let result = text.replace(/(https?:\/\/[^\s<>"']{80,})/g, (url) => {
    const domain = url.match(/https?:\/\/([^/]+)/)?.[1] || '';
    return `<url:${domain}.../${url.length} chars>`;
  });

  // 长文件路径（Windows 或 Unix）
  result = result.replace(/([A-Za-z]:\\[^\s<>"']{80,}|\/(?:usr|home|var|opt|tmp|etc)\/[^\s<>"']{80,})/g, (path) => {
    const filename = path.match(/[^\\/]+$/)?.[0] || '';
    return `<path:.../${filename}, ${path.length} chars>`;
  });

  return result;
}

export interface ReversibleOptions {
  // 是否启用有损语义折叠，默认 false
  enableAdvanced?: boolean;
  // 代码块折叠阈值，默认 300
  codeBlockThreshold?: number;
  // JSON 折叠阈值，默认 200
  jsonThreshold?: number;
  // 字典去重阈值，默认 100
  dedupThreshold?: number;
}

export function reversibleCompress(text: string, options?: ReversibleOptions): ReversibleResult {
  const enableAdvanced = options?.enableAdvanced ?? false;
  const original = text;
  const strategies: string[] = [];
  let result = text;

  // P0 基础手法（真正无损：仅空白归一化，不改变语义内容）
  const step1 = trimTrailingWhitespace(result);
  if (step1 !== result) strategies.push('trim-trailing');
  result = step1;

  const step2 = collapseBlankLines(result);
  if (step2 !== result) strategies.push('collapse-blank');
  result = step2;

  // 以下手法均有损（折叠/去重会丢失正文），只在 advanced 模式执行
  if (enableAdvanced) {
    // URL/路径折叠在 foldLongLines 之前，避免 URL 被通用折叠吃掉
    const step2b = foldUrlsAndPaths(result);
    if (step2b !== result) strategies.push('fold-urls');
    result = step2b;

    const step3 = foldLongLines(result);
    if (step3 !== result) strategies.push('fold-long-lines');
    result = step3;

    const step4 = collapseRepeatedLines(result);
    if (step4 !== result) strategies.push('collapse-repeated');
    result = step4;

    // P2 进阶手法
    const step6 = foldCommentBlocks(result);
    if (step6 !== result) strategies.push('fold-comments');
    result = step6;

    const step7 = foldJsonStructures(result, options?.jsonThreshold);
    if (step7 !== result) strategies.push('fold-json');
    result = step7;

    const step8 = foldCodeBlocks(result, options?.codeBlockThreshold);
    if (step8 !== result) strategies.push('fold-code');
    result = step8;

    const step9 = deduplicateChunks(result, options?.dedupThreshold);
    if (step9 !== result) strategies.push('dedup');
    result = step9;
  }

  return {
    compressed: result,
    saved: original.length - result.length,
    strategies,
  };
}

// 语义更清晰的新 API；保留 reversibleCompress 兼容旧调用方。
export function losslessNormalize(text: string): ReversibleResult {
  return reversibleCompress(text, { enableAdvanced: false });
}

export function semanticFold(text: string, options?: Omit<ReversibleOptions, 'enableAdvanced'>): ReversibleResult {
  return reversibleCompress(text, { ...options, enableAdvanced: true });
}
