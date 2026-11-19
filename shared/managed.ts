import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const taskIdSchema = z.string().uuid();
export const managedStateSchema = z.enum([
  "starting", "running", "completed", "failed", "stopped", "timed_out", "log_limit", "error", "unknown",
]);
export const managedTaskSchema = z.object({
  id: taskIdSchema, command: z.string(), cwd: z.string(), provider: z.enum(["codex", "pi"]),
  label: z.string().optional(), instruction: z.string().optional(), notifyOnExit: z.boolean().optional(),
  notificationStatus: z.enum(["disabled", "pending", "delivered", "cancelled"]).optional(),
  state: managedStateSchema, createdAt: z.number(), endedAt: z.number().nullable(),
  pid: z.number().nullable(), exitCode: z.number().nullable(), exitSignal: z.string().nullable(),
  logBytes: z.number(), logTruncated: z.boolean(), error: z.string().nullable(),
});
export type ManagedTask = z.infer<typeof managedTaskSchema>;
export function isActiveTask(task: Pick<ManagedTask, "state">) {
  return task.state === "starting" || task.state === "running";
}
export const logPageSchema = z.object({
  text: z.string(), start: z.number(), end: z.number(), totalBytes: z.number(), hasEarlier: z.boolean(),
  task: managedTaskSchema,
});
export type LogPage = z.infer<typeof logPageSchema>;
const owner = { agentId: z.string().min(1) };
export const listManagedTasks = defineRpc({
  name: "managed.list", input: z.object(owner),
  output: z.object({ tasks: z.array(managedTaskSchema), supported: z.boolean(), retentionDays: z.number() }),
});
export const readTaskLog = defineRpc({
  name: "managed.logs", input: z.object({ ...owner, taskId: taskIdSchema,
    // No cursor means the latest page. `before` pages backwards; `after` follows output.
    before: z.number().int().nonnegative().optional(), after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(4).max(65536).default(32768),
  }).refine((value) => value.before === undefined || value.after === undefined, "只能使用一个日志游标"),
  output: logPageSchema,
});
export const stopManagedTask = defineRpc({
  name: "managed.stop", input: z.object({ ...owner, taskId: taskIdSchema }),
  output: z.object({ stopped: z.boolean() }),
});
export const taskLogLocation = defineRpc({
  name: "managed.log-location", input: z.object({ ...owner, taskId: taskIdSchema }),
  output: z.object({ path: z.string() }),
});
export const taskStartInput = z.object({
  command: z.string().trim().min(1).max(65536).describe("Original foreground command. Do not append &, tail or output-limiting grep; use task_logs to inspect output."),
  cwd: z.string().min(1).optional().describe("Working directory; defaults to the calling agent's directory."),
  timeoutSeconds: z.number().int().min(1).max(604800).optional(),
  label: z.string().trim().min(1).max(120).optional().describe("Short task name."),
  instruction: z.string().trim().min(1).max(2000).optional().describe("What to do when the task finishes, for example inspect failed tests and continue the original task."),
  notifyOnExit: z.boolean().default(true).describe("Automatically resume the owning agent with a short completion notice when idle. Do not sleep or poll just to wait. Set false only when deliberately monitoring completion yourself."),
});
export const taskLogsInput = z.object({
  taskId: taskIdSchema, tailLines: z.number().int().min(1).max(1000).default(20),
  filter: z.string().max(1000).optional().describe("Literal, case-sensitive text filter, applied when reading saved output."),
  before: z.number().int().nonnegative().optional().describe("Byte cursor from a previous response to search an older page."),
});
