import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { managedStateSchema, taskIdSchema } from "../shared/managed";

export const startNoticeKind = "background-tasks-started";
const startNames = new Set(["task_start", "paseo.task_start", "mcp__paseo__task_start", "mcp_paseo_task_start", "paseo_task_start"]);

// Codex preserves MCP structuredContent; Pi adapters may retain only JSON text.
// Follow known result envelopes, never UUIDs found in logs or command strings.
function startedTaskId(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return;
  if (typeof value === "string") {
    if (value.length > 262144) return;
    try { return startedTaskId(JSON.parse(value), depth + 1); } catch { return; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const result = value as Record<string, unknown>;
  if (result.isError === true) return;
  if (result.task && typeof result.task === "object" && !Array.isArray(result.task)) {
    const task = result.task as Record<string, unknown>;
    const id = taskIdSchema.safeParse(task.id);
    if (id.success && typeof task.command === "string" && managedStateSchema.safeParse(task.state).success) return id.data;
  }
  for (const key of ["structuredContent", "structured_content", "details", "result"]) {
    const id = startedTaskId(result[key], depth + 1);
    if (id) return id;
  }
  if (Array.isArray(result.content)) {
    for (const block of result.content.slice(0, 16)) {
      if (!block || typeof block !== "object" || block.type !== "text") continue;
      const id = startedTaskId(block.text, depth + 1);
      if (id) return id;
    }
  }
}

export function transformTaskStart(item: Extract<AgentTimelineItem, { type: "tool_call" }>) {
  if (item.status !== "completed" || !startNames.has(item.name) || item.detail.type !== "unknown") return;
  const id = startedTaskId(item.detail.output);
  if (!id) return;
  return { items: [{ type: "plugin" as const, kind: startNoticeKind, version: 1, data: { taskIds: [id] } }] };
}
