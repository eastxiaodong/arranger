# 多 LLM 团队协作系统方案

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
- **落地方式**：可基于现有事件总线实现 `StateStore` 模块；旧 Workflow 仅作迁移期间的数据源，所有新功能禁止直接依赖 Workflow。

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

## 4. UI 概览
1. **群聊黑板**：展示用户消息、调度播报、协助通知、工具执行摘要、任务完成总结，支持 @ 与引用，并承载敏感关键字确认弹窗。
2. **工作台（Agent 思考窗）**：单个 LLM 的对话流，显示思考、协作、工具调用。可在同窗口查看协助请求与上下文。
3. **任务面板**：自动生成任务卡片（标题/负责人/状态/协助/最近摘要），支持筛选、排序，不提供手动编辑入口。
4. **配置中心**：管理 LLM 成员、调度经理池、敏感关键字，以及 MCP/工具状态与默认策略。

> **技术架构与上下文参考**：
> - 预留 ACE（Advanced Context Engine）集成入口，具体实现参见 `vscode-arranger/ACE集成参考.md`，后续可将 ACE 作为统一索引/缓存工具。
> - UI 继续采用 `html + ts` 分离（参考 `vscode-extension/src/webview/minimal-panel.html`），沿用现有样式与消息通道。

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
