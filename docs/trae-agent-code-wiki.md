# Trae Agent Code Wiki

> 本文已按要求重写为基于 `bytedance/trae-agent` 公开仓库的真实代码分析，而不是本地 `jev-ultrafast`。分析时实际抓取并检查了公开仓库内容，工作副本位于 `/tmp/bytedance-trae-agent`。

## 1. 项目定位

`Trae Agent` 是一个面向通用软件工程任务的 LLM CLI Agent。它的目标不是只回答问题，而是在代码仓库中执行完整的软件工程流程，包括：

- 理解 issue 或自然语言任务
- 浏览代码、定位相关文件
- 调用工具修改代码
- 执行命令与测试
- 记录完整 trajectory
- 在满足完成条件后结束任务

从 README、代码和测试可见，这个项目的核心特征是：

- Python 3.12+ 实现
- 以 CLI 为主要入口
- 多模型供应商适配层
- 可插拔工具系统
- 支持 MCP 工具发现
- 支持 Docker 隔离执行
- 支持 Lakeview 对 agent step 做摘要
- 自带 evaluation 目录，用于跑 SWE-bench / SWE-bench-Live / Multi-SWE-bench

## 2. 顶层目录结构

| 路径 | 作用 |
| --- | --- |
| `README.md` | 使用说明、配置、CLI 示例、Docker 模式说明 |
| `pyproject.toml` | 包元数据、依赖、测试配置、脚本入口 |
| `Makefile` | 安装、测试、pre-commit、格式化、清理命令 |
| `trae_agent/` | 核心实现 |
| `tests/` | CLI、agent、工具、配置与模型客户端测试 |
| `docs/` | tools、trajectory、roadmap、legacy config 等补充文档 |
| `evaluation/` | Benchmark 评测脚本与 patch selection 实验 |
| `server/` | 规划中的 HTTP server 说明，尚未完成 |

## 3. 高层架构

```text
CLI / Interactive Input
  -> Config.create() + resolve_config_values()
  -> Agent(agent_type="trae_agent")
     -> TrajectoryRecorder
     -> TraeAgent(BaseAgent)
        -> LLMClient(provider adapter)
        -> ToolExecutor / DockerToolExecutor
        -> optional MCP discovery
        -> step loop:
             LLM chat
             parse tool calls
             execute tools
             reflect on failures
             judge completion
        -> finalize trajectory / patch
  -> Console (simple / rich)
```

### 3.1 分层理解

- `trae_agent/cli.py`
  - 命令行入口、参数解析、配置读取、Agent 启动。

- `trae_agent/agent/`
  - Agent 抽象与具体实现。

- `trae_agent/tools/`
  - 工具基类、工具注册表、bash/edit/json/MCP/task_done 等。

- `trae_agent/utils/llm_clients/`
  - 不同模型供应商的适配层。

- `trae_agent/utils/cli/`
  - simple console 与 rich/textual TUI。

- `trae_agent/utils/`
  - 配置、trajectory recorder、Lakeview、MCP client 等横切能力。

- `evaluation/`
  - 面向 benchmark 的离线评测体系。

### 3.2 运行主链路

1. 用户通过 `trae-cli run` 或 `trae-cli interactive` 提供任务。
2. `Config.create()` 解析 YAML 或 legacy JSON 配置。
3. `Agent` 外层包装器创建 `TraeAgent`、`TrajectoryRecorder` 和 Console。
4. `TraeAgent.new_task()` 生成 system/user 初始消息，并装配默认工具。
5. `BaseAgent.execute_task()` 进入 step loop。
6. 每一步调用 `LLMClient.chat(...)` 获取模型回复。
7. 若模型调用工具，则走 `ToolExecutor` 或 `DockerToolExecutor`。
8. 工具执行结果会被回灌为新的 `LLMMessage(role="user", tool_result=...)`。
9. 若模型调用 `task_done`，则由 `TraeAgent` 的完成判定逻辑确认是否真可结束。
10. 最终写出 trajectory，可选写出 patch diff。

## 4. 核心模块分析

### 4.1 `trae_agent/cli.py`

这是程序的实际主入口，`pyproject.toml` 中定义了：

```toml
[project.scripts]
trae-cli = "trae_agent.cli:main"
```

#### 关键函数

- `resolve_config_file(config_file)`
  - 处理 YAML 配置与 legacy JSON 配置兼容逻辑。

- `check_docker(timeout=3)`
  - 检查 docker CLI 和 daemon 是否可用。

- `build_with_pyinstaller()`
  - 在 Docker 模式下为编辑工具打包可执行文件，复制到 `trae_agent/dist`。

- `run(...)`
  - 主执行命令。
  - 负责：
    - 互斥处理 Docker 参数
    - 读取任务字符串或 `--file`
    - 读取并解析配置
    - 选择 console 类型
    - 创建 `Agent`
    - 组装 `task_args`
    - 调用 `asyncio.run(agent.run(...))`

- `interactive(...)`
  - 启动交互模式。
  - simple console 下用显式输入循环，rich console 下交给 Textual TUI。

- `show_config(...)`
  - 展示当前 provider / model / token 等配置。

- `tools()`
  - 动态列出 `tools_registry` 中的可用工具。

- `main()`
  - 顶层 CLI 入口。

#### CLI 支持的主要命令

- `trae-cli run "task"`
- `trae-cli interactive`
- `trae-cli show-config`
- `trae-cli tools`

#### CLI 的额外能力

- 指定工作目录
- 强制 patch 模式
- 指定 trajectory 输出路径
- Docker image / container / Dockerfile / image file 四种 Docker 启动方式
- `simple` / `rich` 两种 console

### 4.2 `trae_agent/agent/agent.py`

这个文件里的 `Agent` 不是模型 agent 本体，而是上层门面对象，主要职责是把配置、trajectory recorder、console 和具体 agent 类型组装起来。

#### `class Agent`

- `__init__(agent_type, config, trajectory_file=None, cli_console=None, docker_config=None, docker_keep=True)`
  - 根据 `agent_type` 选择具体实现，目前只支持 `trae_agent`。
  - 自动生成 trajectory 路径或使用指定路径。
  - 连接 console 与 trajectory recorder。

- `run(task, extra_args=None, tool_names=None)`
  - 调用 `self.agent.new_task(...)`
  - 如允许 MCP，则先初始化 MCP tools
  - 向 console 打印 task details
  - 执行 `self.agent.execute_task()`
  - 在 finally 中清理 MCP client

#### 设计意义

- 将“CLI 世界”和“具体 agent 执行逻辑”隔离。
- 未来若支持更多 agent 类型，这一层可以继续扩展。

### 4.3 `trae_agent/agent/base_agent.py`

这是整个执行引擎的核心。`TraeAgent` 继承它并覆盖少量策略方法。

#### `class BaseAgent`

#### 初始化逻辑

- 创建 `LLMClient(agent_config.model)`
- 初始化最大步数、初始消息、工具列表
- 若启用 Docker，则创建 `DockerManager` 与 `DockerToolExecutor`
- 否则直接使用 `ToolExecutor`
- 初始化 CLI console / trajectory recorder
- 启动前清理旧的 CKG 数据库

#### 关键方法

- `execute_task()`
  - 启动 Docker 环境
  - 创建 `AgentExecution`
  - 进入 step loop，直到完成、报错或超出步数
  - 每步调用 `_run_llm_step()` 和 `_finalize_step()`
  - 最后清理工具与 MCP client

- `_run_llm_step(step, messages, execution)`
  - 设置 step 为 `THINKING`
  - 调用 LLM
  - 更新 token usage
  - 判断任务是否已完成
  - 若未完成则进入工具调用处理

- `_tool_call_handler(tool_calls, step)`
  - 调用 `parallel_tool_call()` 或 `sequential_tool_call()`
  - 将工具结果包装成新的对话消息
  - 若存在失败结果，可触发 `reflect_on_result()`

- `_finalize_step(step, messages, execution)`
  - 记录 trajectory
  - 更新 CLI console
  - 将 step 追加到 execution

- `reflect_on_result(tool_results)`
  - 默认实现只汇总失败工具的错误，提示模型换方法或修正参数。

- `llm_indicates_task_completed(llm_response)`
  - 基类默认通过自然语言关键字判断完成。
  - `TraeAgent` 会覆盖为检查 `task_done` 工具。

#### 状态模型

来自 `agent_basics.py`：

- `AgentStepState`
  - `THINKING`
  - `CALLING_TOOL`
  - `REFLECTING`
  - `COMPLETED`
  - `ERROR`

- `AgentState`
  - `IDLE`
  - `RUNNING`
  - `COMPLETED`
  - `ERROR`

- `AgentStep`
  - 记录单步中的 LLM 响应、工具调用、工具结果、反思和错误。

- `AgentExecution`
  - 记录整次任务执行的所有 step、token、耗时与最终状态。

### 4.4 `trae_agent/agent/trae_agent.py`

这是 BaseAgent 的专用子类，承载 Trae Agent 的软件工程任务策略。

#### `class TraeAgent(BaseAgent)`

#### 专属状态

- `project_path`
- `base_commit`
- `must_patch`
- `patch_path`
- `mcp_servers_config`
- `allow_mcp_servers`
- `mcp_tools`
- `mcp_clients`
- `docker_config`

#### 关键方法

- `initialise_mcp()`
  - 异步发现 MCP tools，并追加到 `_tools`。

- `discover_mcp_tools()`
  - 遍历允许的 MCP server 配置，通过 `MCPClient` 连接并发现工具。

- `new_task(task, extra_args=None, tool_names=None)`
  - 组装 system + user 初始消息。
  - user message 会显式包含：
    - `[Project root path]`
    - `[Problem statement]`
  - 默认工具集为：
    - `str_replace_based_edit_tool`
    - `sequentialthinking`
    - `json_edit_tool`
    - `task_done`
    - `bash`

- `execute_task()`
  - 在基类执行后补充 trajectory finalization。
  - 若设置 `patch_path`，会把 git diff 写到指定文件。

- `get_system_prompt()`
  - 返回 `TRAE_AGENT_SYSTEM_PROMPT`。

- `get_git_diff()`
  - 读取当前仓库改动；如设置 `base_commit`，则对比 `base_commit..HEAD`。

- `remove_patches_to_tests(model_patch)`
  - 从 patch 中剔除测试目录相关修改，用于某些 patch 校验场景。

- `llm_indicates_task_completed(llm_response)`
  - 只认 `task_done` 工具调用，不再依赖自然语言“done”。

- `_is_task_completed(llm_response)`
  - 若 `must_patch == "true"`，则要求 git diff 经过测试目录过滤后非空。

- `task_incomplete_message()`
  - 在 patch 为空时返回强提示，要求模型给出真正 patch。

#### 设计特点

- 比基类更强调 patch 产出
- completion 判定更严格
- 把 MCP 作为可选扩展能力，而不是强绑定能力

## 5. Prompt 层

`trae_agent/prompt/agent_prompt.py` 中只有一个核心常量：

- `TRAE_AGENT_SYSTEM_PROMPT`

它要求模型按照接近“资深软件工程师”的方式工作，强调以下顺序：

1. 理解问题
2. 探索代码
3. 先复现 bug
4. 调试定位
5. 小而准地修复
6. 验证修复并补测试
7. 总结工作

这个 prompt 还明确：

- 所有文件路径必须是绝对路径
- 鼓励大量使用 `sequential_thinking`
- 确认任务完成后必须调用 `task_done`

因此，从架构上看，Trae Agent 不是“自由对话型” agent，而是“被 prompt 强约束的工程流程 agent”。

## 6. 工具系统

### 6.1 注册表

`trae_agent/tools/__init__.py` 中定义了 `tools_registry`：

- `bash`
- `str_replace_based_edit_tool`
- `json_edit_tool`
- `sequentialthinking`
- `task_done`
- `ckg`

### 6.2 通用基类

`trae_agent/tools/base.py` 提供：

- `Tool`
  - 抽象工具基类，定义 `name`、`description`、`parameters`、`execute()`

- `ToolParameter`
  - 描述单个参数的 schema

- `ToolCall`
  - 描述一次来自模型的工具调用

- `ToolResult`
  - 描述工具调用结果

- `ToolExecutor`
  - 负责按名称分派工具，支持串行或并行调用

#### 一个重要实现细节

`Tool.get_input_schema()` 会针对 OpenAI 模型修正 JSON schema：

- 所有参数加入 `required`
- 可选参数通过 `null` 联合类型表达
- 顶层和嵌套 object 都设置 `additionalProperties: false`

这说明项目在工具 schema 层就处理了不同供应商的兼容性。

### 6.3 代表性工具

#### `bash_tool.py`

- 内部通过 `_BashSession` 启动持久 bash 会话
- 采用 sentinel 标记提取退出码
- 支持 `restart`
- 默认 120 秒超时
- session 状态会在多次调用之间保留

#### `edit_tool.py`

`TextEditorTool` 提供四种操作：

- `view`
- `create`
- `str_replace`
- `insert`

关键约束：

- 路径必须是绝对路径
- `create` 不允许覆盖已有文件
- `str_replace` 必须唯一精确匹配
- `view` 支持行区间显示

#### `json_edit_tool.py`

`JSONEditTool` 提供：

- `view`
- `set`
- `add`
- `remove`

特点：

- 使用 `jsonpath-ng`
- 显式校验 JSONPath
- 强制绝对路径
- 支持 pretty print

#### `task_done_tool.py`

从 README 和完成逻辑可知，它本身是“完成信号”，真正的结束仍由 agent 额外验证，而不是只要模型说完成就结束。

#### `sequential_thinking_tool.py`

README / docs/tools.md 中将它定位为结构化推理工具，用来分步分析复杂问题、支持 revision / branch。

### 6.4 Docker 工具执行

`BaseAgent` 在 Docker 模式下不会直接复用普通执行器，而是切换到 `DockerToolExecutor`，并让 `DockerManager` 在容器中维护持久 shell 与工作目录映射。

这意味着 Trae Agent 的执行环境可切换为：

- 本机执行
- Docker 隔离执行

## 7. 配置系统

配置入口在 `trae_agent/utils/config.py`。

### 7.1 关键数据结构

- `ModelProvider`
  - `api_key`
  - `provider`
  - `base_url`
  - `api_version`

- `ModelConfig`
  - 模型名、provider、temperature、top_p、top_k
  - `parallel_tool_calls`
  - `max_retries`
  - `max_tokens`
  - `supports_tool_calling`
  - Google / Azure 相关扩展字段

- `MCPServerConfig`
  - 支持 stdio / SSE / HTTP / WebSocket 的配置结构
  - 但当前 `MCPClient` 实现只真正支持 stdio

- `TraeAgentConfig`
  - 继承 `AgentConfig`
  - 额外包含 `enable_lakeview`
  - 默认工具列表

- `LakeviewConfig`
  - 单独配置 Lakeview 所用模型

- `Config`
  - 总配置对象，持有 providers、models、lakeview、agents

### 7.2 配置优先级

README 与 `resolve_config_value()` 一致：

```text
CLI 参数 > 环境变量 > 配置文件 > 默认值
```

### 7.3 配置格式

- 推荐：YAML
- 兼容：legacy JSON

`Config.create()` 会：

1. 解析 YAML
2. 建立 model providers
3. 建立 models 并回填 provider
4. 解析 lakeview
5. 解析 MCP server 配置
6. 解析 agents 配置

若传入 JSON，则会走 `create_from_legacy_config()` 做兼容转换。

## 8. 多模型供应商层

`trae_agent/utils/llm_clients/llm_client.py` 是总入口，内部按 provider 分派：

- `openai`
- `anthropic`
- `azure`
- `ollama`
- `openrouter`
- `doubao`
- `google`

### 8.1 `LLMClient`

- 根据 `model_config.model_provider.provider` 选择具体 client
- 对外统一暴露：
  - `chat(...)`
  - `set_chat_history(...)`
  - `set_trajectory_recorder(...)`
  - `supports_tool_calling(...)`

### 8.2 `BaseLLMClient`

抽象基类，统一保存：

- `api_key`
- `base_url`
- `api_version`
- `trajectory_recorder`

这层设计让 Agent 主循环不需要知道每个供应商 SDK 的细节。

## 9. Console 与交互体验

`trae_agent/utils/cli/` 下有两套 console：

- `SimpleCLIConsole`
- `RichCLIConsole`

两者都继承自 `CLIConsole`，通过 `ConsoleFactory` 创建。

### 9.1 `CLIConsole`

定义统一接口：

- `start()`
- `update_status()`
- `print_task_details()`
- `print()`
- `get_task_input()`
- `get_working_dir_input()`
- `stop()`

同时也接入了 Lakeview。

### 9.2 `SimpleCLIConsole`

特点：

- 纯终端文本输出
- 实时打印 step 表格
- 最后打印 execution summary
- 若启用 Lakeview，会在后台生成 step 摘要后统一输出

### 9.3 `RichCLIConsole`

特点：

- 基于 `textual`
- 带 header / footer / 输入框 / token display / RichLog
- interactive 模式下可直接在 TUI 里提交任务

### 9.4 Lakeview

`utils/lake_view.py` 实现了对每个 agent step 的二次摘要：

- `extract_task_in_step()`
  - 用单独模型把 step 提炼成 `<task>` 与 `<details>`

- `extract_tag_in_step()`
  - 给 step 打标签，如：
    - `WRITE_TEST`
    - `VERIFY_TEST`
    - `EXAMINE_CODE`
    - `WRITE_FIX`
    - `VERIFY_FIX`
    - `REPORT`
    - `THINK`
    - `OUTLIER`

它本质上是一个“agent trajectory 的后处理摘要器”。

## 10. 轨迹记录

`utils/trajectory_recorder.py` 是另一个核心组件。

#### `class TrajectoryRecorder`

负责记录：

- 任务元信息
- 每次 LLM interaction
- 每个 agent step
- 工具调用与结果
- token 使用量
- 最终 success / final_result / execution_time

### 10.1 重要方法

- `start_recording(...)`
- `record_llm_interaction(...)`
- `record_agent_step(...)`
- `update_lakeview(...)`
- `finalize_recording(...)`
- `save_trajectory()`

默认输出路径为：

```text
trajectories/trajectory_YYYYMMDD_HHMMSS.json
```

## 11. Docker 与 MCP

### 11.1 Docker

`agent/docker_manager.py` 实现容器生命周期管理。

#### `class DockerManager`

支持四种来源：

- 现有 image
- 现有 container ID
- Dockerfile 构建
- 本地 tar 镜像导入

#### 关键行为

- 将宿主工作目录挂载到容器 `/workspace`
- 将打包后的工具复制进容器 `/agent_tools`
- 用 `pexpect` 在容器里维护持久 shell
- 支持命令执行、超时控制、容器清理

### 11.2 MCP

`utils/mcp_client.py` 当前实现的重点是 stdio transport。

#### `class MCPClient`

- `connect_and_discover(...)`
  - 连接 MCP server 并发现工具

- `connect_to_server(...)`
  - 初始化 `ClientSession`

- `call_tool(...)`
- `list_tools(...)`
- `cleanup(...)`

#### 当前边界

- `http_url` / `url` 分支仍 `NotImplementedError`
- 实际可用的是 `command + args` 的 stdio 模式

## 12. 关键类与函数索引

### Agent 层

| 符号 | 说明 |
| --- | --- |
| `Agent` | 顶层门面，组装 agent/console/trajectory |
| `BaseAgent` | 通用执行循环 |
| `TraeAgent` | Trae 专属策略实现 |
| `AgentExecution` | 一次任务执行记录 |
| `AgentStep` | 单步记录 |
| `AgentError` | agent 错误类型 |

### 工具层

| 符号 | 说明 |
| --- | --- |
| `Tool` | 工具抽象基类 |
| `ToolExecutor` | 工具执行器 |
| `BashTool` | 持久 bash 会话 |
| `TextEditorTool` | 文本文件查看/创建/替换/插入 |
| `JSONEditTool` | 基于 JSONPath 的结构化修改 |
| `SequentialThinkingTool` | 结构化思考 |
| `TaskDoneTool` | 完成信号 |
| `MCPTool` | MCP 动态发现工具包装 |

### 配置与平台层

| 符号 | 说明 |
| --- | --- |
| `Config` | 总配置对象 |
| `TraeAgentConfig` | agent 配置 |
| `ModelConfig` | 模型配置 |
| `ModelProvider` | provider 配置 |
| `TrajectoryRecorder` | 轨迹记录器 |
| `LLMClient` | 多供应商统一入口 |
| `DockerManager` | Docker 运行时管理 |
| `MCPClient` | MCP client |
| `LakeView` | step 摘要与标签生成 |

## 13. 依赖分析

根据 `pyproject.toml`，项目依赖可以分为几类。

### 13.1 LLM 与 API

- `openai`
- `anthropic`
- `google-genai`
- `ollama`
- `socksio`

### 13.2 CLI / UI / 配置

- `click`
- `rich`
- `textual`
- `python-dotenv`
- `pyyaml`
- `pydantic`

### 13.3 工具与编辑能力

- `jsonpath-ng`
- `tree-sitter`
- `tree-sitter-languages`
- `mcp`

### 13.4 打包与运行

- `pyinstaller`
- `ruff`

### 13.5 可选依赖

`test` extra：

- `pytest`
- `pytest-asyncio`
- `pytest-mock`
- `pytest-cov`
- `pre-commit`

`evaluation` extra：

- `datasets`
- `docker`
- `pexpect`
- `unidiff`

## 14. 测试、CI 与开发命令

### 14.1 本地开发命令

来自 `Makefile`：

```bash
make uv-venv
make uv-sync
make uv-test
make uv-pre-commit
make fix-format
```

其中：

- `uv-sync`
  - `uv sync --all-extras`

- `uv-test`
  - 会设置：
    - `SKIP_OLLAMA_TEST=true`
    - `SKIP_OPENROUTER_TEST=true`
    - `SKIP_GOOGLE_TEST=true`
  - 再执行 `uv run pytest tests/ -v --tb=short --continue-on-collection-errors`

### 14.2 CI 工作流

`.github/workflows/` 下有两个主要工作流：

- `pre-commit.yml`
  - 安装 uv
  - `make uv-sync`
  - `make uv-pre-commit`

- `unit-test.yml`
  - 安装 uv
  - `make uv-sync`
  - `make uv-test`

### 14.3 测试覆盖面

从 `tests/` 可见测试分层较清晰：

- `tests/test_cli.py`
  - 验证 `run` 命令的参数处理
  - 检查 `--file`、长 prompt、工作目录错误等行为

- `tests/agent/test_trae_agent.py`
  - 验证 `TraeAgent.new_task()`
  - patch 过滤
  - `must_patch` 完成逻辑
  - 工具初始化与属性访问

- `tests/tools/`
  - bash / edit / json_edit / MCP tool

- `tests/utils/`
  - config
  - google/openrouter/ollama client 工具函数
  - mcp client

## 15. Evaluation 子系统

`evaluation/README.md` 表明这个仓库不只是一个 CLI 工具，也带 benchmark 评测管线。

支持的 benchmark：

- SWE-bench
- SWE-bench-Live
- Multi-SWE-bench

### 15.1 评测流程

1. 准备 benchmark harness
2. 准备 Docker 环境
3. 运行 Trae Agent 产出 patch
4. 汇总预测结果
5. 用 harness 执行测试并给出 pass/fail

### 15.2 评测意义

这也解释了为什么 `TraeAgent` 有：

- `must_patch`
- `patch_path`
- `base_commit`
- `remove_patches_to_tests()`

这些能力明显是为了面向 benchmark patch 生成与验收。

## 16. 其他观察

### 16.1 `server/`

`server/Readme.md` 明确写明：

- HTTP server 仍在建设中
- 目标是 stateless、并发、安全 JSON 输出
- 当前不应在生产使用

所以公开仓库当前的成熟入口仍是 CLI，而不是 server。

### 16.2 `docs/tools.md`

这份文档和代码基本一致，但列出的 built-in tools 数量是“五个”；而代码注册表里实际上还能看到 `ckg`。因此写文档时应以代码注册表为准，把 `ckg` 视为存在但不是 README 主叙事中的核心默认工具。

## 17. 新读者推荐阅读顺序

如果是第一次接手 `bytedance/trae-agent`，建议按下面顺序阅读：

1. `README.md`
2. `pyproject.toml`
3. `trae_agent/cli.py`
4. `trae_agent/agent/agent.py`
5. `trae_agent/agent/base_agent.py`
6. `trae_agent/agent/trae_agent.py`
7. `trae_agent/tools/base.py`
8. `trae_agent/tools/bash_tool.py`
9. `trae_agent/tools/edit_tool.py`
10. `trae_agent/utils/config.py`
11. `trae_agent/utils/llm_clients/llm_client.py`
12. `trae_agent/utils/trajectory_recorder.py`
13. `tests/`
14. `evaluation/README.md`

这样可以先理解“入口 -> 执行循环 -> 工具 -> 配置 -> 观测/记录 -> 测试/评测”的完整路径。

## 18. 一句话总结

`bytedance/trae-agent` 的本质是一个以 Python 实现、面向软件工程问题求解的可扩展 CLI Agent 框架：它把配置、LLM 适配、工具调用、Docker/MCP 扩展、轨迹记录、交互界面和 benchmark evaluation 组合在一起，重点不在“单次回答”，而在“让模型按工程流程持续完成任务并留下可分析轨迹”。
