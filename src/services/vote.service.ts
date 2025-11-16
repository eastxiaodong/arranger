// Vote 服务

import { DatabaseManager } from '../database';
import { TypedEventEmitter } from '../events/emitter';
import type { Topic, Vote, VoteChoice } from '../types';
import type { TaskService } from './task.service';
import type { GovernanceHistoryService } from './governance-history.service';

type AutoDecision = 'approve' | 'reject';

export class VoteService {
  constructor(
    private db: DatabaseManager,
    private events: TypedEventEmitter,
    private taskService?: TaskService,
    private historyService?: GovernanceHistoryService
  ) {}

  // 获取所有投票主题
  getAllTopics(filters?: { session_id?: string; status?: string; task_id?: string }): Topic[] {
    return this.db.getTopics(filters);
  }

  // 获取单个投票主题
  getTopic(id: string): Topic | null {
    return this.db.getTopic(id);
  }

  // 创建投票主题
  createTopic(topic: Omit<Topic, 'created_at'>): Topic {
    const created = this.db.createTopic(topic);
    this.blockTaskForVote(topic);
    this.logVoteHistory(
      topic.id,
      'topic_created',
      `发起投票：${topic.title || topic.id}`,
      {
        description: topic.description,
        vote_type: topic.vote_type,
        required_roles: topic.required_roles
      },
      topic.created_by || null,
      topic.session_id
    );
    this.events.emit('votes_update', this.db.getTopics({}));
    return created;
  }

  // 投票
  castVote(topicId: string, agentId: string, choice: VoteChoice, comment?: string): Vote {
    let inserted = false;
    let vote: Vote | null = null;

    try {
      vote = this.db.createVote({
        topic_id: topicId,
        agent_id: agentId,
        choice,
        comment: comment || null
      });
      inserted = true;
    } catch (error: any) {
      if (this.isDuplicateVoteError(error)) {
        vote = this.db.getVoteByTopicAndAgent(topicId, agentId);
      } else {
        throw error;
      }
    }

    if (!vote) {
      throw new Error('Failed to record vote');
    }

    if (!inserted) {
      return vote;
    }

    this.logVoteHistory(
      topicId,
      'vote_cast',
      `${agentId} 选择 ${choice}`,
      { choice, comment: comment || null },
      agentId
    );

    // 如果是用户投票，立即关闭投票（一票通过/否决）
    if (agentId === 'user') {
      const result = choice === 'approve' ? 'user_approve' : 'user_reject';
      this.closeTopic(topicId, result);
    } else {
      // Agent 投票，触发更新
      this.events.emit('votes_update', this.db.getTopics({}));
    }

    return vote;
  }

  // 获取投票主题的所有投票
  getVotesForTopic(topicId: string): Vote[] {
    return this.db.getVotesForTopic(topicId);
  }

  // 关闭投票
  closeTopic(id: string, result: string): void {
    this.db.updateTopic(id, {
      status: 'completed',
      result
    });
    const topic = this.db.getTopic(id);
    if (topic?.task_id) {
      this.resumeTaskAfterVote(topic.task_id, result);
    }
    this.logVoteHistory(
      id,
      'topic_closed',
      `投票结束，结果：${result}`,
      { result },
      undefined,
      topic?.session_id ?? null
    );
    this.events.emit('votes_update', this.db.getTopics({}));
  }

  // 计算投票结果
  calculateVoteResult(topicId: string): {
    userVoted: boolean;
    userChoice: VoteChoice | null;
    agentApprove: number;
    agentReject: number;
    agentAbstain: number;
    totalAgents: number;
    result: 'user_approve' | 'user_reject' | 'agent_approve' | 'agent_reject' | 'tie' | 'pending';
  } {
    const votes = this.db.getVotesForTopic(topicId);

    // 检查用户是否投票
    const userVote = votes.find(v => v.agent_id === 'user');
    if (userVote) {
      const agentVotes = votes.filter(v => v.agent_id !== 'user');
      return {
        userVoted: true,
        userChoice: userVote.choice,
        agentApprove: agentVotes.filter(v => v.choice === 'approve').length,
        agentReject: agentVotes.filter(v => v.choice === 'reject').length,
        agentAbstain: agentVotes.filter(v => v.choice === 'abstain').length,
        totalAgents: agentVotes.length,
        result: userVote.choice === 'approve' ? 'user_approve' : 'user_reject'
      };
    }

    // 统计 Agent 投票
    const agentVotes = votes.filter(v => v.agent_id !== 'user');
    const agentApprove = agentVotes.filter(v => v.choice === 'approve').length;
    const agentReject = agentVotes.filter(v => v.choice === 'reject').length;
    const agentAbstain = agentVotes.filter(v => v.choice === 'abstain').length;

    let result: 'agent_approve' | 'agent_reject' | 'tie' | 'pending' = 'pending';
    if (agentApprove > agentReject) {
      result = 'agent_approve';
    } else if (agentReject > agentApprove) {
      result = 'agent_reject';
    } else if (agentApprove === agentReject && agentApprove > 0) {
      result = 'tie';
    }

    return {
      userVoted: false,
      userChoice: null,
      agentApprove,
      agentReject,
      agentAbstain,
      totalAgents: agentVotes.length,
      result
    };
  }

  // 检查超时的投票
  checkTimeouts(): void {
    const now = Date.now();
    const topics = this.db.getTopics({ status: 'pending' });
    const timedOut = topics.filter(t => t.timeout_at < now);

    timedOut.forEach(topic => {
      const voteResult = this.calculateVoteResult(topic.id);

      if (voteResult.userVoted) {
        this.db.updateTopic(topic.id, {
          status: 'completed',
          result: voteResult.result
        });
        this.logVoteHistory(
          topic.id,
          'topic_closed',
          '投票结束（用户已决策）',
          { result: voteResult.result, reason: 'user_vote' }
        );
        return;
      }

      const autoDecision = this.decideAutoUserApproval(voteResult);
      if (autoDecision) {
        this.applyAutoUserDecision(topic, autoDecision);
      } else {
        this.db.updateTopic(topic.id, {
          status: 'timeout',
          result: voteResult.result
        });
        this.logVoteHistory(
          topic.id,
          'topic_timeout',
          '投票超时，等待人工处理',
          { result: voteResult.result }
        );
      }
    });

    if (timedOut.length > 0) {
      this.events.emit('votes_update', this.db.getTopics({}));
    }
  }

  private blockTaskForVote(topic: Omit<Topic, 'created_at'>) {
    if (!topic.task_id || !this.taskService) {
      return;
    }
    try {
      this.taskService.updateTaskStatus(topic.task_id, 'blocked');
    } catch (error) {
      console.warn('[VoteService] failed to block task for vote', error);
    }
  }

  private resumeTaskAfterVote(taskId: string, result: string) {
    if (!this.taskService) {
      return;
    }
    const task = this.taskService.getTask(taskId);
    if (!task) {
      return;
    }

    if (result === 'user_reject' || result === 'agent_reject') {
      this.taskService.failTask(taskId, '被投票否决');
      return;
    }

    if (result === 'user_approve' || result === 'agent_approve') {
      const nextStatus = task.assigned_to ? 'assigned' : 'pending';
      this.taskService.updateTaskStatus(taskId, nextStatus);
      return;
    }

    // tie 或其它情况保持阻塞，等待人工处理
    this.taskService.updateTaskStatus(taskId, 'blocked');
  }

  private decideAutoUserApproval(result: ReturnType<VoteService['calculateVoteResult']>): AutoDecision {
    if (result.agentApprove > result.agentReject) {
      return 'approve';
    }
    return 'reject';
  }

  private applyAutoUserDecision(topic: Topic, decision: AutoDecision) {
    this.db.createVote({
      topic_id: topic.id,
      agent_id: 'user',
      choice: decision === 'approve' ? 'approve' : 'reject',
      comment: '自动审批：投票超时按多数决执行'
    });
    this.logVoteHistory(
      topic.id,
      'vote_cast',
      `系统自动${decision === 'approve' ? '通过' : '否决'}`,
      { autoDecision: true, decision },
      'user',
      topic.session_id
    );
    const storedResult = decision === 'approve' ? 'user_approve' : 'user_reject';
    this.db.updateTopic(topic.id, {
      status: 'completed',
      result: storedResult
    });
    this.logVoteHistory(
      topic.id,
      'topic_closed',
      `投票自动${decision === 'approve' ? '通过' : '拒绝'}`,
      { result: storedResult, autoDecision: true }
    );
    if (topic.task_id) {
      this.resumeTaskAfterVote(topic.task_id, storedResult);
    }
  }

  private isDuplicateVoteError(error: any): boolean {
    const message = error?.message || '';
    return message.includes('UNIQUE constraint failed') || message.includes('already locked');
  }

  private logVoteHistory(
    entityId: string,
    action: string,
    summary: string | null,
    payload?: Record<string, any> | null,
    actorId?: string | null,
    sessionId?: string | null
  ) {
    if (!this.historyService) {
      return;
    }
    let resolvedSessionId = sessionId ?? null;
    if (!resolvedSessionId) {
      const topic = this.db.getTopic(entityId);
      resolvedSessionId = topic?.session_id ?? 'default';
    }
    this.historyService.recordEntry({
      session_id: resolvedSessionId,
      type: 'vote',
      entity_id: entityId,
      action,
      actor_id: actorId ?? null,
      summary,
      payload: payload ?? null
    });
  }
}
