import { DatabaseManager } from '../database';
import { TypedEventEmitter } from '../events/emitter';
import type { GovernanceHistoryEntry, Topic, Approval } from '../types';

type GovernanceHistoryInput = Omit<GovernanceHistoryEntry, 'id' | 'created_at'>;

type GovernanceAnalyticsRange = '7d' | '30d' | '90d' | 'all';
type GovernanceAnalyticsType = 'all' | 'vote' | 'approval';

interface GovernanceAnalyticsOptions {
  range?: GovernanceAnalyticsRange;
  type?: GovernanceAnalyticsType;
  session_id?: string;
}

interface GovernanceTimelineBucket {
  label: string;
  start: number;
  end: number;
  votes: number;
  approvals: number;
}

interface GovernanceHotspot {
  task_id: string;
  task_title: string;
  votes: number;
  approvals: number;
  total: number;
  last_event: number;
}

interface GovernanceSummary {
  votes: {
    total: number;
    pending: number;
    completed: number;
    timeout: number;
    average_duration_ms: number;
  };
  approvals: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    average_duration_ms: number;
  };
}

interface GovernanceAnalyticsResult {
  generated_at: number;
  range: GovernanceAnalyticsRange;
  type: GovernanceAnalyticsType;
  summary: GovernanceSummary;
  timeline: GovernanceTimelineBucket[];
  hotspots: GovernanceHotspot[];
  recent_actions: GovernanceHistoryEntry[];
}

const RANGE_TO_MS: Record<Exclude<GovernanceAnalyticsRange, 'all'>, number> = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000
};

const TIMELINE_CONFIG: Record<GovernanceAnalyticsRange, { bucketSize: number; bucketCount: number }> = {
  '7d': { bucketSize: 24 * 60 * 60 * 1000, bucketCount: 7 },
  '30d': { bucketSize: 3 * 24 * 60 * 60 * 1000, bucketCount: 10 },
  '90d': { bucketSize: 9 * 24 * 60 * 60 * 1000, bucketCount: 10 },
  'all': { bucketSize: 14 * 24 * 60 * 60 * 1000, bucketCount: 10 }
};

export class GovernanceHistoryService {
  constructor(
    private readonly db: DatabaseManager,
    private readonly events: TypedEventEmitter
  ) {}

  recordEntry(entry: GovernanceHistoryInput): GovernanceHistoryEntry {
    const created = this.db.createGovernanceHistoryEntry(entry);
    this.broadcast();
    return created;
  }

  getRecentEntries(limit: number = 50): GovernanceHistoryEntry[] {
    return this.db.getGovernanceHistoryEntries({ limit });
  }

  getEntries(filters?: {
    session_id?: string;
    type?: GovernanceHistoryEntry['type'];
    entity_id?: string;
    entity_ids?: string[];
    entity_query?: string;
    action?: string;
    search?: string;
    start_time?: number;
    end_time?: number;
    limit?: number;
    offset?: number;
  }): GovernanceHistoryEntry[] {
    return this.db.getGovernanceHistoryEntries(filters);
  }

  getAnalytics(options: GovernanceAnalyticsOptions = {}): GovernanceAnalyticsResult {
    const now = Date.now();
    const range = options.range ?? '7d';
    const typeFilter = options.type ?? 'all';
    const sessionId = options.session_id;
    const rangeMs = range === 'all' ? null : RANGE_TO_MS[range];
    const since = rangeMs ? now - rangeMs : null;

    const includeVotes = typeFilter === 'all' || typeFilter === 'vote';
    const includeApprovals = typeFilter === 'all' || typeFilter === 'approval';

    const topicFilters = sessionId ? { session_id: sessionId } : undefined;
    const approvalFilters = sessionId ? { session_id: sessionId } : undefined;
    const allTopics = includeVotes ? this.db.getTopics(topicFilters) : [];
    const allApprovals = includeApprovals ? this.db.getApprovals(approvalFilters) : [];

    const filteredTopics = since ? allTopics.filter(topic => topic.created_at >= since) : allTopics;
    const filteredApprovals = since
      ? allApprovals.filter(approval => approval.created_at >= since)
      : allApprovals;

    const entityIds: string[] = [];
    if (includeVotes) {
      filteredTopics.forEach(topic => entityIds.push(topic.id));
    }
    if (includeApprovals) {
      filteredApprovals.forEach(approval => entityIds.push(String(approval.id)));
    }

    const historyFilters: Record<string, any> = {};
    if (sessionId) {
      historyFilters.session_id = sessionId;
    }
    if (entityIds.length > 0) {
      historyFilters.entity_ids = entityIds;
    }
    const historyEntries = this.db.getGovernanceHistoryEntries(Object.keys(historyFilters).length > 0 ? historyFilters : undefined);

    const historyByEntity = new Map<string, GovernanceHistoryEntry[]>();
    historyEntries.forEach(entry => {
      if (!historyByEntity.has(entry.entity_id)) {
        historyByEntity.set(entry.entity_id, []);
      }
      historyByEntity.get(entry.entity_id)!.push(entry);
    });
    historyByEntity.forEach(entries => entries.sort((a, b) => a.created_at - b.created_at));

    const averageVoteDuration = includeVotes
      ? this.calculateAverageDuration(filteredTopics, historyByEntity, new Set(['topic_closed', 'topic_timeout']))
      : 0;
    const averageApprovalDuration = includeApprovals
      ? this.calculateAverageDuration(
          filteredApprovals.map(approval => ({ id: String(approval.id), created_at: approval.created_at })),
          historyByEntity,
          new Set(['approval_approved', 'approval_rejected'])
        )
      : 0;

    const summary: GovernanceSummary = {
      votes: {
        total: filteredTopics.length,
        pending: filteredTopics.filter(topic => topic.status === 'pending').length,
        completed: filteredTopics.filter(topic => topic.status === 'completed').length,
        timeout: filteredTopics.filter(topic => topic.status === 'timeout').length,
        average_duration_ms: averageVoteDuration
      },
      approvals: {
        total: filteredApprovals.length,
        pending: filteredApprovals.filter(approval => approval.decision === 'pending').length,
        approved: filteredApprovals.filter(approval => approval.decision === 'approved').length,
        rejected: filteredApprovals.filter(approval => approval.decision === 'rejected').length,
        average_duration_ms: averageApprovalDuration
      }
    };

    const timeline = this.buildTimeline(range, since, now, filteredTopics, filteredApprovals);
    const hotspots = this.buildHotspots(filteredTopics, filteredApprovals);
    const recentActions = historyEntries
      .filter(entry => (since ? entry.created_at >= since : true))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 8);

    return {
      generated_at: now,
      range,
      type: typeFilter,
      summary,
      timeline,
      hotspots,
      recent_actions: recentActions
    };
  }

  private buildTimeline(
    range: GovernanceAnalyticsRange,
    since: number | null,
    now: number,
    topics: Topic[],
    approvals: Approval[]
  ): GovernanceTimelineBucket[] {
    const config = TIMELINE_CONFIG[range];
    const bucketSize = config.bucketSize;
    const bucketCount = config.bucketCount;
    const rangeStart = since ?? (now - bucketSize * bucketCount);
    const timelineStart = Math.min(rangeStart, now - bucketSize * bucketCount);

    const buckets: GovernanceTimelineBucket[] = [];
    for (let i = 0; i < bucketCount; i += 1) {
      const start = timelineStart + i * bucketSize;
      const end = start + bucketSize;
      buckets.push({
        label: this.formatTimelineLabel(start, bucketSize),
        start,
        end,
        votes: 0,
        approvals: 0
      });
    }

    const increment = (timestamp: number, key: 'votes' | 'approvals') => {
      const index = Math.floor((timestamp - timelineStart) / bucketSize);
      if (index >= 0 && index < buckets.length) {
        buckets[index][key] += 1;
      }
    };

    topics.forEach(topic => increment(topic.created_at, 'votes'));
    approvals.forEach(approval => increment(approval.created_at, 'approvals'));

    return buckets;
  }

  private buildHotspots(topics: Topic[], approvals: Approval[]): GovernanceHotspot[] {
    const cache = new Map<string, string>();
    const map = new Map<string, GovernanceHotspot>();

    const touch = (taskId: string | null, timestamp: number, kind: 'vote' | 'approval') => {
      if (!taskId) {
        return;
      }
      if (!map.has(taskId)) {
        map.set(taskId, {
          task_id: taskId,
          task_title: '',
          votes: 0,
          approvals: 0,
          total: 0,
          last_event: 0
        });
      }
      const slot = map.get(taskId)!;
      if (kind === 'vote') {
        slot.votes += 1;
      } else {
        slot.approvals += 1;
      }
      slot.total = slot.votes + slot.approvals;
      slot.last_event = Math.max(slot.last_event, timestamp);
    };

    topics.forEach(topic => touch(topic.task_id || null, topic.created_at, 'vote'));
    approvals.forEach(approval => touch(approval.task_id, approval.created_at, 'approval'));

    const hotspots = Array.from(map.values()).map(entry => ({
      ...entry,
      task_title: this.resolveTaskTitle(entry.task_id, cache)
    }));

    return hotspots
      .sort((a, b) => {
        if (b.total === a.total) {
          return b.last_event - a.last_event;
        }
        return b.total - a.total;
      })
      .slice(0, 5);
  }

  private resolveTaskTitle(taskId: string, cache: Map<string, string>): string {
    if (cache.has(taskId)) {
      return cache.get(taskId)!;
    }
    const task = this.db.getTask(taskId);
    const title = task?.title || task?.intent || taskId;
    cache.set(taskId, title);
    return title;
  }

  private calculateAverageDuration(
    items: Array<{ id: string; created_at: number }>,
    historyByEntity: Map<string, GovernanceHistoryEntry[]>,
    closingActions: Set<string>
  ): number {
    if (items.length === 0) {
      return 0;
    }
    const durations: number[] = [];
    items.forEach(item => {
      const entries = historyByEntity.get(item.id);
      if (!entries || !entries.length) {
        return;
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (closingActions.has(entry.action)) {
          const duration = Math.max(entry.created_at - item.created_at, 0);
          durations.push(duration);
          break;
        }
      }
    });

    if (!durations.length) {
      return 0;
    }
    const total = durations.reduce((sum, value) => sum + value, 0);
    return Math.round(total / durations.length);
  }

  private formatTimelineLabel(start: number, bucketSize: number): string {
    const startDate = new Date(start);
    const endDate = new Date(start + bucketSize);
    const startLabel = `${startDate.getMonth() + 1}/${startDate.getDate()}`;
    if (bucketSize <= 24 * 60 * 60 * 1000) {
      return startLabel;
    }
    const endLabel = `${endDate.getMonth() + 1}/${endDate.getDate()}`;
    return `${startLabel}-${endLabel}`;
  }

  broadcast(): void {
    try {
      const entries = this.getRecentEntries();
      this.events.emit('governance_history_update', entries);
    } catch (error) {
      console.error('[GovernanceHistoryService] Failed to broadcast history', error);
    }
  }
}
