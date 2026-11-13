# Paseo 后台任务插件

Codex / Pi 会话输入框上方显示 `后台任务 · N`。点击展开命令、目录、PID 和耗时；每项可直接终止整个命令进程组。每 2 秒自动刷新，支持手动刷新和错误提示。

```sh
paseo plugin install git:amos-llm/background-tasks
```

本地开发与验证：

```sh
git clone git@github.com:amos-llm/background-tasks.git
cd background-tasks
npm ci --ignore-scripts
npm run typecheck
npm test
paseo plugin install "$PWD"
```

本地源码修改后：`paseo plugin reload background-tasks`。卸载：`paseo plugin remove background-tasks`。

首次使用 Paseo 插件时，需要在 `~/.paseo/config.json` 顶层设置 `"pluginsEnabled": true`，再执行 `paseo reload`。

需要 Paseo >= 0.15.4 和 Linux daemon，客户端使用 Paseo SDK 的原生 composer pill / popover。

读取 `/proc` 的进程环境、命令行、工作目录和启动时间，按 `PASEO_AGENT_ID` 分组；Codex 同时校验 `CODEX_THREAD_ID` / `CODEX_TOOL_CALL_ID`。Pi 识别其 RPC 运行时直接启动的独立命令进程组，兼容 bash 与 pi-background。命令中的 shell 包装进程与子进程显示为一个任务。

界面也显示尚未返回的前台长命令。独立 daemon、清除会话环境变量或另行创建进程组的后代进程不保证可追踪。当前版本不展示已完成任务或输出日志。

终止接口只接受服务器刚签发的任务 token，重新校验 agent、thread、进程启动时间和进程组归属后发 SIGTERM；3 秒后仍存活的原始组成员通过身份检查才升级为 SIGKILL。不调用 agent 的取消接口，因此可单独结束某条命令。
