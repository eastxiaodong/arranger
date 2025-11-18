# 多 LLM 团队协作系统方案

## 0. 当前落地现状（2025.02）
- **ACE 集成**：VSCode 端已提供 ACE 配置面板、索引/搜索操作以及状态条，所有运行记录会写入 `ToolExecutionService` 与 `StateStore`。
- **经理 LLM 配置**：全局配置页提供单一槽位的经理模型（provider/model/Base URL/API Key/温度/Prompt 等），黑板顶部显示当前配置状态；后续调度逻辑直接读取 `ManagerLLMService`。
- **StateStore 原型**：已经可以记录任务状态、协助请求、Agent 健康与 ACE 运行摘要，但尚未纳入任务拆解、协助链路和工具日志等核心事件。
- **UI 骨架**：黑板/工作台/全局配置保留现有布局，可复用事件推送机制，只需切换数据源与播报内容。

> 本方案后续章节围绕“如何在现有基础上补齐全局调度、状态编排、黑板反馈”展开，若实现方式与文档不符，应以本文为准及时调整。

## 1. 设计目标
- 用户只需以自然语言提出任务（需求、Bug、文档、讨论等），系统自动完成理解、拆解、执行与汇报。
- 整个交互聚焦在“群聊体验”：用户像在团队聊天群里旁观真实成员协作，看到谁在做什么、进展如何。
- 架构核心在于“轻量调度 LLM + 多模型成员 + 统一工具层”，强调性能和合理性，保证任务连贯、协作自然。
- “状态编排层 + 调度经理池”成为新的技术底座，全面替换旧 Workflow；所有 UI、工具和调度行为都以状态层为单一事实源。

## 2. 角色与职责
1. **用户（需求发布者）**：通过黑板提出要求、查看结果，可选择性反馈或提供补充信息。
2. **团队经理（调度 LLM 池）**：一组轻量模型负责任务理解、拆分、指派、协助、降级和总结，可轮值并在故障时自动切换。
3. **团队成员（执行 LLM）**：多个能力各异的 LLM（高推理、执行、文档、测试等），由经理指派任务或协助。
4. **工具层**：插件提供的终端、MCP、外部 API 等，由所有 LLM 共享，记录执行日志供追踪。
5. **状态编排层**：新的状态服务，集中承载任务、协助、工具日志、敏感关键字策略，并向所有消费方广播事件。

> **可复用基础**：
> - `AgentScheduler` / `Sentinel`：沿用心跳监控、事件通知，扩展为经理池健康检查与降级触发器。
> - `ToolExecutionService` + MCP 适配器：接入统一风险评估与日志管道，写入状态层。
> - Proof/日志体系：输出改为基于状态层事件，减少重复拼装。
> - Webview 黑板框架与事件总线：继续复用 UI 容器与推送机制，仅切换数据源。
> - Agent 配置与连接管理：扩展字段（能力标签、推理档位、成本系数）后直接挂入调度评分。

## 3. 核心模块
> **数据隔离**：工作空间业务数据库记录与项目相关的任务、协作、工具日志；插件全局数据库存储 Agent 配置、调度经理池、敏感关键字模板等。两者保持分离并通过状态层桥接，保证多项目隔离与共享配置并存。

### 3.0 状态编排层（统一状态与事件）
- **职责**：集中管理任务、协助、工具日志、敏感关键字、Agent 心跳等状态；提供查询/订阅 API，成为整个系统的单一事实源（SSOT）。
- **数据模型示例**

| 类型 | 核心字段 | 说明 |
| --- | --- | --- |
| Task | `taskId`, `title`, `scene`, `difficulty`, `priority`, `assignee`, `managerId`, `status[pending/active/blocked/needs-confirm/finalizing/done/failed]`, `summary`, `contextRefs`, `history` | 所有主/子任务统一建模；`contextRefs` 预留 ACE 钩子。 |
| Assist | `assistId`, `taskId`, `requester`, `helper`, `intent`, `contextDigest`, `handoffSummary`, `status`, `resultRef` | 全量追踪协助链路与上下文快照。 |
| ToolLog | `logId`, `taskId`, `agentId`, `command`, `outputDigest`, `riskLevel`, `requiresConfirm`, `confirmedBy`, `timestamp` | 由 `ToolExecutionService` 写入；敏感命令先置 `requiresConfirm=true`。 |
| KeywordPolicy | `workspaceId`, `defaultSet`, `customSet`, `status`, `lastUpdated` | 默认策略 + 用户自定义；若用户清空高危词，将 `status=warning` 并触发提示。 |
| AgentHealth | `agentId`, `heartbeat`, `errorCount`, `lastFailure`, `availability` | 来自 `AgentScheduler/Sentinel`，供降级与 UI 使用。 |

- **事件机制**：任何写操作先持久化，再发布 `TASK_CREATED/UPDATED`, `ASSIST_REQUESTED/RESOLVED`, `TOOL_LOG_APPENDED`, `KEYWORD_POLICY_CHANGED`, `AGENT_HEALTH_CHANGED` 等事件，UI 与调度器都订阅同一流。
- **落地方式**：
  1. 统一通过 `StateStore` 写入，并由 `state:*` 事件通知 UI / 调度器。任何模块若直接操作数据库或拼装临时状态，均视为违规实现。
  2. 如现有 `StateStore` 结构无法满足需求，可直接重构/重建；旧 Workflow 仅做迁移参考，完成后彻底移除。
  3. 事件命名统一（如 `state:task_created`、`state:assist_updated`、`state:ace_state_updated`），便于 Webview 与服务层订阅。

### 3.1 场景识别与任务规划
- 经理 LLM 对用户输入进行场景（功能/缺陷/测试/文档/讨论等）与难度评估，并输出任务计划。
- 拆分结果直接写入状态层 `Task` 表；黑板、任务面板只引用状态层，不再拼装临时数据。
- 与 ACE 的交互：规划阶段可请求 ACE 返回上下文摘要，填充 `Task.contextRefs`，后续成员可即时读取。

### 3.2 状态编排层接口
- 对外提供 `query(selector)` 和 `subscribe(eventType, filter)`；UI 通过 selector 获取局部数据以减小传输。
- 状态变更顺序：`intent -> validate -> persist -> emit -> ack`，保证任何 UI 看到的状态都是持久化后的结果。
- 调度器和 Proof 系统共用同一事件流，减少代码重复，确保日志、任务、工具记录一致。

### 3.3 调度器与评分
- 经理池为每个任务计算候选成员得分：`score = w1*场景匹配 + w2*推理适配 + w3*(1-当前负载) + w4*成功率 + w5*执行成本`。
- 评分参考来自状态层：`Task.scene/difficulty`、`AgentHealth.availability`、成员历史成功率等。
- 指派结果写入 `Task.assignee` 和 `Task.status`，并广播 `ASSIGNEE_CHANGED`，黑板自动播报。
- 若任务处于 `needs-confirm`（等待敏感操作确认），调度器暂停派单；用户确认后状态层自动恢复 `active` 并重新打分。
- 经理池自身由 `AgentScheduler` 管理：支持轮值、故障切换、优雅降级，Sentinel 告警直接写入 `AgentHealth`。

### 3.4 协助机制
- 执行 LLM 向经理发起协助请求，说明能力诉求与上下文摘要；状态层写入 `Assist` 记录并推送事件。
- 经理挑选协助者，记录 `helper`、预期产出与时间窗；协助完成后将 `resultRef` 合入主任务的 `history/summary`。
- 工作台与黑板直接展示 `Assist` 状态：`requested`、`in-progress`、`done` 等，用户可以直观看到谁在帮助谁。

### 3.5 故障降级
- `AgentHealth` 持续监控成员心跳、错误率；当 `availability=degraded/offline` 时，调度器触发降级流程：
  1. 将任务 `status` 置为 `reassigning`，记录故障原因。
  2. 重新评分候选成员，更新 `assignee` 并在黑板提示“已由 XXX 接手”。
  3. 若无可用成员，则把任务调到 `blocked` 并提醒用户。
- 故障信息同步到 Proof/日志，方便事后审计。

### 3.6 工具与安全控制
- 所有 LLM 经由 `ToolExecutionService` 调用统一工具层；调用前运行 `riskEvaluator`，对命令进行敏感关键字匹配与上下文检测。
- 敏感操作流程：
  1. 匹配命令命中默认或用户自定义的敏感关键字，创建 `ToolLog(requiresConfirm=true)` 并推送黑板弹窗。
  2. 用户可在弹窗中“确认/拒绝/暂缓”操作；结果写回 `ToolLog.confirmedBy` 与 `Task.status`。
  3. 仅当得到确认时工具真正执行；执行结果写入 `outputDigest`，Proof 与黑板均可查看。
- 默认敏感关键字：`rm`, `remove`, `del`, `git reset`, `restore`, `rebase`, `drop`, `truncate`, `shutdown` 等，首次初始化自动写入 `KeywordPolicy.defaultSet`。用户删除默认项时需二次确认并在 UI 显示风险提示。
- 工具日志统一写入状态层，黑板展示摘要、工作台展示完整输出，任务面板引用日志 ID 以追踪进度。

### 3.7 上下文共享
- 所有任务与协助记录 `contextRefs`，可挂接 ACE 或其他缓存索引。调度器只需传递 `taskId + contextRefs` 即可让新成员无缝接手。
- 任务总结与 Proof 也引用相同 `contextRefs`，避免重复上传大文本。

### 3.8 经理消息触发链路
1. **监听入口**：黑板输入（普通消息、回复/引用、@Agent/@manager）全部视为调度信号。消息载体必须附带 `session_id`、`reply_to`、`mentions`、原文以及可选的引用内容。
2. **意图识别**：经理 LLM 负责区分“新任务”“信息补充”“优先级变更”“协助/指派”等意图，并据此操作状态层。例如：  
   - 新任务：`StateStore.createTaskState` + `task_history` 记录来源消息。  
   - 引用消息：定位原任务/协助，追加 `history` 或 `assist.context`。  
   - @Agent：生成协助请求或直接更新任务 `assignee`。
3. **状态写入统一化**：禁止在 UI 层直接修改状态；必须由经理回调服务写入 `StateStore`，然后发布 `state:*` 事件（如 `state:task_created`、`state:assist_updated`、`state:ace_state_updated`）。
4. **播报规范**：每次调度结果需要以系统消息形式写入黑板（例如“经理将任务 A 指派给 Agent-X”），同时顶部状态条随之更新。
5. **降级/重试**：若经理 LLM 连续失败或接口异常，Sentinel 发出告警，并允许用户在黑板或配置面板中手动触发“重新调度/切换模型”。

### 3.9 数据库与配置对齐
- **全局配置库**：`system-setting.db` 存储 Agent、MCP、ACE、经理 LLM 等系统级配置；当前经理配置只有一个槽位（provider/model/Base URL/API Key/温度/Prompt），黑板状态条直接读取该表。
- **工作区数据库**：`.arranger/arranger.db` 中的任务、协助、消息、工具运行需要统一迁移到状态层定义的表结构。旧 Workflow 的 JSON/表结构若与此冲突，应优先清理。
- **事件与 Schema 约束**：每个表的 CRUD 都要对应 `state:*` 事件，方便 UI、调度器、Proof 等模块订阅；任何新增字段或表必须在文档中更新并附带迁移方案。

## 4. UI 概览
1. **群聊黑板**：展示用户消息、调度播报、协助通知、工具执行摘要、任务完成总结，支持 @ 与引用，并承载敏感关键字确认弹窗。
2. **工作台（Agent 思考窗）**：单个 LLM 的对话流，显示思考、协作、工具调用。可在同窗口查看协助请求与上下文。
3. **任务面板**：自动生成任务卡片（标题/负责人/状态/协助/最近摘要），支持筛选、排序，不提供手动编辑入口。
4. **配置中心**：管理 LLM 成员、调度经理池、敏感关键字，以及 MCP/工具状态与默认策略。
   - 当前实现已经在 VSCode 全局配置页落地 Agent 管理、MCP 列表、ACE 集成面板，同时新增“团队经理 LLM”子面板，可配置调度角色的 provider / model / Base URL / API Key / 温度 / 上下文提示，所有字段存入全局数据库并即时同步到状态层。

> **技术架构与上下文参考**：
> - 预留 ACE（Advanced Context Engine）集成入口，具体实现参见 `vscode-arranger/ACE集成参考.md`，后续可将 ACE 作为统一索引/缓存工具。
> - UI 继续采用 `html + ts` 分离（参考 `vscode-extension/src/presentation/webview/minimal-panel.html`），沿用现有样式与消息通道。

**UI 数据流**
- 黑板订阅 `Task/Assist/ToolLog/KeywordPolicy` 事件，将其转化为群聊消息、系统提示或确认弹窗。
- 任务面板使用 selector 聚合任务状态，展示被指派人、协助状态、最近工具调用，无需额外 API。
- 工作台按 `agentId` 过滤状态流，仅渲染对应 LLM 的对话、协助、工具日志；支持在成员切换时回放历史。
- 配置中心操作全局数据库，变更同步到状态层，实时刷新 UI。

## 5. 调度流程示例
1. 用户在黑板输入需求（写入状态层 `Task.requested`）。
2. 调度经理识别场景和难度，生成任务计划并将任务写入状态层。
3. 评分选出主执行 LLM，状态层更新 `assignee`，黑板播报“由 XXX 执行”。
4. 执行过程中需要协助时，成员发起 `Assist`，经理挑选协助者，黑板/工作台同步通知。
5. 成员离线或失败时，调度器根据 `AgentHealth` 触发降级，更新状态并提示“已由 YYY 接手”。
6. 工具调用触发日志与敏感关键字确认；最终经理汇总任务结果，推送总结并将状态置为 `done`。

## 6. 实施路线
1. **构建状态编排层**：实现数据模型、事件、查询 API；迁移旧 Workflow 读写逻辑，确保 UI/调度均基于状态层。
2. **实现调度经理池**：轻量模型负责场景识别、评分、指派；与 `AgentScheduler/Sentinel` 打通，完成协助与降级链路。
3. **重构黑板/任务面板/工作台**：统一订阅状态层，提供敏感关键字确认、工具日志展示与协助可视化。
4. **集成工具执行日志与安全控制**：`ToolExecutionService` 默认启用高危关键字；允许用户配置策略并实时写入状态层。
5. **ACE 与上下文整合**：根据 `ACE集成参考` 把 `contextRefs` 与状态层打通，为后续模型切换、跨任务共享上下文做准备。

完成以上步骤后，再逐步落地具体功能与联调。

---

## 7. 补充说明

### 7.1 任务状态机

任务状态转移规则：

```
pending → active → needs-confirm → active → finalizing → done
         ↓                                      ↓
       blocked ←─────────────────────────────→ failed
         ↓                                      ↓
    reassigning ──────────────────────────→ active
```

**状态说明**：
- `pending`: 任务已创建，等待调度
- `active`: 任务正在执行
- `blocked`: 任务被阻塞（依赖未满足、资源不足、等待人工处理）
- `needs-confirm`: 等待用户确认敏感操作
- `reassigning`: 任务正在重新分配（Agent 故障或降级）
- `finalizing`: 任务执行完成，正在生成总结
- `done`: 任务完成
- `failed`: 任务失败

**状态转移触发条件**：
- `pending → active`: 调度器分配 Agent
- `active → blocked`: 依赖未满足、资源不足、等待人工处理
- `active → needs-confirm`: 检测到敏感操作
- `needs-confirm → active`: 用户确认操作
- `needs-confirm → blocked`: 用户拒绝操作
- `active → finalizing`: Agent 完成执行
- `finalizing → done`: 生成总结完成
- `active → failed`: 执行出错且无法恢复
- `failed → reassigning`: 触发降级流程
- `blocked → reassigning`: 人工决定重新分配
- `reassigning → active`: 重新分配成功

### 7.2 用户反馈机制

**反馈类型**：
1. **任务反馈**: 用户对任务结果的评价（满意/不满意/需要改进）
2. **过程反馈**: 用户在任务执行过程中提供的补充信息或方向调整
3. **优先级调整**: 用户可以随时调整任务优先级

**反馈处理**：
- 所有反馈写入 `Task.history`，作为上下文的一部分
- 过程反馈可能触发任务重新规划或调整
- 优先级调整立即生效，影响调度器的评分

**反馈接口**：
```typescript
interface UserFeedback {
  feedbackId: string;
  taskId: string;
  type: 'task' | 'process' | 'priority';
  content: string;
  timestamp: number;
  action?: 'adjust' | 'replan' | 'continue';
}
```

### 7.3 经理池轮值策略

**轮值触发条件**：
1. **定时轮值**: 每 N 个任务后自动轮换（默认 10 个任务）
2. **负载均衡**: 当前经理负载过高时触发轮换
3. **故障切换**: 当前经理出现故障时立即切换
4. **手动切换**: 用户可以手动指定经理

**轮值算法**：
- 采用轮询（Round-Robin）策略
- 考虑经理的健康状态（`AgentHealth.availability`）
- 优先选择负载较低的经理

**轮值流程**：
1. 检查当前经理的健康状态和负载
2. 如果满足轮值条件，从经理池中选择下一个可用经理
3. 更新状态层中的 `managerId`
4. 在黑板播报"经理已切换为 XXX"

### 7.4 协助请求优先级

**优先级定义**：
- `critical`: 任务阻塞，必须立即协助
- `high`: 任务进展缓慢，需要尽快协助
- `normal`: 常规协助请求
- `low`: 可选的协助请求

**优先级判断**：
- 根据任务优先级和当前状态自动判断
- 用户可以手动调整协助请求的优先级

**协助请求处理**：
- 按优先级排序处理
- 同一优先级按时间顺序处理
- 超时未处理的协助请求自动升级优先级

**协助超时**：
- `critical`: 5 分钟
- `high`: 15 分钟
- `normal`: 30 分钟
- `low`: 60 分钟

### 7.5 敏感关键字分类

**分类定义**：

| 分类 | 风险等级 | 示例 | 处理方式 |
|------|---------|------|---------|
| 文件删除 | 高 | `rm`, `remove`, `del` | 必须确认 |
| 数据修改 | 高 | `truncate`, `drop`, `update` | 必须确认 |
| 版本控制 | 中 | `git reset`, `rebase`, `force push` | 必须确认 |
| 系统操作 | 高 | `shutdown`, `reboot`, `kill` | 必须确认 |
| 网络操作 | 中 | `curl`, `wget`, `ssh` | 可选确认 |
| 文件写入 | 低 | `write`, `create`, `mkdir` | 记录日志 |

**用户自定义**：
- 用户可以添加自定义敏感关键字
- 用户可以调整关键字的风险等级
- 用户可以禁用某些默认关键字（需要二次确认）

**匹配规则**：
- 精确匹配：完整命令匹配
- 模糊匹配：命令中包含关键字
- 上下文匹配：结合任务上下文判断风险

### 7.6 上下文共享范围

**共享范围定义**：

1. **任务内共享**: 同一任务的所有 Agent 共享上下文
2. **会话内共享**: 同一会话的所有任务共享上下文（可选）
3. **跨会话共享**: 不同会话之间不共享上下文（默认）

**上下文内容**：
- 任务描述和目标
- 已执行的操作和结果
- 用户反馈和补充信息
- 相关文件和代码片段
- 协助记录和总结

**上下文大小限制**：
- 单个任务上下文：最大 100KB
- 会话上下文：最大 1MB
- 超过限制时自动压缩或归档

**ACE 集成**：
- `contextRefs` 指向 ACE 中的索引
- ACE 负责上下文的存储、检索和压缩
- 支持语义搜索和相似度匹配

### 7.7 错误处理流程

**错误分类**：

1. **工具执行错误**: 命令执行失败、超时、权限不足
2. **模型调用错误**: API 调用失败、超时、配额不足
3. **网络错误**: 连接失败、超时、DNS 解析失败
4. **系统错误**: 内存不足、磁盘满、进程崩溃

**错误处理策略**：

| 错误类型 | 处理策略 | 重试次数 | 降级方案 |
|---------|---------|---------|---------|
| 工具执行错误 | 重试 | 3 | 标记任务失败 |
| 模型调用错误 | 重试 + 切换模型 | 3 | 切换到备用模型 |
| 网络错误 | 重试 + 指数退避 | 5 | 标记任务阻塞 |
| 系统错误 | 记录日志 + 告警 | 0 | 暂停调度 |

**错误恢复**：
- 自动重试：根据错误类型自动重试
- 降级处理：切换到备用方案
- 人工介入：无法自动恢复时通知用户

### 7.8 性能指标

**关键指标**：

1. **任务完成时间**: 从创建到完成的总时间
2. **任务等待时间**: 从创建到开始执行的时间
3. **任务执行时间**: 实际执行的时间
4. **模型响应时间**: 模型调用的平均响应时间
5. **工具执行时间**: 工具调用的平均执行时间
6. **系统吞吐量**: 单位时间内完成的任务数
7. **错误率**: 任务失败的比例
8. **协助请求率**: 需要协助的任务比例

**性能目标**：
- 任务完成时间: < 5 分钟（简单任务）
- 任务等待时间: < 30 秒
- 模型响应时间: < 3 秒
- 工具执行时间: < 10 秒
- 系统吞吐量: > 10 任务/分钟
- 错误率: < 5%
- 协助请求率: < 20%

**监控和告警**：
- 实时监控所有关键指标
- 超过阈值时自动告警
- 定期生成性能报告

---

## 8. 实现优先级

### 第一阶段（核心功能）- 预计 3-4 周

**必须实现**：
1. 状态编排层（StateStore）
   - 数据模型定义
   - 事件机制
   - 查询和订阅 API
2. 协助机制（AssistService）
   - 协助请求和响应
   - 协助链路追踪
3. 任务状态机
   - 状态转移逻辑
   - 状态持久化

### 第二阶段（完善功能）- 预计 2-3 周

**应该实现**：
1. 调度评分算法
   - 完整的评分公式
   - 评分参数调优
2. 敏感关键字检测
   - 关键字分类和匹配
   - 用户确认流程
3. 故障降级流程
   - 自动降级
   - 经理池轮值
4. UI 协助展示
   - 黑板协助通知
   - 任务面板协助状态

### 第三阶段（优化功能）- 预计 2-3 周

**可以实现**：
1. ACE 集成
   - 上下文索引
   - 语义搜索
2. 用户反馈机制
   - 反馈收集
   - 反馈处理
3. 性能监控
   - 指标收集
   - 告警机制
4. 错误处理优化
   - 自动重试
   - 降级策略

---

## 9. 当前实现状态

### 已实现 ✅

- 基础架构分层（Core/Domain/Application/Infrastructure/Presentation）
- Agent 管理（AgentService）
- 任务管理（TaskService）
- 消息和通知（MessageService, NotificationService）
- 工具执行（ToolExecutionService）
- MCP 集成（MCPService, MCPServerService）
- LLM 客户端（Claude, OpenAI, GLM, Gemini）
- 黑板 UI（MinimalPanel）
- 事件系统（TypedEventEmitter）

### 待移除 🗑️

- 投票治理（VoteService）- 新设计中由调度经理池负责决策，不需要投票机制

**为什么移除投票机制**：
1. **决策效率**：投票需要等待多个 Agent 响应，增加延迟；经理池可以快速决策
2. **职责清晰**：经理负责决策，成员负责执行，职责更清晰
3. **降低复杂度**：投票需要处理超时、弃权、平局等复杂情况
4. **成本优化**：投票需要多次 LLM 调用，成本较高
5. **协助替代**：需要多方意见时，可以通过协助机制实现

### 部分实现 ⚠️

- Agent 调度（AgentEngine）- 缺少完整的评分算法
- 场景识别 - 缺少与 ACE 的集成
- 工具安全控制 - 缺少敏感关键字检测
- 故障降级 - 缺少自动降级机制

### 未实现 ❌

- 状态编排层（StateStore）
- 协助机制（AssistService）
- 调度经理池（SchedulerService）
- 敏感关键字管理（KeywordPolicyService）
- 上下文共享（ContextStore）
- ACE 集成
- 用户反馈机制
- 性能监控和告警
