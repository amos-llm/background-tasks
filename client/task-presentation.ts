import { isActiveTask, type ManagedTask } from "../shared/managed";

export type TaskTab = "running" | "ended";
export function taskTab(task: ManagedTask): TaskTab { return isActiveTask(task) ? "running" : "ended"; }
export function defaultTaskTab(tasks: ManagedTask[], selectedId: string | null): TaskTab {
  const selected = tasks.find(task => task.id === selectedId);
  return selected ? taskTab(selected) : tasks.some(isActiveTask) || tasks.length === 0 ? "running" : "ended";
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
