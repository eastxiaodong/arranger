# Arranger VSCode Extension

Arranger VSCode 插件 - 多 Agent 协作编排系统的 VSCode 集成。

## 功能

- ✅ **Agent 执行环境** - 在 VSCode 中运行 Agent
- ✅ **完整 UI** - 嵌入式 React WebView UI
- ✅ **实时通信** - 与后端的 WebSocket 连接
- ✅ **主题适配** - 自动跟随 VSCode 主题
- ✅ **文件操作** - 使用 VSCode API 操作文件
- ✅ **代码编辑** - 精确的代码编辑能力
- ✅ **终端集成** - 执行命令和运行测试

## 安装

### 从 Marketplace 安装

在 VSCode 中搜索 "Arranger" 并安装。

### 本地开发

```bash
npm install
npm run dev
```

按 `F5` 启动调试模式。

## 配置

打开 VSCode 设置（`Cmd+,` 或 `Ctrl+,`），搜索 "Arranger"：

### 后端配置

- **Backend URL** - 后端服务地址（默认：`http://localhost:3001`）

### LLM 配置

- **Provider** - LLM 提供商（Claude/OpenAI/Ollama）
- **API Key** - API 密钥
- **Model** - 模型名称

### Agent 配置

- **Agent ID** - Agent 唯一标识（留空自动生成）
- **Role** - Agent 角色（admin/developer/reviewer/tester/security/documenter）
- **Display Name** - 显示名称

## 使用

### 1. 启动后端服务

```bash
arranger start
```

### 2. 打开 Arranger 面板

- 点击侧边栏的 Arranger 图标
- 或使用命令：`Arranger: Open Panel`

### 3. 配置 Agent

在设置中配置 LLM 和 Agent 信息。

### 4. 开始协作

- 创建任务
- 发送黑板消息
- 查看其他 Agent 的工作
- 参与投票和审批

## 开发

### 目录结构

```
vscode-extension/
├── src/                  # Extension 代码
│   ├── extension.ts      # 入口文件
│   ├── agent/            # Agent 执行引擎
│   ├── api/              # API 客户端
│   ├── ui/               # WebView Provider
│   ├── tools/            # 工具实现
│   └── types/            # 类型定义
├── webview/              # React UI
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   └── panels/
│   └── index.html
└── package.json
```

### 运行测试

```bash
npm test
```

### 打包

```bash
npm run package
```

## 许可证

MIT

