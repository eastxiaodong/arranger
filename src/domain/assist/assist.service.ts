import type {
  AssistPriority,
  AssistRequest,
  AssistRequestFilter,
  AssistState,
  NotificationLevel
} from '../../core/types';
import type { StateStore } from '../state';
import type { MessageService } from '../communication/message.service';
import type { NotificationService } from '../communication/notification.service';
import type { TaskService } from '../task/task.service';

interface CreateAssistRequestInput {
  id?: string;
  taskId: string;
  sessionId: string;
  requesterId: string;
  description: string;
  priority?: AssistPriority;
  targetAgentId?: string | null;
  requiredCapabilities?: string[];
  responseDeadline?: number | null;
  context?: Record<string, any>;
  assignedTo?: string | null;
  tags?: string[];
}

interface AssistLifecycleOptions {
  actorId?: string;
  notes?: string;
  contextPatch?: Record<string, any>;
  responseDeadline?: number | null;
}

interface CompleteAssistOptions extends AssistLifecycleOptions {
  resolution?: string;
  artifacts?: Record<string, any>;
}

interface CancelAssistOptions extends AssistLifecycleOptions {
  reason?: string;
}

interface AssistHistoryEntry {
  type: string;
  actor: string;
  description?: string;
  details?: Record<string, any>;
  timestamp?: number;
}

export class AssistService {
  constructor(
    private readonly state: StateStore,
    private readonly messageService: MessageService,
    private readonly taskService: TaskService,
    private readonly notificationService?: NotificationService
  ) {}

  requestAssist(input: CreateAssistRequestInput): AssistRequest {
    this.assertRequired(input.taskId, 'taskId');
    this.assertRequired(input.sessionId, 'sessionId');
    this.assertRequired(input.requesterId, 'requesterId');

    const id = input.id?.trim() || this.generateAssistId();
    const initialState: AssistState = input.assignedTo ? 'assigned' : 'requested';
    const timestamp = Date.now();
    const managerCoordinationNeeded = input.targetAgentId && input.requesterId !== 'manager_llm';
    const context = this.buildContext(input.context, {
      type: 'requested',
      actor: input.requesterId,
      description: input.description,
      details: {
        priority: input.priority ?? 'normal',
        requiredCapabilities: input.requiredCapabilities ?? [],
        manager_required: managerCoordinationNeeded
      },
      timestamp
    });

    const record = this.state.createAssistRequest({
      id,
      taskId: input.taskId,
      sessionId: input.sessionId,
      requesterId: input.requesterId,
      targetAgentId: input.targetAgentId ?? null,
      requiredCapabilities: [...(input.requiredCapabilities ?? [])],
      priority: input.priority ?? 'normal',
      state: initialState,
      description: input.description,
      context,
      assignedTo: input.assignedTo ?? null,
      responseDeadline: input.responseDeadline ?? null
    });

    this.postAssistUpdate(record, {
      type: 'assist_requested',
      title: '新的协助请求',
      body: input.description,
      actor: input.requesterId,
      mentions: input.targetAgentId ? [input.targetAgentId] : undefined,
      level: 'info',
      metadata: {
        requested_by: input.requesterId,
        required_capabilities: input.requiredCapabilities ?? [],
        tags: input.tags ?? [],
        manager_required: managerCoordinationNeeded
      }
    });

    if (managerCoordinationNeeded) {
      this.postAssistUpdate(record, {
        type: 'assist_pending_manager',
        title: '协助待经理协调',
        body: `协助请求点名 ${input.targetAgentId}，等待经理确认/分配`,
        actor: 'system',
        mentions: ['manager_llm'],
        level: 'warning',
        metadata: {
          requested_by: input.requesterId,
          target_agent: input.targetAgentId
        }
      });
    }

    return record;
  }

  assignAssist(requestId: string, agentId: string, options?: AssistLifecycleOptions): AssistRequest {
    const request = this.requireOpenRequest(requestId, 'assign');
    const nextState: AssistState = request.state === 'in-progress' ? 'in-progress' : 'assigned';
    const context = this.buildContext(
      request.context,
      {
        type: 'assigned',
        actor: options?.actorId ?? agentId,
        description: options?.notes || `指派给 ${agentId}`,
        details: { assignedTo: agentId }
      },
      options?.contextPatch
    );

    const updated = this.state.updateAssistRequest(requestId, {
      assignedTo: agentId,
      state: nextState,
      responseDeadline: options?.responseDeadline ?? request.responseDeadline,
      context
    });

    if (!updated) {
      throw new Error(`协助 ${requestId} 指派失败`);
    }

    this.postAssistUpdate(updated, {
      type: 'assist_assigned',
      title: '协助已指派',
      body: options?.notes || `协助请求已分配给 ${agentId}`,
      actor: options?.actorId ?? agentId,
      mentions: [agentId],
      level: 'info',
      metadata: {
        assigned_to: agentId
      }
    });
    return updated;
  }

  startAssist(requestId: string, agentId: string, options?: AssistLifecycleOptions): AssistRequest {
    const request = this.requireOpenRequest(requestId, 'start');
    const context = this.buildContext(
      request.context,
      {
        type: 'in_progress',
        actor: options?.actorId ?? agentId,
        description: options?.notes || '已开始协助',
        details: { activeAgent: agentId }
      },
      options?.contextPatch
    );

    const updated = this.state.updateAssistRequest(requestId, {
      assignedTo: request.assignedTo || agentId,
      state: 'in-progress',
      responseDeadline: options?.responseDeadline ?? request.responseDeadline,
      context
    });

    if (!updated) {
      throw new Error(`协助 ${requestId} 启动失败`);
    }

    this.postAssistUpdate(updated, {
      type: 'assist_started',
      title: '协助进行中',
      body: options?.notes || `由 ${agentId} 执行`,
      actor: options?.actorId ?? agentId,
      mentions: [agentId],
      level: 'info'
    });
    return updated;
  }

  completeAssist(requestId: string, options?: CompleteAssistOptions): AssistRequest {
    const request = this.requireOpenRequest(requestId, 'complete');
    const contextPatch: Record<string, any> = {};
    if (options?.resolution !== undefined) {
      contextPatch.resolution = options.resolution;
    }
    if (options?.artifacts !== undefined) {
      contextPatch.artifacts = options.artifacts;
    }
    const context = this.buildContext(
      request.context,
      {
        type: 'completed',
        actor: options?.actorId || request.assignedTo || request.requesterId,
        description: options?.notes || options?.resolution || '协助已完成',
        details: {
          resolution: options?.resolution,
          artifacts: options?.artifacts
        }
      },
      { ...contextPatch, ...(options?.contextPatch ?? {}) }
    );

    const updated = this.state.updateAssistRequest(requestId, {
      state: 'completed',
      context
    });

    if (!updated) {
      throw new Error(`协助 ${requestId} 完成失败`);
    }

    this.appendTaskAssistHistory(updated.taskId, {
      event: 'assist_completed',
      assistId: updated.id,
      note: options?.resolution || options?.notes || '协助完成'
    });

    this.postAssistUpdate(updated, {
      type: 'assist_completed',
      title: '协助已完成',
      body: options?.resolution || options?.notes || '已反馈结果',
      actor: options?.actorId ?? updated.assignedTo ?? updated.requesterId,
      mentions: updated.assignedTo ? [updated.assignedTo] : undefined,
      level: 'success',
      metadata: {
        resolution: options?.resolution
      }
    });
    return updated;
  }

  cancelAssist(requestId: string, options?: CancelAssistOptions): AssistRequest {
    const request = this.requireOpenRequest(requestId, 'cancel');
    const context = this.buildContext(
      request.context,
      {
        type: 'cancelled',
        actor: options?.actorId ?? request.requesterId,
        description: options?.reason || '协助已取消'
      },
      { ...(options?.contextPatch ?? {}), cancelReason: options?.reason }
    );

    const updated = this.state.updateAssistRequest(requestId, {
      state: 'cancelled',
      context
    });

    if (!updated) {
      throw new Error(`协助 ${requestId} 取消失败`);
    }

    this.appendTaskAssistHistory(updated.taskId, {
      event: 'assist_cancelled',
      assistId: updated.id,
      note: options?.reason || '协助已取消'
    });

    this.postAssistUpdate(updated, {
      type: 'assist_cancelled',
      title: '协助已取消',
      body: options?.reason || '不再需要协助',
      actor: options?.actorId ?? updated.requesterId,
      level: 'warning',
      metadata: {
        reason: options?.reason ?? null
      }
    });
    return updated;
  }

  timeoutAssist(requestId: string, options?: AssistLifecycleOptions): AssistRequest {
    const request = this.requireOpenRequest(requestId, 'timeout');
    const context = this.buildContext(
      request.context,
      {
        type: 'timeout',
        actor: options?.actorId ?? 'system',
        description: options?.notes || '协助已超时'
      },
      options?.contextPatch
    );
    const updated = this.state.updateAssistRequest(requestId, {
      state: 'timeout',
      context
    });
    if (!updated) {
      throw new Error(`协助 ${requestId} 标记超时失败`);
    }
    this.appendTaskAssistHistory(updated.taskId, {
      event: 'assist_timeout',
      assistId: updated.id,
      note: options?.notes || '协助超时'
    });
    this.postAssistUpdate(updated, {
      type: 'assist_timeout',
      title: '协助超时',
      body: options?.notes || '请重新分配或关闭此协助请求',
      actor: options?.actorId ?? 'system',
      level: 'error'
    });
    return updated;
  }

  updateAssistRequest(
    requestId: string,
    updates: {
      description?: string;
      priority?: AssistPriority;
      requiredCapabilities?: string[];
      targetAgentId?: string | null;
      responseDeadline?: number | null;
      contextPatch?: Record<string, any>;
      historyEntry?: AssistHistoryEntry;
    }
  ): AssistRequest {
    const request = this.requireAssist(requestId);
    const context = this.buildContext(
      request.context,
      updates.historyEntry,
      updates.contextPatch
    );

    const updated = this.state.updateAssistRequest(requestId, {
      description: updates.description ?? request.description,
      priority: updates.priority ?? request.priority,
      requiredCapabilities: updates.requiredCapabilities ?? request.requiredCapabilities,
      targetAgentId: updates.targetAgentId ?? request.targetAgentId,
      responseDeadline: updates.responseDeadline ?? request.responseDeadline,
      context
    });

    if (!updated) {
      throw new Error(`协助 ${requestId} 更新失败`);
    }

    this.postAssistUpdate(updated, {
      type: 'assist_updated',
      title: '协助信息已更新',
      body: updates.description,
      actor: updates.historyEntry?.actor ?? request.requesterId,
      level: 'info'
    });
    return updated;
  }

  deleteAssistRequest(requestId: string): boolean {
    return this.state.deleteAssistRequest(requestId);
  }

  getAssistRequest(id: string): AssistRequest | null {
    return this.state.getAssistRequest(id);
  }

  getAssistRequests(filter?: AssistRequestFilter): AssistRequest[] {
    return this.state.queryAssistRequests(filter ?? {});
  }

  private requireAssist(requestId: string): AssistRequest {
    const request = this.state.getAssistRequest(requestId);
    if (!request) {
      throw new Error(`协助 ${requestId} 不存在`);
    }
    return request;
  }

  private requireOpenRequest(requestId: string, action: string): AssistRequest {
    const request = this.requireAssist(requestId);
    if (request.state === 'completed' || request.state === 'cancelled' || request.state === 'timeout') {
      throw new Error(`协助 ${requestId} 已结束，无法执行 ${action}`);
    }
    return request;
  }

  private buildContext(
    base: Record<string, any> | undefined,
    historyEntry?: AssistHistoryEntry,
    patch?: Record<string, any>
  ): Record<string, any> {
    const context = base ? { ...base } : {};
    if (patch) {
      Object.entries(patch).forEach(([key, value]) => {
        if (value === undefined) {
          return;
        }
        context[key] = value;
      });
    }
    if (historyEntry) {
      const history = Array.isArray(context.history) ? [...context.history] : [];
      history.push({
        ...historyEntry,
        timestamp: historyEntry.timestamp ?? Date.now()
      });
      context.history = history.slice(-50);
    }
    return context;
  }

  private postAssistUpdate(
    request: AssistRequest,
    event: {
      type: string;
      title: string;
      body?: string;
      actor?: string;
      level?: NotificationLevel;
      mentions?: string[];
      metadata?: Record<string, any>;
    }
  ): void {
    this.messageService.sendMessage({
      id: `msg_assist_${request.id}_${Date.now()}`,
      session_id: request.sessionId,
      agent_id: 'workflow_orchestrator',
      content: event.body ? `${event.title}\n${event.body}` : event.title,
      priority: request.priority === 'critical' ? 'high' : 'medium',
      tags: ['assist', `assist:${request.id}`],
      reply_to: null,
      references: null,
      reference_type: 'task',
      reference_id: request.taskId,
      mentions: event.mentions ?? (request.assignedTo ? [request.assignedTo] : null),
      expires_at: null,
      payload: {
        kind: 'assist_event',
        event: event.type,
        assist_id: request.id,
        task_id: request.taskId,
        state: request.state,
        actor: event.actor ?? null,
        priority: request.priority,
        metadata: event.metadata ?? null
      }
    });

    if (this.notificationService && event.level) {
      this.notificationService.sendNotification({
        session_id: request.sessionId,
        level: event.level,
        title: event.title,
        message: event.body ?? `协助 ${request.id} 状态：${request.state}`,
        metadata: {
          assist_id: request.id,
          task_id: request.taskId,
          event: event.type,
          state: request.state,
          ...(event.metadata ?? {})
        }
      });
    }
  }

  private generateAssistId(): string {
    return `assist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private assertRequired(value: string | undefined, field: string): void {
    if (!value || !value.trim()) {
      throw new Error(`协助请求缺少必填字段：${field}`);
    }
  }

  /**
   * 简易超时巡检：检查未完成协助的响应截止时间，到期即自动标记超时并推送黑板/通知
   */
  public runDeadlineSweep(now: number = Date.now()): void {
    const pendingStates: AssistState[] = ['requested', 'assigned', 'in-progress'];
    const assists = this.state.queryAssistRequests({});
    assists.forEach(request => {
      if (!request.responseDeadline || !pendingStates.includes(request.state)) {
        return;
      }
      if (request.responseDeadline <= now) {
        try {
          this.timeoutAssist(request.id, {
            actorId: 'system',
            notes: '协助响应超时'
          });
        } catch (error) {
          // ignore sweep errors
        }
      }
    });
  }

  private appendTaskAssistHistory(taskId: string, entry: { event: string; assistId: string; note?: string }) {
    if (!taskId) {
      return;
    }
    const sessionId = this.taskService.getTask(taskId)?.session_id || 'global';
    const message = `[协助] ${entry.event} · ${entry.assistId}${entry.note ? ` · ${entry.note}` : ''}`;
    this.messageService.sendMessage({
      id: `assist_event_${entry.assistId}_${Date.now()}`,
      session_id: sessionId,
      agent_id: 'workflow_orchestrator',
      content: message,
      priority: 'medium',
      tags: ['assist', `assist:${entry.assistId}`, `task:${taskId}`],
      reply_to: null,
      references: null,
      reference_type: 'task',
      reference_id: taskId,
      mentions: null,
      expires_at: null,
      payload: {
        kind: 'assist_history',
        event: entry.event,
        assist_id: entry.assistId,
        task_id: taskId
      }
    });
  }
}
