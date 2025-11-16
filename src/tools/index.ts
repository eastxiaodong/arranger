import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Services } from '../services';
import type { AgentRole, VoteType, MCPServer } from '../types';

const execAsync = promisify(exec);

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (input: any) => Promise<any>;
}

interface ToolFactoryOptions {
  services: Services;
  getSessionId: () => string | null;
  getAgentInfo: () => { id: string; displayName: string };
  getActiveTaskId?: () => string | null;
}

const VOTE_TYPES = new Set(['simple_majority', 'absolute_majority', 'unanimous', 'veto']);

const AGENT_ROLES: AgentRole[] = ['admin', 'developer', 'reviewer', 'tester', 'security', 'documenter', 'coordinator', 'analyzer'];

export function createTools(context: vscode.ExtensionContext, options: ToolFactoryOptions): Tool[] {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  const ensureSession = () => {
    const sessionId = options.getSessionId();
    if (!sessionId) {
      throw new Error('No active session. Please start the orchestrator session first.');
    }
    return sessionId;
  };

  const agentInfo = () => options.getAgentInfo();
  const getActiveTaskId = () => options.getActiveTaskId ? options.getActiveTaskId() : null;
  const sanitizeMcpServer = (server: MCPServer) => {
    const status = options.services.mcp.getCachedStatus(server.id);
    return {
      id: server.id,
      name: server.name,
      description: server.description ?? null,
      command: server.command,
      args: server.args,
      enabled: server.enabled,
      is_default: server.is_default,
      created_at: server.created_at,
      updated_at: server.updated_at,
      status: status
        ? {
            available: status.available,
            last_checked_at: status.checked_at ?? null,
            error: status.error ?? null,
            tool_count: status.toolCount ?? null
          }
        : undefined
    };
  };

  const formatMcpTools = (tools: any[]): Array<{
    name: string;
    description: string | null;
    input_schema: any;
    metadata?: any;
  }> => {
    if (!Array.isArray(tools)) {
      return [];
    }
    return tools.map(tool => ({
      name: tool?.name || tool?.id || 'unknown_tool',
      description: tool?.description ?? tool?.summary ?? null,
      input_schema: tool?.input_schema ?? tool?.parameters ?? null,
      metadata: tool?.metadata ?? tool?.extensions
    }));
  };

  const computeLineChanges = (oldContent: string, newContent: string) => {
    const oldLines = oldContent ? oldContent.split(/\r?\n/) : [];
    const newLines = newContent ? newContent.split(/\r?\n/) : [];
    return {
      added: Math.max(newLines.length - oldLines.length, 0),
      removed: Math.max(oldLines.length - newLines.length, 0)
    };
  };

  const createPseudoDiff = (oldContent: string, newContent: string) => {
    const diffLines = ['--- original', '+++ new'];
    const oldLines = oldContent.split(/\r?\n/);
    const newLines = newContent.split(/\r?\n/);
    const max = Math.max(oldLines.length, newLines.length);
    diffLines.push('@@');
    for (let i = 0; i < max; i++) {
      if (oldLines[i] !== undefined) {
        diffLines.push(`-${oldLines[i]}`);
      }
      if (newLines[i] !== undefined) {
        diffLines.push(`+${newLines[i]}`);
      }
    }
    return diffLines.join('\n');
  };

  const autoRecordFileChange = async (params: {
    filePath: string;
    changeType: 'create' | 'modify' | 'delete';
    oldContent: string | null;
    newContent: string | null;
    reason?: string;
  }) => {
    try {
      const sessionId = ensureSession();
      const agent = agentInfo();
      const diff = createPseudoDiff(params.oldContent || '', params.newContent || '');
      const lineChanges = computeLineChanges(params.oldContent || '', params.newContent || '');
      await options.services.fileChange.recordChange({
        session_id: sessionId,
        task_id: getActiveTaskId(),
        agent_id: agent.id,
        file_path: params.filePath,
        change_type: params.changeType,
        old_content: params.oldContent,
        new_content: params.newContent,
        diff,
        line_changes: lineChanges,
        reason: params.reason || null
      });
    } catch (error) {
      console.error('[Tools] Failed to record file change', error);
    }
  };

  const normalizeReason = (reason?: string) => {
    if (!reason) {
      return null;
    }
    const trimmed = reason.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const pickApproverByRole = (role?: string) => {
    if (!role) {
      return null;
    }
    const normalized = role.toLowerCase();
    if (!AGENT_ROLES.includes(normalized as AgentRole)) {
      return null;
    }
    const candidates = options.services.agent.getAgentsByRole(normalized as AgentRole);
    if (!candidates || candidates.length === 0) {
      return null;
    }
    return options.services.agent.getLeastLoadedAgent(candidates) || candidates[0];
  };

  const normalizeRoles = (roles: any): AgentRole[] => {
    if (!Array.isArray(roles)) {
      return [];
    }
    return roles
      .map(role => String(role).toLowerCase())
      .filter(role => AGENT_ROLES.includes(role as AgentRole)) as AgentRole[];
  };

  return [
    // 文件操作工具
    {
      name: 'read_file',
      description: 'Read the contents of a file',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file relative to workspace root'
          }
        },
        required: ['path']
      },
      handler: async (input: { path: string }) => {
        const filePath = path.join(workspaceRoot, input.path);
        const content = await fs.promises.readFile(filePath, 'utf8');
        return { content };
      }
    },

    {
      name: 'write_file',
      description: 'Write content to a file',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file relative to workspace root'
          },
          content: {
            type: 'string',
            description: 'Content to write to the file'
          },
          reason: {
            type: 'string',
            description: 'Optional description for this change'
          }
        },
        required: ['path', 'content']
      },
      handler: async (input: { path: string; content: string; reason?: string }) => {
        const filePath = path.join(workspaceRoot, input.path);
        const dir = path.dirname(filePath);
        const reason = normalizeReason(input.reason) || 'write_file tool';
        const existed = fs.existsSync(filePath);
        const oldContent = existed ? await fs.promises.readFile(filePath, 'utf8') : null;

        // 确保目录存在
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(filePath, input.content, 'utf8');

        await autoRecordFileChange({
          filePath: input.path,
          changeType: existed ? 'modify' : 'create',
          oldContent,
          newContent: input.content,
          reason
        });
        return { success: true };
      }
    },

    {
      name: 'list_files',
      description: 'List files in a directory',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the directory relative to workspace root'
          }
        },
        required: ['path']
      },
      handler: async (input: { path: string }) => {
        const dirPath = path.join(workspaceRoot, input.path);
        const files = await fs.promises.readdir(dirPath);
        return { files };
      }
    },

    {
      name: 'delete_file',
      description: 'Delete a file',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file relative to workspace root'
          }
        },
        required: ['path']
      },
      handler: async (input: { path: string; reason?: string }) => {
        const filePath = path.join(workspaceRoot, input.path);
        const reason = normalizeReason(input.reason) || 'delete_file tool';
        let oldContent: string | null = null;
        try {
          oldContent = await fs.promises.readFile(filePath, 'utf8');
        } catch (error) {
          // ignore
        }
        await fs.promises.unlink(filePath);
        await autoRecordFileChange({
          filePath: input.path,
          changeType: 'delete',
          oldContent,
          newContent: null,
          reason
        });
        return { success: true };
      }
    },

    // Git 操作工具
    {
      name: 'git_status',
      description: 'Get git status',
      input_schema: {
        type: 'object',
        properties: {}
      },
      handler: async () => {
        const { stdout } = await execAsync('git status --porcelain', { cwd: workspaceRoot });
        return { status: stdout };
      }
    },

    {
      name: 'git_diff',
      description: 'Get git diff',
      input_schema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Optional file path to diff'
          }
        }
      },
      handler: async (input: { file?: string }) => {
        const cmd = input.file ? `git diff ${input.file}` : 'git diff';
        const { stdout } = await execAsync(cmd, { cwd: workspaceRoot });
        return { diff: stdout };
      }
    },

    {
      name: 'git_commit',
      description: 'Create a git commit',
      input_schema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Commit message'
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files to commit (optional, commits all if not specified)'
          }
        },
        required: ['message']
      },
      handler: async (input: { message: string; files?: string[] }) => {
        if (input.files && input.files.length > 0) {
          await execAsync(`git add ${input.files.join(' ')}`, { cwd: workspaceRoot });
        } else {
          await execAsync('git add -A', { cwd: workspaceRoot });
        }
        
        const { stdout } = await execAsync(`git commit -m "${input.message}"`, { cwd: workspaceRoot });
        return { output: stdout };
      }
    },

    // 终端操作工具
    {
      name: 'run_command',
      description: 'Run a shell command',
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Command to run'
          }
        },
        required: ['command']
      },
      handler: async (input: { command: string }) => {
        const { stdout, stderr } = await execAsync(input.command, { cwd: workspaceRoot });
        return { stdout, stderr };
      }
    },

    // VSCode 操作工具
    {
      name: 'open_file',
      description: 'Open a file in the editor',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file relative to workspace root'
          },
          line: {
            type: 'number',
            description: 'Optional line number to jump to'
          }
        },
        required: ['path']
      },
      handler: async (input: { path: string; line?: number }) => {
        const filePath = path.join(workspaceRoot, input.path);
        const uri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        
        if (input.line !== undefined) {
          const position = new vscode.Position(input.line - 1, 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position));
        }
        
        return { success: true };
      }
    },

    {
      name: 'search_files',
      description: 'Search for text in files',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query'
          },
          include: {
            type: 'string',
            description: 'Glob pattern for files to include'
          },
          exclude: {
            type: 'string',
            description: 'Glob pattern for files to exclude'
          }
        },
        required: ['query']
      },
      handler: async (input: { query: string; include?: string; exclude?: string }) => {
        const results = await vscode.workspace.findFiles(
          input.include || '**/*',
          input.exclude || '**/node_modules/**'
        );
        
        const matches: any[] = [];
        
        for (const uri of results) {
          const content = await fs.promises.readFile(uri.fsPath, 'utf8');
          const lines = content.split('\n');
          
          lines.forEach((line, index) => {
            if (line.includes(input.query)) {
              matches.push({
                file: vscode.workspace.asRelativePath(uri),
                line: index + 1,
                content: line.trim()
              });
            }
          });
        }
        
        return { matches };
      }
    },

    {
      name: 'show_message',
      description: 'Show a message to the user',
      input_schema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Message to show'
          },
          type: {
            type: 'string',
            enum: ['info', 'warning', 'error'],
            description: 'Message type'
          }
        },
        required: ['message']
      },
      handler: async (input: { message: string; type?: string }) => {
        switch (input.type) {
          case 'warning':
            vscode.window.showWarningMessage(input.message);
            break;
          case 'error':
            vscode.window.showErrorMessage(input.message);
            break;
          default:
            vscode.window.showInformationMessage(input.message);
        }
        return { success: true };
      }
    }
    ,
    {
      name: 'create_vote',
      description: '发起一个投票，让其他 Agent 或用户参与决策',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '投票标题' },
          description: { type: 'string', description: '投票描述' },
          vote_type: {
            type: 'string',
            enum: Array.from(VOTE_TYPES),
            description: '投票类型'
          },
          timeout_minutes: {
            type: 'number',
            description: '超时时间（分钟，默认 5）'
          },
          required_roles: {
            type: 'array',
            items: { type: 'string' },
            description: '需要参与投票的角色（可选）'
          },
          task_id: {
            type: 'string',
            description: '关联任务 ID（可选）'
          }
        },
        required: ['title', 'timeout_minutes']
      },
      handler: async (input: any) => {
        const sessionId = ensureSession();
        const title = String(input.title || '').trim();
        if (!title) {
          throw new Error('title is required');
        }

        const voteType: VoteType = VOTE_TYPES.has(input.vote_type) ? input.vote_type : 'simple_majority';
        const timeoutMinutes = Math.max(Number(input.timeout_minutes) || 5, 1);
        const requiredRoles = normalizeRoles(input.required_roles);
        const topic = options.services.vote.createTopic({
          id: `topic-${Date.now()}`,
          session_id: sessionId,
          task_id: input.task_id || null,
          title,
          description: input.description || null,
          vote_type: voteType as any,
          required_roles: requiredRoles.length > 0 ? requiredRoles : null,
          created_by: agentInfo().id,
          timeout_at: Date.now() + timeoutMinutes * 60 * 1000,
          status: 'pending',
          result: null
        });

        options.services.notification.sendNotification({
          session_id: sessionId,
          level: 'info',
          title: '新投票已发起',
          message: `${agentInfo().displayName} 发起投票 "${title}"`
        });

        return { topic_id: topic.id, status: topic.status };
      }
    },
    {
      name: 'vote_on_topic',
      description: '在指定投票上进行表决',
      input_schema: {
        type: 'object',
        properties: {
          topic_id: { type: 'string', description: '投票主题 ID' },
          choice: {
            type: 'string',
            enum: ['approve', 'reject', 'abstain'],
            description: '投票选择'
          },
          comment: { type: 'string', description: '可选评论' }
        },
        required: ['topic_id', 'choice']
      },
      handler: async (input: any) => {
        const topic = options.services.vote.getTopic(input.topic_id);
        if (!topic) {
          throw new Error(`投票主题 ${input.topic_id} 不存在`);
        }
        const choice = input.choice;
        if (!['approve', 'reject', 'abstain'].includes(choice)) {
          throw new Error('choice must be approve/reject/abstain');
        }
        const vote = options.services.vote.castVote(topic.id, agentInfo().id, choice, input.comment);
        return { topic_id: topic.id, choice: vote.choice };
      }
    },
    {
      name: 'create_approval',
      description: '发起一个审批请求，等待指定审批人批准',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '关联任务 ID' },
          approver_id: { type: 'string', description: '指定审批人 ID（可选）' },
          approver_role: { type: 'string', description: '审批人角色（当未指定 approver_id 时生效）' },
          reason: { type: 'string', description: '审批原因' }
        },
        required: ['task_id', 'reason']
      },
      handler: async (input: any) => {
        const sessionId = ensureSession();
        const taskId = String(input.task_id || '').trim();
        if (!taskId) {
          throw new Error('task_id is required');
        }

        let approverId = input.approver_id?.trim();
        if (!approverId && input.approver_role) {
          const approver = pickApproverByRole(input.approver_role);
          approverId = approver?.id;
        }

        if (!approverId) {
          throw new Error('无法确定审批人，请提供 approver_id 或 approver_role');
        }

        const approval = options.services.approval.createApproval({
          session_id: sessionId,
          task_id: taskId,
          created_by: agentInfo().id,
          approver_id: approverId,
          decision: 'pending',
          comment: input.reason || null
        });

        options.services.notification.sendNotification({
          session_id: sessionId,
          level: 'info',
          title: '审批请求已创建',
          message: `${agentInfo().displayName} 请求 ${approverId} 审批任务 ${taskId}`
        });

        return { approval_id: approval.id };
      }
    },
    {
      name: 'respond_approval',
      description: '对指定审批请求做出决策',
      input_schema: {
        type: 'object',
        properties: {
          approval_id: { type: 'number', description: '审批 ID' },
          decision: {
            type: 'string',
            enum: ['approved', 'rejected'],
            description: '审批决策'
          },
          comment: { type: 'string', description: '审批意见' }
        },
        required: ['approval_id', 'decision']
      },
      handler: async (input: any) => {
        const approval = options.services.approval.getApproval(Number(input.approval_id));
        if (!approval) {
          throw new Error(`审批 ${input.approval_id} 不存在`);
        }
        const sessionId = ensureSession();

        if (input.decision === 'approved') {
          options.services.approval.approve(approval.id, agentInfo().id, input.comment);
        } else if (input.decision === 'rejected') {
          options.services.approval.reject(approval.id, agentInfo().id, input.comment);
        } else {
          throw new Error('decision must be approved or rejected');
        }

        options.services.notification.sendNotification({
          session_id: sessionId,
          level: 'info',
          title: '审批已处理',
          message: `${agentInfo().displayName} 已${input.decision === 'approved' ? '批准' : '拒绝'}审批 ${approval.id}`
        });

        return { approval_id: approval.id, decision: input.decision };
      }
    },
    {
      name: 'record_file_change',
      description: '手动记录一次文件变更',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件相对路径' },
          change_type: {
            type: 'string',
            enum: ['create', 'modify', 'delete'],
            description: '变更类型'
          },
          old_content: { type: 'string', description: '旧内容（可选）' },
          new_content: { type: 'string', description: '新内容（可选）' },
          reason: { type: 'string', description: '变更原因' },
          task_id: { type: 'string', description: '关联任务 ID（可选）' }
        },
        required: ['path', 'change_type']
      },
      handler: async (input: any) => {
        const sessionId = ensureSession();
        const agent = agentInfo();
        const changeType = input.change_type;
        if (!['create', 'modify', 'delete'].includes(changeType)) {
          throw new Error('change_type must be create/modify/delete');
        }
        const oldContent = input.old_content ?? null;
        const newContent = input.new_content ?? null;
        const diff = createPseudoDiff(oldContent || '', newContent || '');
        const lineChanges = computeLineChanges(oldContent || '', newContent || '');
        const change = options.services.fileChange.recordChange({
          session_id: sessionId,
          task_id: input.task_id || getActiveTaskId() || null,
          agent_id: agent.id,
          file_path: input.path,
          change_type: changeType,
          old_content: oldContent,
          new_content: newContent,
          diff,
          line_changes: lineChanges,
          reason: normalizeReason(input.reason)
        });
        return { change_id: change.id };
      }
    },
    {
      name: 'get_file_changes',
      description: '查询文件变更记录',
      input_schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '指定会话（默认当前会话）' },
          task_id: { type: 'string', description: '过滤任务 ID' },
          agent_id: { type: 'string', description: '过滤 Agent ID' },
          file_path: { type: 'string', description: '过滤文件路径' },
          limit: { type: 'number', description: '返回数量限制（默认 20）' }
        }
      },
      handler: async (input: any) => {
        const sessionId = input.session_id || ensureSession();
        const changes = options.services.fileChange.getFileChanges({
          session_id: sessionId,
          task_id: input.task_id,
          agent_id: input.agent_id,
          file_path: input.file_path
        });
        const limit = Math.min(Math.max(input.limit || 20, 1), 200);
        return { changes: changes.slice(0, limit) };
      }
    },
    {
      name: 'get_task_file_changes',
      description: '获取某个任务的文件变更摘要',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务 ID' }
        },
        required: ['task_id']
      },
      handler: async (input: any) => {
        const changes = options.services.fileChange.getFileChanges({ task_id: input.task_id });
        const grouped = new Map<string, { count: number; added: number; removed: number; changeIds: number[] }>();
        changes.forEach(change => {
          const entry = grouped.get(change.file_path) || { count: 0, added: 0, removed: 0, changeIds: [] };
          entry.count += 1;
          entry.added += change.line_changes?.added || 0;
          entry.removed += change.line_changes?.removed || 0;
          entry.changeIds.push(change.id);
          grouped.set(change.file_path, entry);
        });
        const summary = Array.from(grouped.entries()).map(([file, info]) => ({
          file,
          changes: info.count,
          added: info.added,
          removed: info.removed,
          change_ids: info.changeIds
        }));
        return { task_id: input.task_id, summary };
      }
    },
    {
      name: 'preview_file_change',
      description: '查看指定文件变更详情',
      input_schema: {
        type: 'object',
        properties: {
          change_id: { type: 'number', description: '变更 ID' }
        },
        required: ['change_id']
      },
      handler: async (input: any) => {
        const change = options.services.fileChange.getFileChange(Number(input.change_id));
        if (!change) {
          throw new Error(`File change ${input.change_id} not found`);
        }
        return change;
      }
    },
    {
      name: 'search_context',
      description: '在当前工作区检索匹配的代码或文本片段',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的关键字或文本' },
          include_globs: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：需要包含的 glob 模式列表'
          },
          exclude_globs: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：需要排除的 glob 模式列表'
          },
          case_sensitive: {
            type: 'boolean',
            description: '是否区分大小写（默认 false）'
          },
          max_results: {
            type: 'number',
            description: '最多返回多少条匹配记录（默认 20，最大 200）'
          },
          context_lines: {
            type: 'number',
            description: '每条匹配前后展示的上下文行数（默认 2）'
          },
          max_files: {
            type: 'number',
            description: '最多扫描多少个文件（默认 5000）'
          },
          use_mcp: {
            type: 'boolean',
            description: '是否通过 MCP Server 执行检索（需已配置），默认 false'
          },
          mcp_server: {
            type: 'string',
            description: '指定使用的 MCP Server 名称（需 use_mcp=true）'
          },
          fallback_on_failure: {
            type: 'boolean',
            description: 'MCP 调用失败时是否回退到本地检索，默认 true'
          }
        },
        required: ['query']
      },
      handler: async (input: any) => {
        ensureSession(); // 触发会话校验
        const useMcp = Boolean(input.use_mcp);
        let mcpServerName: string | undefined;
        if (typeof input.mcp_server === 'string' && input.mcp_server.trim().length > 0) {
          mcpServerName = input.mcp_server.trim();
        } else if (useMcp) {
          const defaultServer = options.services.mcpServer.getDefaultServer();
          if (defaultServer) {
            mcpServerName = defaultServer.name;
          }
        }
        const result = await options.services.context.search({
          query: String(input.query || ''),
          include_globs: Array.isArray(input.include_globs) ? input.include_globs : undefined,
          exclude_globs: Array.isArray(input.exclude_globs) ? input.exclude_globs : undefined,
          case_sensitive: Boolean(input.case_sensitive),
          max_results: input.max_results,
          context_lines: input.context_lines,
          max_files: input.max_files,
          use_mcp: useMcp,
          mcp_server: mcpServerName,
          fallback_on_failure: input.fallback_on_failure !== undefined ? Boolean(input.fallback_on_failure) : true
        });
        return result;
      }
    },
    {
      name: 'list_mcp_servers',
      description: '列出当前可用的 MCP Server（可选择仅查看启用的服务）',
      input_schema: {
        type: 'object',
        properties: {
          include_disabled: {
            type: 'boolean',
            description: '是否包含已禁用的 Server，默认 true'
          }
        }
      },
      handler: async (input: any) => {
        ensureSession();
        const includeDisabled = input?.include_disabled !== undefined ? Boolean(input.include_disabled) : true;
        const servers = options.services.mcpServer.getAllServers(includeDisabled ? {} : { enabled: true });
        return {
          count: servers.length,
          servers: servers.map(server => sanitizeMcpServer(server))
        };
      }
    },
    {
      name: 'list_mcp_tools',
      description: '列出指定 MCP Server 提供的工具（默认使用当前默认 Server）',
      input_schema: {
        type: 'object',
        properties: {
          server_name: {
            type: 'string',
            description: '可选：指定 MCP Server 名称，默认使用全局默认 Server'
          }
        }
      },
      handler: async (input: any) => {
        ensureSession();
        const serverName = typeof input?.server_name === 'string' && input.server_name.trim().length > 0
          ? input.server_name.trim()
          : undefined;
        const result = await options.services.mcp.listTools(serverName);
        const tools = formatMcpTools(result.tools);
        return {
          server: sanitizeMcpServer(result.server),
          tool_count: tools.length,
          tools
        };
      }
    },
    {
      name: 'list_mcp_resources',
      description: '列出指定 MCP Server 暴露的资源（默认使用当前默认 Server）',
      input_schema: {
        type: 'object',
        properties: {
          server_name: {
            type: 'string',
            description: '可选：指定 MCP Server 名称，默认使用全局默认 Server'
          }
        }
      },
      handler: async (input: any) => {
        ensureSession();
        const serverName = typeof input?.server_name === 'string' && input.server_name.trim().length > 0
          ? input.server_name.trim()
          : undefined;
        const result = await options.services.mcp.listResources(serverName);
        return {
          server: sanitizeMcpServer(result.server),
          resource_count: Array.isArray(result.resources) ? result.resources.length : 0,
          resources: result.resources || []
        };
      }
    },
    {
      name: 'get_mcp_resource',
      description: '读取 MCP Server 上的指定资源内容',
      input_schema: {
        type: 'object',
        properties: {
          uri: {
            type: 'string',
            description: '资源 URI（由 list_mcp_resources 返回）'
          },
          server_name: {
            type: 'string',
            description: '可选：指定 MCP Server 名称，默认使用全局默认 Server'
          }
        },
        required: ['uri']
      },
      handler: async (input: any) => {
        ensureSession();
        const serverName = typeof input?.server_name === 'string' && input.server_name.trim().length > 0
          ? input.server_name.trim()
          : undefined;
        const uri = String(input.uri || '').trim();
        if (!uri) {
          throw new Error('uri is required');
        }
        const { server, resource } = await options.services.mcp.readResource(serverName, uri);
        return {
          server: sanitizeMcpServer(server),
          resource
        };
      }
    },
    {
      name: 'list_mcp_prompts',
      description: '列出指定 MCP Server 提供的提示词（默认使用当前默认 Server）',
      input_schema: {
        type: 'object',
        properties: {
          server_name: {
            type: 'string',
            description: '可选：指定 MCP Server 名称，默认使用全局默认 Server'
          }
        }
      },
      handler: async (input: any) => {
        ensureSession();
        const serverName = typeof input?.server_name === 'string' && input.server_name.trim().length > 0
          ? input.server_name.trim()
          : undefined;
        const result = await options.services.mcp.listPrompts(serverName);
        return {
          server: sanitizeMcpServer(result.server),
          prompt_count: Array.isArray(result.prompts) ? result.prompts.length : 0,
          prompts: result.prompts || []
        };
      }
    },
    {
      name: 'get_mcp_prompt',
      description: '获取指定 MCP Server 上某个提示词的详细信息',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '提示词名称'
          },
          server_name: {
            type: 'string',
            description: '可选：指定 MCP Server 名称，默认使用全局默认 Server'
          }
        },
        required: ['name']
      },
      handler: async (input: any) => {
        ensureSession();
        const promptName = String(input?.name || '').trim();
        if (!promptName) {
          throw new Error('name is required');
        }
        const serverName = typeof input?.server_name === 'string' && input.server_name.trim().length > 0
          ? input.server_name.trim()
          : undefined;
        const { server, prompt } = await options.services.mcp.getPrompt(serverName, promptName);
        return {
          server: sanitizeMcpServer(server),
          prompt
        };
      }
    }
  ];
}
