# Agent 工作台升级方案（单聊模式 + 黑板群聊 + MCP + ACE）

本文档描述即将落地的 Agent 工作台改造方案，用于指导后续开发与验收。目标是让工作台具备 Cline/Roo 式的单聊体验，同时继续支持黑板（群聊协作）、MCP 工具调用及 ACE 上下文检索。

## 1. 目标与原则
- 工作台 = 单聊：左侧选中 Agent，右侧单列时间线；输入框默认直聊该 Agent，无需 @/引用/回复。
- 黑板 = 群聊：@/引用/回复等协作能力保留；黑板中 @ 该 Agent 的消息同步到工作台时间线，标记为“外部/黑板”来源。
- 数据单源：复用现有状态池（messages/thinking_logs/tool_runs/llm_stream_states/ace_state），按 session+agent 过滤，不新增后台接口。
- 事件驱动：依赖既有事件（messages_update/messages_data/blackboard_message、llm_stream_update、thinking_logs_update、tool_runs_update、ace_state_update），无额外轮询。
- 简洁：工作台时间线不再渲染引用/回复块，消息被新消息打断也不需要线程结构。
- Scope：对标 Kilo/Roo/Cline 的“简版对话窗”体验，核心只做单聊时间线 + MCP/ACE 调用/回显，暂不铺开高级编排/多窗等复杂能力。

## 2. 数据过滤与来源
- 过滤条件：`session_id === currentSessionId` 且 (`agent_id === selectedAgentId` 或 `mentions` 包含 selectedAgentId)。
- 消息来源：
  - 工作台输入：用户直聊当前 Agent。
  - 黑板 @：群聊中 @ 当前 Agent 的指令/消息，作为外部指令节点。
  - Agent 回复：包含流式（llm_stream_update）。
  - 系统/编排：scheduler/sentinel/system_event 中提及该 Agent 的提示，弱化 badge。
- 思考（thinking_logs）：过滤当前会话+Agent。
- 工具（tool_runs/MCP）：过滤当前会话+Agent，包含运行/成功/失败状态。
- ACE：全局 ACE 配置/状态；工作台触发的检索结果以节点形式插入时间线。

## 3. 时间线设计（单列）
按时间升序滚动展示以下节点：
- 用户消息：来自工作台输入；pending→最终。
- 外部指令：黑板 @ Agent 的消息，标记“外部/黑板”。
- Agent 回复：含流式输入中…状态，done/error 后落地。
- 思考节点：thinking log，类型 badge（thought/tool/file/feedback），可折叠展开全文。
- 工具节点：工具调用/MCP 运行（running/succeeded/failed），展示工具名、参数摘要、输出/错误摘要、耗时。
- ACE 节点：ACE 搜索请求/结果（query、topK、score、链接），失败时显示错误。
- 系统/编排：scheduler/sentinel/system_event，弱化样式。
- 新消息提示：与黑板一致的“有新消息”按钮，基于 isAtBottom。

## 4. 输入与发送
- 底部固定输入框（每个 Agent 独立状态），无 @/引用/回复 UI。
- 发送逻辑：校验 `currentSessionId` + `selectedAgentId`；调用 `send_message`，payload 示例：
  ```json
  { "content": "...", "session_id": "<current>", "mentions": ["<selectedAgentId>"] }
  ```
  （如果后端支持 `target_agent_id` 可替换 mentions）
- 本地插入 pending 气泡；事件返回覆盖。
- 切换 Agent 时：清理 pending/typing、本地输入状态。

## 5. MCP 调用
- 触发：显式按钮或文本触发（如“运行工具”弹窗）；可选与思考节点联动。
- 前端请求：`run_mcp_tool` 携带 `server_id`, `tool`, `args`, `session_id`, `agent_id: selectedAgentId`。
- 展示：时间线插入“运行中”节点，随后更新为成功/失败，展示参数/输出摘要、耗时、复制/查看按钮。
- 后端要求：在 handler 中补足 agent_id 归属，推送 `tool_runs_update`，可选把结果转成一条消息广播。

## 6. ACE 集成
- 配置：沿用全局 ACE 配置/状态提示（未配置/连接失败）。
- 入口：
  - 输入命令 `/ace <query>` 或按钮“从 ACE 搜索上下文”。
  - 可选参数：topK/filter。
- 行为：触发 `ace_search`，结果以节点展示摘要/链接；错误节点提示失败原因。
- 可选：支持“一键插入到消息”，把 ACE 摘要拼入发送框。

## 7. UI 结构（概要）
- Header：Agent 名/ID，状态点（online/busy/offline/disabled），最近心跳，成功率/响应耗时（若有 metrics），“刷新”按钮。
- Body：时间线容器（单列）。
- Footer：输入框 + 发送按钮；可有“ACE 搜索”“运行工具”快捷按钮。
- 空态：未选会话/未选 Agent/无消息的提示文案。

## 8. 落地步骤（迭代）
1) 搭建工作台时间线容器+输入框，渲染过滤后的消息（无引用/回复），接入流式状态。
2) 合入思考节点、工具节点（含 MCP 运行中→结果），统一队列渲染。
3) 接入 ACE：触发入口 + 结果/错误节点。
4) 切换/滚动细节：新消息提示、切 Agent/会话清理状态。
5) 验证与调优：性能（截断长度）、空态、错误提示；联调后端 agent_id 归属的 MCP/ACE。

## 9. 验收要点
- 单聊体验：无需 @/引用/回复，输入即发；切换 Agent 独立状态。
- 时间线完整：用户/Agent/外部/思考/工具/ACE/系统均可见，顺序正确。
- 流式正常：llm_stream_update 显示 typing，done/error 收敛。
- MCP/ACE：可触发、可看到状态/结果/错误。
- 黑板同步：黑板 @ Agent 的消息能出现在工作台并带来源标记。

## 10. 后续可选优化
- 工具/思考节点折叠层级与过滤。
- ACE 结果智能选段插入。
- 本地草稿/多行输入 UX。
- 快捷命令（/ace, /tool, /help）解析。

```
