import type { AgentRole, Task } from '../types';
import type { AutoTaskTemplate } from './workflow-types';
import { normalizeScenarioId, getScenarioDisplayName } from './scenario-registry';

export interface GeneratedTaskSpec {
  title: string;
  intent?: string;
  description?: string;
  assignee_role?: AgentRole | null;
  priority?: Task['priority'];
  labels?: string[];
  metadata?: Record<string, any> | null;
}

export interface TaskGeneratorContext {
  workflowId: string;
  instanceId: string;
  phaseId: string;
  sessionId: string;
  scenario: string[];
  instanceMetadata?: Record<string, any> | null;
  template: AutoTaskTemplate;
}

type GeneratorFn = (ctx: TaskGeneratorContext) => GeneratedTaskSpec[];

const generatorRegistry = new Map<string, GeneratorFn>();

export function registerTaskGenerator(id: string, fn: GeneratorFn) {
  generatorRegistry.set(id, fn);
}

export function generateTasksFromTemplate(ctx: TaskGeneratorContext): GeneratedTaskSpec[] {
  const id = ctx.template.generator?.toLowerCase();
  if (!id) {
    return [];
  }
  const generator = generatorRegistry.get(id);
  if (!generator) {
    console.warn(`[workflow][generator] 未找到生成器 ${id}`);
    return [];
  }
  try {
    const result = generator(ctx) || [];
    return Array.isArray(result) ? result : [];
  } catch (error) {
    console.warn(`[workflow][generator] 生成器 ${id} 执行失败`, error);
    return [];
  }
}

const DEFAULT_AUTOMATION = {
  auto: true,
  runner: 'automation',
  source: 'workflow_generator',
  created_by: 'workflow',
  type: 'command' as const
};

function buildRequirementHeadline(ctx: TaskGeneratorContext): string {
  const raw = ctx.instanceMetadata?.requirementContent || ctx.template.metadata?.description || ctx.workflowId;
  const firstLine = String(raw).split(/\r?\n/).find(Boolean) || raw;
  const trimmed = firstLine.trim();
  if (trimmed.length <= 48) {
    return trimmed;
  }
  return `${trimmed.slice(0, 45)}…`;
}

function applyAutomationDefaults(title: string, overrides?: Record<string, any>) {
  if (!overrides) {
    return undefined;
  }
  return {
    ...DEFAULT_AUTOMATION,
    summary: overrides.summary ?? `${title} 自动执行完成`,
    message: overrides.message ?? `${title} 自动执行失败，请关注日志`,
    proof: overrides.proof,
    tool_name: overrides.tool_name ?? 'workflow_tool_runner',
    ...overrides
  };
}

function normalizeScenarioList(ctx: TaskGeneratorContext): string[] {
  const fromCtx = Array.isArray(ctx.scenario) ? ctx.scenario : [];
  if (fromCtx.length > 0) {
    return fromCtx.map(item => normalizeScenarioId(item));
  }
  const fallback = ctx.instanceMetadata?.scenario;
  const list = Array.isArray(fallback) ? fallback : fallback ? [fallback] : [];
  return list.map(value => normalizeScenarioId(String(value)));
}

function defaultBusinessMetadata(ctx: TaskGeneratorContext, extra?: Record<string, any>): Record<string, any> {
  const scenario = normalizeScenarioList(ctx);
  const summary = buildRequirementHeadline(ctx);
  return {
    scenario,
    scenario_label: scenario.map(getScenarioDisplayName),
    business_summary: summary,
    ...extra
  };
}

function featureBreakdown(ctx: TaskGeneratorContext): GeneratedTaskSpec[] {
  const summary = buildRequirementHeadline(ctx);
  const scenario = normalizeScenarioList(ctx);
  const stageMeta = defaultBusinessMetadata(ctx, { business_area: 'feature' });
  const pipeline = [
    {
      suffix: '需求澄清与验收',
      role: 'coordinator' as AgentRole,
      intent: 'clarify_requirement',
      metadata: { ...stageMeta, checklist: ['验收标准', '上下文', '风控'] }
    },
    {
      suffix: '界面与交互',
      role: 'developer' as AgentRole,
      intent: 'implement_ui',
      metadata: { ...stageMeta, business_area: 'frontend' }
    },
    {
      suffix: '接口与业务逻辑',
      role: 'developer' as AgentRole,
      intent: 'implement_requirement',
      metadata: { ...stageMeta, business_area: 'backend' }
    },
    {
      suffix: '自动化测试',
      role: 'tester' as AgentRole,
      intent: 'run_tests',
      priority: 'high' as Task['priority'],
      metadata: {
        ...stageMeta,
        business_area: 'qa',
        automation: applyAutomationDefaults(`${summary} · 自动化测试`, {
          command: 'echo "[AutoTest] running scenario tests"',
          summary: '自动测试完成，已生成日志',
          attachments: {
            files: ['reports/tests.log']
          },
          proof: {
            description: '自动化测试日志',
            proof_type: 'work'
          }
        })
      }
    },
    {
      suffix: '文档与交付说明',
      role: 'documenter' as AgentRole,
      intent: 'compile_release_note',
      metadata: { ...stageMeta, business_area: 'doc' }
    }
  ];
  return pipeline.map(item => ({
    title: `${summary} · ${item.suffix}`,
    intent: item.intent,
    assignee_role: item.role,
    priority: item.priority,
    metadata: item.metadata,
    labels: ['workflow:business_task', ...scenario.map(tag => `scenario:${tag}`)]
  }));
}

function bugfixLane(ctx: TaskGeneratorContext): GeneratedTaskSpec[] {
  const summary = buildRequirementHeadline(ctx);
  const scenario = normalizeScenarioList(ctx);
  const result: GeneratedTaskSpec[] = [];
  const stages = [
    {
      title: '复现并记录痕迹',
      intent: 'collect_bug_repro',
      role: 'tester' as AgentRole,
      businessArea: 'bug_repro',
      metadata: { repro_required: true }
    },
    {
      title: '根因定位与风险评估',
      intent: 'analyze_root_cause',
      role: 'developer' as AgentRole,
      businessArea: 'analysis',
      metadata: { investigation: true }
    },
    {
      title: '补丁实现与联调',
      intent: 'fix_bug',
      role: 'developer' as AgentRole,
      businessArea: 'bug_fix',
      metadata: { delivery_type: 'fix' }
    },
    {
      title: '自动化回归',
      intent: 'run_regression',
      role: 'tester' as AgentRole,
      businessArea: 'qa',
      priority: 'high' as Task['priority'],
      metadata: {
        automation: applyAutomationDefaults(`${summary} · 自动化回归`, {
          command: 'echo "[Regression] executing smoke suite"',
          attachments: { files: ['reports/regression.log'] },
          proof: { description: '回归日志', proof_type: 'work' }
        })
      }
    },
    {
      title: '发布与监控',
      intent: 'release_fix',
      role: 'coordinator' as AgentRole,
      businessArea: 'release',
      metadata: {}
    }
  ];
  stages.forEach(stage => {
    result.push({
      title: `${summary} · ${stage.title}`,
      intent: stage.intent,
      assignee_role: stage.role,
      priority: stage.priority,
      metadata: defaultBusinessMetadata(ctx, {
        business_area: stage.businessArea || 'bug_fix',
        ...(stage.metadata || {})
      }),
      labels: ['workflow:business_task', ...scenario.map(tag => `scenario:${tag}`)]
    });
  });
  return result;
}

function docDelivery(ctx: TaskGeneratorContext): GeneratedTaskSpec[] {
  const stage = ctx.template.generator_options?.stage ?? 'draft';
  const summary = buildRequirementHeadline(ctx);
  const scenario = normalizeScenarioList(ctx);
  const specs: Record<string, GeneratedTaskSpec[]> = {
    research: [
      {
        title: `${summary} · 资料收集`,
        intent: 'collect_doc_context',
        assignee_role: 'coordinator' as AgentRole,
        metadata: defaultBusinessMetadata(ctx, { business_area: 'doc_research' })
      }
    ],
    draft: [
      {
        title: `${summary} · 草稿撰写`,
        intent: 'write_doc_draft',
        assignee_role: 'documenter' as AgentRole,
        metadata: defaultBusinessMetadata(ctx, { business_area: 'doc_draft' })
      },
      {
        title: `${summary} · 多角色评审`,
        intent: 'review_doc',
        assignee_role: 'reviewer' as AgentRole,
        metadata: defaultBusinessMetadata(ctx, { business_area: 'doc_review' })
      }
    ],
    publish: [
      {
        title: `${summary} · 发布归档`,
        intent: 'publish_doc',
        assignee_role: 'admin' as AgentRole,
        metadata: defaultBusinessMetadata(ctx, { business_area: 'doc_release' })
      }
    ]
  } as Record<string, GeneratedTaskSpec[]>;
  const selected = specs[stage] || [...(specs.draft ?? [])];
  return selected.map(item => ({
    ...item,
    labels: ['workflow:business_task', ...scenario.map(tag => `scenario:${tag}`)]
  }));
}

function opsHotfix(ctx: TaskGeneratorContext): GeneratedTaskSpec[] {
  const summary = buildRequirementHeadline(ctx);
  const scenario = normalizeScenarioList(ctx);
  const steps = [
    {
      title: '告警确认与通告',
      role: 'sentinel' as AgentRole,
      intent: 'collect_alarm_details'
    },
    {
      title: '止血与绕过',
      role: 'developer' as AgentRole,
      intent: 'mitigate_incident'
    },
    {
      title: '补丁修复',
      role: 'developer' as AgentRole,
      intent: 'fix_bug'
    },
    {
      title: '验证与监控',
      role: 'tester' as AgentRole,
      intent: 'run_tests',
      metadata: {
        automation: applyAutomationDefaults(`${summary} · Hotfix 验证`, {
          command: 'echo "[Hotfix] smoke validation"',
          attachments: { files: ['reports/hotfix-validate.log'] }
        })
      }
    },
    {
      title: '复盘与总结',
      role: 'coordinator' as AgentRole,
      intent: 'postmortem'
    }
  ];
  return steps.map(step => ({
    title: `${summary} · ${step.title}`,
    intent: step.intent,
    assignee_role: step.role,
    metadata: defaultBusinessMetadata(ctx, {
      business_area: 'ops',
      ...step.metadata
    }),
    labels: ['workflow:business_task', ...scenario.map(tag => `scenario:${tag}`)]
  }));
}

function testRequest(ctx: TaskGeneratorContext): GeneratedTaskSpec[] {
  const summary = buildRequirementHeadline(ctx);
  const scenario = normalizeScenarioList(ctx);
  return [
      {
        title: `${summary} · 测试计划`,
        intent: 'define_test_scope',
        assignee_role: 'tester' as AgentRole,
        metadata: defaultBusinessMetadata(ctx, { business_area: 'qa_plan' })
      },
    {
      title: `${summary} · 执行用例`,
      intent: 'run_tests',
      assignee_role: 'tester' as AgentRole,
      priority: 'high' as Task['priority'],
      metadata: defaultBusinessMetadata(ctx, {
        business_area: 'qa_execute',
        automation: applyAutomationDefaults(`${summary} · 自动化执行`, {
          command: 'echo "[QA] run suite"',
          attachments: { files: ['reports/test-suite.log'] }
        })
      })
    },
    {
      title: `${summary} · 输出报告`,
      intent: 'publish_test_report',
        assignee_role: 'tester' as AgentRole,
      metadata: defaultBusinessMetadata(ctx, { business_area: 'qa_report' })
    }
  ].map(item => ({
    ...item,
    labels: ['workflow:business_task', ...scenario.map(tag => `scenario:${tag}`)]
  }));
}

registerTaskGenerator('feature_breakdown', featureBreakdown);
registerTaskGenerator('bugfix_lane', bugfixLane);
registerTaskGenerator('doc_delivery', docDelivery);
registerTaskGenerator('ops_hotfix', opsHotfix);
registerTaskGenerator('test_request', testRequest);
