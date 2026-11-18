# Paseo 后台任务插件

为 Codex / Pi 提供统一的后台任务工具、完整日志存储和实时日志面板。agent 默认只读取最后几行，你可以查看同一任务保存的全部输出。也继续发现、显示和终止通过其他 shell 工具启动的进程。

需要 Paseo >= 0.15.4 和 Linux daemon。Pi 需要可用的内置 MCP 或 `pi-mcp-adapter`，用来接收 Paseo 注入的工具。

```sh
paseo plugin install git:amos-llm/background-tasks
```

首次使用 Paseo 插件时，在 `~/.paseo/config.json` 顶层设置 `"pluginsEnabled": true`，再执行 `paseo reload`。

## 使用

让 agent 使用 `task_start` 启动长命令，例如“用 task_start 启动 npm run dev”。工具在会话打开时由 Paseo 注入，不需要单独部署 MCP 服务。安装或重载插件后，在会话空闲时发送下一条消息以使工具生效。

| 工具 | 参数和行为 |
| --- | --- |
| `task_start` | `command`、可选 `cwd` / `timeoutSeconds`；后台执行原始命令，返回任务 ID、状态及最后 20 行 |
| `task_status` | `taskId`；读取任务状态、时间、退出码和信号 |
| `task_logs` | `taskId`、`tailLines`（默认 20）、可选 `filter` / `before`；读取保存日志的末尾或更早页面 |
| `task_stop` | `taskId`；终止命令进程组，保留日志 |
| `task_list` | 可选 `offset` / `limit`；列出当前 agent 的运行中及历史受管任务 |

传给 `task_start` 的命令应保持前台运行，不要自行追加 `&` 或仅为减少 agent 输出而添加 `| tail` / `| grep`。输出筛选交给 `task_logs`：`filter` 是区分大小写的字面文本，只影响读取结果，原始日志不会改变。每次查询最多搜索一个 64 KiB 日志页面；返回 `before`、`hasEarlier` 和扫描范围，继续传入 `before` 可搜索更早内容。返回给模型的日志文本最多 16 KiB。

有运行中任务时，输入框上方显示 `后台任务 · N`。点击查看命令、状态并终止任务；受管任务可点击“日志”。“后台任务与日志”会话面板和命令中心的“后台任务与历史日志”入口在没有运行中任务时也能打开。

面板区分运行中和已结束任务。日志每 500ms 增量刷新，支持历史分页、跟随滚动、暂停跟随、复制已加载内容和复制主机上的原始日志路径。应用进入后台时暂停日志轮询。显示窗口最多 2 MiB，加载更早内容时暂停跟随；显示裁剪不会删除磁盘日志。显示层处理 ANSI 颜色/标题序列和 `\r` 进度行，磁盘文件保留原始字节。

当前 SDK 没有通用的跨平台文件保存接口，因此这里提供原始文件路径，供在 daemon 主机上导出；没有浏览器专属下载按钮。结束的任务可在面板中确认删除记录和日志。

## 执行和日志边界

受管命令通过 `/bin/bash -c` 在 **daemon 主机上以插件进程的用户权限**执行，使用 daemon 环境及指定工作目录，stdin 关闭。不会读取交互式/login shell 配置，不自动继承 Codex 内置 shell 的沙箱或审批设置；工具遵循 Paseo 的工具启用门禁。安装插件意味着同时信任该执行能力。

每个任务由独立 Node runner 启动，拥有独立命令进程组。runner 将 stdout/stderr 收到的原始数据合并写入私有日志文件，磁盘写入有背压，agent 是否读取不影响采集。插件/客户端退出或插件重载后，runner 继续工作，状态和退出码写入磁盘供重连后恢复。不依赖 npm 安装目录或旧的插件 bundle。**主机重启后不会重新执行命令**；runner 异常退出时明确显示“状态未知”和采集可能中断，不猜测退出码。

“完整日志”指 runner 收到的 stdout/stderr 内容，受下述容量和保留期限限制。程序不打印、缓冲输出、重定向到其他文件、原命令自身做了过滤时，插件无法恢复未收到的内容。stderr 和 stdout 按 runner 接收顺序合并，不保证重建程序内部跨流写入的精确顺序。该功能用于文本日志，不提供 PTY、交互输入或完整终端仿真。

终止及超时先发 SIGTERM，3 秒后对身份仍匹配的进程组升级为 SIGKILL。命令 shell 退出但同组子进程仍运行时，任务继续保持运行中。自行清除任务标识、改变身份、脱离进程组的子进程不保证可安全终止。

原来的 `/proc` 扫描继续支持 Codex / Pi 内置 bash 和 pi-background 等外部任务。扫描按 `PASEO_AGENT_ID` 隔离进程；Codex 校验 thread 和 tool-call，Pi 识别 runtime 直接启动的命令组。外部任务仅提供进程信息和安全终止，无法事后补回完整日志或退出码。受管任务单独登记，不受 Pi 父进程识别规则影响。使用受管工具后，可以停用 Pi 原来的 background 插件；旧任务不会自动转为受管任务。

## 存储和配额

默认数据目录为 `$PASEO_HOME/background-tasks`；未设置 `PASEO_HOME` 时使用 `~/.paseo/background-tasks`。按 agent ID 的 SHA-256 和随机任务 ID 分目录，目录权限 0700，日志/元数据权限 0600。不会把执行环境变量写入元数据。任务访问和终止均检查归属，日志 RPC 不接受任意文件路径。

下列环境变量配置在 **启动 daemon 的环境中**；修改后重启 daemon。已启动 runner 保持其启动时的日志上限和超时配置。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `BACKGROUND_TASKS_DATA_DIR` | 见上文 | 持久化数据目录，重载后必须保持一致 |
| `BACKGROUND_TASKS_MAX_LOG_BYTES` | `104857600`（100 MiB） | 单个任务的日志上限 |
| `BACKGROUND_TASKS_TOTAL_LOG_BYTES` | `1073741824`（1 GiB） | 日志总预算；启动任务时预留该任务的完整额度 |
| `BACKGROUND_TASKS_MAX_CONCURRENT` | `8` | 当前主机最多同时运行的受管任务数 |
| `BACKGROUND_TASKS_RETENTION_DAYS` | `7` | 已结束任务及日志保留天数 |

到达单任务上限后，额外输出会触发停止任务，并明确标记 `log_limit` / `logTruncated`；不会悄悄丢掉前面的日志后仍声称完整。日志写入失败也会停止任务并记录错误。总预算不足时拒绝新任务；可在面板删除已结束日志释放空间。预算针对日志数据，不包含元数据和文件系统开销。已结束记录每分钟清理；运行中任务不按期限删除。状态未知的记录保留供排查；确认无存活进程后可以手动删除。

## 本地开发

```sh
git clone git@github.com:amos-llm/background-tasks.git
cd background-tasks
npm ci --ignore-scripts
npm run typecheck
npm test
paseo plugin install "$PWD"
```

本地源码修改后：`paseo plugin reload background-tasks`。卸载：`paseo plugin remove background-tasks`。

重载或卸载插件不会自动终止独立 runner，也不会删除持久化日志。卸载前按需停止受管任务，数据目录可在确认没有存活任务后手动清理。

测试覆盖完整输出与模型摘要分离、UTF-8 游标、启动进程退出后的独立运行、TERM-resistant 子进程、超时、日志上限、并发配额、保留期、runner 异常恢复、会话隔离和 Pi/Codex 共用工具回调。实际 provider 的工具展示及移动端界面仍需在对应 Paseo 客户端联调。
