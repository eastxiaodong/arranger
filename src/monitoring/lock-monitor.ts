import * as vscode from 'vscode';
import { LockService } from '../services/lock.service';
import type { Lock } from '../types';

interface LockMonitorOptions {
  intervalMs?: number;
  warningThreshold?: number;
  expiringWindowMs?: number;
  alertCooldownMs?: number;
}

export class LockMonitor {
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;
  private readonly warningThreshold: number;
  private readonly expiringWindowMs: number;
  private readonly alertCooldownMs: number;
  private lastAlertAt = 0;

  constructor(
    private readonly lockService: LockService,
    private readonly logger: vscode.OutputChannel,
    options?: LockMonitorOptions
  ) {
    this.intervalMs = options?.intervalMs ?? 30000;
    this.warningThreshold = options?.warningThreshold ?? 10;
    this.expiringWindowMs = options?.expiringWindowMs ?? 30_000;
    this.alertCooldownMs = options?.alertCooldownMs ?? 120_000;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.logger.appendLine('[LockMonitor] Starting lock monitor');
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.appendLine('[LockMonitor] Lock monitor stopped');
    }
  }

  private tick() {
    try {
      const locks = this.lockService.getLocks();
      this.lockService.cleanupExpired();
      if (locks.length === 0) {
        return;
      }
      const staleLocks = this.findStaleLocks(locks);
      if (staleLocks.length === 0 && locks.length < this.warningThreshold) {
        return;
      }
      const now = Date.now();
      if (now - this.lastAlertAt < this.alertCooldownMs) {
        return;
      }
      this.lastAlertAt = now;
      const warningMessage = staleLocks.length > 0
        ? `检测到 ${staleLocks.length} 个即将过期的锁，请确认是否卡住：${staleLocks.map(lock => lock.resource).join(', ')}`
        : `当前存在 ${locks.length} 个活跃锁，已达到告警阈值`;
      this.logger.appendLine('[LockMonitor] ' + warningMessage);
      void vscode.window.showWarningMessage(warningMessage, '打开锁监控面板').then(selection => {
        if (selection === '打开锁监控面板') {
          vscode.commands.executeCommand('arranger.openPanel');
        }
      });
    } catch (error: any) {
      this.logger.appendLine('[LockMonitor] Tick failed: ' + (error?.message ?? error));
    }
  }

  private findStaleLocks(locks: Lock[]): Lock[] {
    const now = Date.now();
    return locks.filter(lock => {
      if (!lock.expires_at) {
        return false;
      }
      const remaining = lock.expires_at - now;
      return remaining <= this.expiringWindowMs;
    });
  }
}
