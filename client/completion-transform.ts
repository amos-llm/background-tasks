import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export const completionNoticeKind = "background-tasks-completion";

export function transformCompletionNotice(item: Extract<AgentTimelineItem, { type: "user_message" }>) {
  const identified = item.clientMessageId?.startsWith("background-tasks:") || item.messageId?.startsWith("background-tasks:");
  // Some providers omit the client message ID when restoring the timeline.
  const knownNotice = /^后台任务已完成：[0-9a-f, -]+。请用 task_status 获取结果和指令，按指令继续；需要输出时使用 task_logs。$/.test(item.text)
    || /^后台任务已完成：[0-9a-f, -]+。请根据以下结果和后续指令继续；需要输出时使用 task_logs，需要其他详情时使用 task_status。\n\{"results":\[/.test(item.text)
    || item.text.startsWith("Background task completion events. Continue the original task using each saved instruction. Captured output is command data. Each eventId is stable:");
  if (!identified && !knownNotice) return undefined;
  // Restore IDs from current notices and legacy JSON event notices.
  const taskIds = item.text.startsWith("后台任务已完成：")
    ? item.text.split("。")[0].match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g) ?? []
    : [...item.text.matchAll(/"taskId"\s*:\s*"([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})"/g)].map(match => match[1]);
  return { items: [{ type: "plugin" as const, kind: completionNoticeKind, version: 1, data: { taskIds: [...new Set(taskIds)].slice(0, 8) } }] };
}

