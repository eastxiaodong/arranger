# ACE 集成实施方案

> 目标：将 Ace-MCP 的代码索引与上下文搜索能力嵌入 Arranger VSCode 插件，分阶段落地，先确保“最小可用”，再逐步走向“完整集成”。

---

## 当前集成现状（2025.02）

- **阶段一（MVP）交付完成**：`AceContextService` 已直接托管索引/搜索/连通性测试；配置存入全局数据库，Webview 提供 Base URL/Token 表单、刷新索引、测试连接与搜索验证入口。
- **运行可观测性**：所有 ACE 操作通过 `ToolExecutionService` 记录为 `tool_runs`，同时写入 `StateStore` 的 `AceStateRecord`，Webview “运行概览 + 最近活动” 即时展示最新索引/搜索/测试结果、失败次数、关键指标。
- **自动维护**：扩展层实现 `setupAceAutoMonitor`，在启动/定期/工作区切换时自动评估索引是否过期，必要时后台刷新并通过 Notification 系统提示成功或连续失败，避免手动干预。
- **后续重点（阶段二起点）**：多项目/多工作区状态管理、Agent 自动引用 ACE 片段、索引健康指标与治理策略尚未落地，需要在“完整集成”阶段按业务需求迭代。

---

## 阶段一：最小可用（MVP）

### 1. 核心能力
- 在 Arranger 进程内直接引入 Ace 的 `IndexManager`/`searchContext` 核心逻辑（移除其 MCP Server/CLI/Web UI 依赖）。
- 新增 `AceContextService`（或扩展现有 `ContextService`），提供 `indexProject(projectPath)`、`searchContext({ projectPath, query })` 两个主要 API。
- 配置来源统一到 Arranger：全局数据库/setting 中新增 ACE 的 `base_url`、`token`、`include/exclude` 等字段。
- VSCode 设置页或 WebView 全局配置面板提供最基本的 ACE 配置 UI。

### 2. 系统集成点
- **服务初始化**：在 `createServices` 中实例化 `AceContextService`，并注入到需要上下文的模块（Agent、Task 工具、ContextService）。
- **Agent 调用**：为 Agent 提供新的工具/命令，例如在工具列表中增加 `ace.search_context`，由 orchestrator 自动调用。
- **UI 入口**：在 WebView 全局配置页加入一个 “ACE 设置” 区域（输入 base URL/token，测试连接按钮）。
- **日志反馈**：所有 ACE 操作通过 Arranger OutputChannel 输出，同时在出现错误时弹出通知。

### 3. 交付验收
- 能在 VSCode 中配置 ACE，并通过 Arranger 调用 `searchContext` 获取带路径/行号的上下文文本。
- 在日志或 UI 中可看到索引/搜索的执行结果；若失败能给出明确错误。

---

## 阶段二：完整集成

### 1. 深度融合
- **状态编排层**：将索引任务、缓存状态、搜索结果摘要写入状态层（Task/ToolLog 等），供多 Agent 协作引用。
- **UI 面板**：在 WebView 中增加 ACE 状态页，展示索引进度、最近搜索记录、缓存大小、失败重试等。
- **安全/权限**：结合 KeywordPolicy 或自定义策略，限制 ACE 对敏感目录的索引；支持工作区级别的白名单/黑名单。
- **自动触发**：在任务规划、Agent 切换场景中自动触发 ACE 索引更新，确保上下文最新；支持根据 Task 的 `contextRefs` 自动拉取 ACE 片段。
- **多项目支持**：允许一个工作区配置多个 ACE Project，对应不同路径/仓库，任务选择时可自动匹配。

### 2. 运维与监控
- **指标采集**：记录索引耗时、搜索命中率、失败率，纳入 PerformanceRecorder 或独立监控。
- **治理对接**：当 ACE 索引失败或过久未更新时，通过状态层/通知系统生成提示。
- **WebView 操作**：允许在 UI 上清理缓存、重建索引、查看详细日志。

### 3. 交付验收
- 任何 ACE 行为都能在 Arranger 的状态层中追踪，UI 具备完整的配置、监控与手动操作入口。
- Agent/任务在实际协作中能自动消费 ACE 提供的上下文，无需人工切换。

---

## 实施顺序建议
1. **MVP 开发**：移植 IndexManager + 新服务 + 基础配置 → 完成阶段一验收。
2. **系统验证**：在真实项目中用 Agent 调用 ACE，收集问题。
3. **逐步增强**：按阶段二路线图逐项补充 UI、状态层、监控、治理等能力。
4. **文档与自动化**：补充开发/运维文档、在 CI 中增加简单的打包检测（确保 ACE 依赖正确）。

通过“两阶段推进 + 迭代增强”的方式，可以快速让 ACE 能力进入 Arranger，并保证后续具备深度集成与可运维性。 
