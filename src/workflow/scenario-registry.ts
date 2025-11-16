import type { MessageType } from '../types';

export interface ScenarioDefinition {
  id: string;
  label: string;
  keywords: Array<string | RegExp>;
  negativeKeywords?: Array<string | RegExp>;
  defaultMessageType: MessageType;
  priority: number;
  tags: string[];
}

export interface ScenarioMatch {
  scenarioId: string;
  messageType: MessageType;
  confidence: number;
  tags: string[];
}

export const SCENARIO_DEFINITIONS: ScenarioDefinition[] = [
  {
    id: 'bug_fix',
    label: '缺陷修复',
    keywords: ['bug', '缺陷', '报错', 'error', 'exception', '异常', '失败', '崩溃', '修复', '无法', '坏了'],
    defaultMessageType: 'warning',
    priority: 90,
    tags: ['scenario:bug_fix']
  },
  {
    id: 'test_request',
    label: '测试 / 验证',
    keywords: ['测试', 'test', '脚本', '验证', '跑一下', '回归', '自动化', '用例', 'CI', '执行一下'],
    defaultMessageType: 'question',
    priority: 70,
    tags: ['scenario:test_request']
  },
  {
    id: 'optimization',
    label: '性能 / 优化',
    keywords: ['优化', 'performance', '稳定', '稳定性', '效率', '慢', '延迟', '瓶颈', 'SLO', 'SLA', '加速'],
    defaultMessageType: 'suggestion',
    priority: 65,
    tags: ['scenario:optimization']
  },
  {
    id: 'refactor',
    label: '重构 / 架构演进',
    keywords: ['重构', 'refactor', '架构', '改造', '重写', '抽象', '拆分'],
    defaultMessageType: 'decision',
    priority: 80,
    tags: ['scenario:refactor']
  },
  {
    id: 'doc_work',
    label: '文档交付',
    keywords: ['文档', '说明', '手册', '指南', 'readme', '教程', '记录一下', '写个总结', 'release note', '报告'],
    defaultMessageType: 'requirement',
    priority: 60,
    tags: ['scenario:doc_work']
  },
  {
    id: 'ops_hotfix',
    label: '运维 / Hotfix',
    keywords: ['告警', '报警', '线上', '生产', 'incident', '故障', '中断', '恢复', 'hotfix', '紧急', '抢修', '宕机'],
    defaultMessageType: 'warning',
    priority: 95,
    tags: ['scenario:ops_hotfix']
  },
  {
    id: 'discussion',
    label: '自由讨论 / 咨询',
    keywords: ['讨论', '聊聊', '想法', '点子', '咨询', '可行吗', '怎么看', '建议一下', '随便说说'],
    defaultMessageType: 'discussion',
    priority: 50,
    tags: ['scenario:discussion']
  },
  {
    id: 'new_feature',
    label: '新功能 / 新需求',
    keywords: ['新功能', '新增', '实现', 'feature', '需求', '开发', '迭代', '模块', '页面', '接口'],
    defaultMessageType: 'requirement',
    priority: 85,
    tags: ['scenario:new_feature']
  }
];

export function classifyScenarioFromText(content: string): ScenarioMatch | null {
  const normalized = (content || '').toLowerCase();
  if (!normalized.trim()) {
    return null;
  }
  let best: ScenarioMatch | null = null;
  SCENARIO_DEFINITIONS.forEach(def => {
    const score = countKeywordMatches(normalized, def.keywords);
    if (score <= 0) {
      return;
    }
    if (def.negativeKeywords && def.negativeKeywords.length > 0) {
      const hasNegative = def.negativeKeywords.some(pattern => matchesKeyword(normalized, pattern));
      if (hasNegative) {
        return;
      }
    }
    const confidence = score + def.priority;
    if (!best || confidence > best.confidence) {
      best = {
        scenarioId: def.id,
        messageType: def.defaultMessageType,
        confidence,
        tags: def.tags
      };
    }
  });
  return best;
}

export function normalizeScenarioId(raw: string): string {
  const value = (raw || '').toLowerCase();
  switch (value) {
    case 'feature':
    case 'new_feature':
    case 'incremental':
      return 'new_feature';
    case 'bug':
    case 'bug_fix':
    case 'bugfix':
      return 'bug_fix';
    case 'test':
    case 'test_request':
    case 'qa':
      return 'test_request';
    case 'doc':
    case 'doc_work':
    case 'documentation':
      return 'doc_work';
    case 'ops':
    case 'ops_hotfix':
    case 'hotfix':
    case 'incident':
      return 'ops_hotfix';
    case 'refactor':
      return 'refactor';
    case 'optimization':
    case 'perf':
      return 'optimization';
    case 'discussion':
    case 'consult':
      return 'discussion';
    default:
      return value || 'new_feature';
  }
}

export function mergeScenarioValues(
  existing: string | string[] | null | undefined,
  additions: string | string[]
): string[] {
  const base = Array.isArray(existing)
    ? existing.map(normalizeScenarioId)
    : existing
      ? [normalizeScenarioId(existing)]
      : [];
  const extra = Array.isArray(additions)
    ? additions.map(normalizeScenarioId)
    : [normalizeScenarioId(additions)];
  const set = new Set<string>();
  base.forEach(value => value && set.add(value));
  extra.forEach(value => value && set.add(value));
  return Array.from(set);
}

export function getScenarioDisplayName(scenarioId: string): string {
  const normalized = normalizeScenarioId(scenarioId);
  const found = SCENARIO_DEFINITIONS.find(def => def.id === normalized);
  return found?.label ?? normalized;
}

function countKeywordMatches(content: string, patterns: Array<string | RegExp>): number {
  if (!patterns || patterns.length === 0) {
    return 0;
  }
  return patterns.reduce((score, pattern) => (matchesKeyword(content, pattern) ? score + 1 : score), 0);
}

function matchesKeyword(content: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) {
    const flags = pattern.flags.includes('i') ? pattern.flags : pattern.flags + 'i';
    const matcher = new RegExp(pattern.source, flags);
    return matcher.test(content);
  }
  return content.includes(String(pattern).toLowerCase());
}
