import type { ManagedTask } from "../shared/managed";

export const stateLabels: Record<ManagedTask["state"], string> = {
  starting: "启动中", running: "运行中", completed: "已完成", failed: "失败", stopped: "已终止",
  timed_out: "超时", log_limit: "日志达到上限", error: "任务错误", unknown: "状态未知",
};
export function taskTone(state: ManagedTask["state"]) {
  if (state === "completed") return "statusSuccess";
  if (["failed", "timed_out", "log_limit", "error"].includes(state)) return "statusDanger";
  if (state === "unknown") return "statusWarning";
  if (state === "running" || state === "starting") return "accent";
  return "foregroundMuted";
}
export function taskPillPresentation(tasks: readonly Pick<ManagedTask, "state">[], stale = false) {
  const counts: Record<ManagedTask["state"], number> = {
    starting: 0, running: 0, completed: 0, failed: 0, stopped: 0,
    timed_out: 0, log_limit: 0, error: 0, unknown: 0,
  };
  for (const task of tasks) counts[task.state]++;
  const parts = ["后台任务", `运行中 ${counts.starting + counts.running}`, `已完成 ${counts.completed}`];
  const failed = counts.failed + counts.timed_out + counts.log_limit + counts.error;
  if (failed) parts.push(`失败 ${failed}`);
  if (counts.stopped) parts.push(`已终止 ${counts.stopped}`);
  if (counts.unknown) parts.push(`状态未知 ${counts.unknown}`);
  if (stale) parts.push("更新失败");
  return {
    label: `${counts.starting + counts.running}/${counts.completed}`,
    summary: parts.slice(1).join(" · "),
    icon: "Terminal" as const,
  };
}
export function taskTitle(task: Pick<ManagedTask, "label" | "command">) {
  if (task.label?.trim()) return task.label.trim();
  const command = task.command.trim();
  const script = command.match(/(?:^|&&\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/)?.[1];
  if (script) {
    if (/^(test|check:test)(:|$)/.test(script)) return "运行测试";
    if (/^(typecheck|type-check|check:types)(:|$)/.test(script)) return "类型检查";
    if (/^build(:|$)/.test(script)) return "构建项目";
    if (/^(dev|start|serve)(:|$)/.test(script)) return "开发服务";
    if (/^(install|ci|add)$/.test(script)) return "安装依赖";
    if (/^lint(:|$)/.test(script)) return "检查代码";
    return `运行 ${script}`;
  }
  if (/^(?:pytest|python[\d.]*\s+-m\s+pytest|cargo\s+test|go\s+test)\b/.test(command)) return "运行测试";
  return "后台命令";
}
// Log polling and the task directory have independent refresh intervals. Never let an
// older running snapshot hide a completed task, including while log following is paused.
export function latestTask(directory: ManagedTask, log?: ManagedTask): ManagedTask {
  if (!log || directory.endedAt !== null) return directory;
  if (log.endedAt !== null) return log;
  if (directory.state === "unknown") return directory;
  if (log.state === "unknown") return log;
  if (directory.state === "starting" && log.state === "running") return log;
  if (log.state === "starting" && directory.state === "running") return directory;
  return log.logBytes > directory.logBytes ? log : directory;
}
export function elapsedTime(task: ManagedTask) {
  const seconds = Math.max(0, Math.floor(((task.endedAt ?? Date.now()) - task.createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}
