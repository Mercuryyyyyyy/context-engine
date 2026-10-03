// 模块跟踪器：检测主题切换，判定模块归档时机
// 借鉴 Hermes 保护头衰减 + MemGPT archival memory 思路：
// - 每个模块由一组主题相关的对话轮次组成
// - 当前 query 与活动模块主题相关度低于阈值时，开新模块
// - 旧模块连续 N 轮无引用则标记为可归档
// - 高水位兜底：即使无切换，超过 token 阈值也强制归档最老模块

export interface ModuleInfo {
  id: string;                     // 如 "module-1"
  topicKeywords: Set<string>;     // 累积的主题关键词集
  representativeQuery: string;    // 第一轮 query 作为代表（用于归档摘要）
  startTurn: number;              // 起始轮次（1-based）
  lastReferencedTurn: number;     // 最后引用轮次
  messageIndices: number[];       // 该模块包含的消息在 history 中的索引（0-based）
  status: 'active' | 'archived';
  summary?: string;               // 归档时写入的摘要
  archivedAtTurn?: number;        // 归档时的 turn
}

export interface ObserveResult {
  currentModuleId: string;        // 当前活动模块 id
  newModuleCreated: boolean;      // 本轮是否创建了新模块
  modulesToArchive: ModuleInfo[]; // 本轮应归档的模块（active → 待归档）
}

export interface ModuleTrackerOptions {
  // 主题相关度阈值：低于此值认为切换到新模块，默认 0.20
  topicSwitchThreshold?: number;
  // 归档延迟轮数：模块被切换后，连续 N 轮无引用则归档，默认 3
  archiveDelayRounds?: number;
  // 高水位兜底 token 数：超过则强制归档最老的活动模块，默认 10000
  highWatermarkTokens?: number;
}

const DEFAULT_OPTIONS: Required<ModuleTrackerOptions> = {
  topicSwitchThreshold: 0.20,
  archiveDelayRounds: 3,
  highWatermarkTokens: 10000,
};

// 关键词提取：英文单词 + 中文双字符滑窗 + 驼峰分割
function extractKeywords(text: string): Set<string> {
  const terms = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z_][a-z0-9_.-]{1,}|\d+/g)) {
    terms.add(match[0]);
  }
  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const value = match[0];
    if (value.length <= 2) {
      terms.add(value);
    } else {
      for (let i = 0; i < value.length - 1; i++) {
        terms.add(value.slice(i, i + 2));
      }
    }
  }
  // 驼峰分割
  const camelParts = text.match(/[a-z]+[A-Z][a-z]+/g) || [];
  for (const word of camelParts) {
    const parts = word.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
    for (const p of parts) {
      if (p.length >= 2) terms.add(p);
    }
  }
  return terms;
}

// 计算查询与模块主题的关键词覆盖率
// 使用查询覆盖率（overlap / queryTerms.size）而非双向 Jaccard：
// 模块主题关键词会累积变大，用查询侧归一化更稳定
function keywordOverlap(queryTerms: Set<string>, moduleTerms: Set<string>): number {
  if (queryTerms.size === 0 || moduleTerms.size === 0) return 0;
  let overlap = 0;
  for (const term of queryTerms) {
    if (moduleTerms.has(term)) overlap++;
  }
  return overlap / queryTerms.size;
}

export class ModuleTracker {
  private modules: Map<string, ModuleInfo> = new Map();
  private currentModuleId: string | null = null;
  private moduleCounter = 0;
  private options: Required<ModuleTrackerOptions>;

  constructor(options?: ModuleTrackerOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 每轮对话调用：记录新 query，更新模块状态，返回应归档的模块列表
   * @param turn 当前轮次（1-based）
   * @param query 本轮用户查询
   * @param messageIndices 本轮新增消息在 history 中的索引（user + assistant 各一条）
   * @param currentTokenCount 当前 history 总 token 数（用于高水位兜底）
   */
  observe(
    turn: number,
    query: string,
    messageIndices: number[],
    currentTokenCount?: number,
  ): ObserveResult {
    const queryTerms = extractKeywords(query);
    const modulesToArchive: ModuleInfo[] = [];

    // 决定当前 query 属于哪个模块
    let targetModule: ModuleInfo | null = null;
    if (this.currentModuleId) {
      const current = this.modules.get(this.currentModuleId);
      if (current && current.status === 'active') {
        const overlap = keywordOverlap(queryTerms, current.topicKeywords);
        if (overlap >= this.options.topicSwitchThreshold) {
          targetModule = current;
        }
      }
    }

    const newModuleCreated = targetModule === null;
    if (newModuleCreated) {
      // 创建新模块
      this.moduleCounter++;
      const id = `module-${this.moduleCounter}`;
      targetModule = {
        id,
        topicKeywords: new Set(queryTerms),
        representativeQuery: query,
        startTurn: turn,
        lastReferencedTurn: turn,
        messageIndices: [...messageIndices],
        status: 'active',
      };
      this.modules.set(id, targetModule);
      this.currentModuleId = id;
    } else {
      // 加入现有模块：累积关键词，更新引用轮次
      for (const term of queryTerms) targetModule!.topicKeywords.add(term);
      targetModule!.lastReferencedTurn = turn;
      targetModule!.messageIndices.push(...messageIndices);
    }

    // 检查所有活动模块（除当前模块外）是否应归档
    for (const module of this.modules.values()) {
      if (module.id === this.currentModuleId) continue;
      if (module.status !== 'active') continue;
      const roundsSinceLastRef = turn - module.lastReferencedTurn;
      if (roundsSinceLastRef >= this.options.archiveDelayRounds) {
        modulesToArchive.push(module);
      }
    }

    // 高水位兜底：token 超阈值时强制归档最老的活动模块（非当前）
    if (currentTokenCount !== undefined && currentTokenCount > this.options.highWatermarkTokens) {
      const activeOldModules = Array.from(this.modules.values())
        .filter((m) => m.status === 'active' && m.id !== this.currentModuleId)
        .sort((a, b) => a.startTurn - b.startTurn);
      if (activeOldModules.length > 0) {
        const oldest = activeOldModules[0]!;
        if (!modulesToArchive.some((m) => m.id === oldest.id)) {
          modulesToArchive.push(oldest);
        }
      }
    }

    return {
      currentModuleId: this.currentModuleId!,
      newModuleCreated,
      modulesToArchive,
    };
  }

  /**
   * 标记模块已归档（写入摘要后调用）
   */
  markArchived(moduleId: string, summary: string, archivedAtTurn: number): void {
    const module = this.modules.get(moduleId);
    if (!module) return;
    module.status = 'archived';
    module.summary = summary;
    module.archivedAtTurn = archivedAtTurn;
  }

  /**
   * 获取所有已归档模块（供 ArchiveStore 索引完整内容）
   */
  getArchivedModules(): ModuleInfo[] {
    return Array.from(this.modules.values()).filter((m) => m.status === 'archived');
  }

  /**
   * 获取所有活动模块
   */
  getActiveModules(): ModuleInfo[] {
    return Array.from(this.modules.values()).filter((m) => m.status === 'active');
  }

  /**
   * 获取当前活动模块
   */
  getCurrentModule(): ModuleInfo | null {
    if (!this.currentModuleId) return null;
    return this.modules.get(this.currentModuleId) ?? null;
  }

  /**
   * 根据 id 获取模块
   */
  getModule(id: string): ModuleInfo | null {
    return this.modules.get(id) ?? null;
  }

  /**
   * 获取所有模块总数
   */
  get size(): number {
    return this.modules.size;
  }

  /**
   * 获取已归档模块数
   */
  get archivedCount(): number {
    return this.getArchivedModules().length;
  }

  /**
   * 重置（用于测试）
   */
  clear(): void {
    this.modules.clear();
    this.currentModuleId = null;
    this.moduleCounter = 0;
  }
}
