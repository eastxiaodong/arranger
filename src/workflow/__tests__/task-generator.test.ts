import { describe, it, expect } from 'vitest';
import { generateTasksFromTemplate } from '../task-generator';
import type { AutoTaskTemplate } from '../workflow-types';

const baseContext = {
  workflowId: 'universal_flow_v1',
  instanceId: 'instance-1',
  phaseId: 'build',
  sessionId: 'session-1',
  scenario: ['new_feature'],
  instanceMetadata: {
    requirementContent: '实现登录页面，支持手机号 + 二维码登录'
  }
};

describe('task-generator', () => {
  it('creates feature breakdown tasks', () => {
    const template: AutoTaskTemplate = {
      generator: 'feature_breakdown',
      intent: 'implement_requirement',
      labels: ['workflow:auto']
    };
    const tasks = generateTasksFromTemplate({ ...baseContext, template });
    expect(tasks.length).toBeGreaterThanOrEqual(4);
    const titles = tasks.map(task => task.title);
    expect(titles.some(title => title?.includes('界面'))).toBe(true);
    expect(tasks.every(task => task.metadata && task.metadata.scenario)).toBe(true);
  });

  it('creates bugfix lane tasks with automation metadata', () => {
    const template: AutoTaskTemplate = {
      generator: 'bugfix_lane',
      labels: ['workflow:auto']
    };
    const tasks = generateTasksFromTemplate({
      ...baseContext,
      scenario: ['bug_fix'],
      instanceMetadata: { requirementContent: '500 错误，支付失败' },
      template
    });
    expect(tasks.length).toBeGreaterThanOrEqual(4);
    const regressionTask = tasks.find(task => task.metadata?.business_area === 'qa');
    expect(regressionTask?.metadata?.automation).toBeTruthy();
    expect(regressionTask?.metadata?.automation?.command).toContain('echo');
  });
});
