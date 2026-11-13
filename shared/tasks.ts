import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const taskSchema = z.object({
  token: z.string(), pid: z.number(), command: z.string(),
  elapsedSeconds: z.number(), cwd: z.string(),
});
export type Task = z.infer<typeof taskSchema>;
export const listTasks = defineRpc({
  name: "tasks.list", input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ tasks: z.array(taskSchema), supported: z.boolean() }),
});
export const stopTask = defineRpc({
  name: "tasks.stop", input: z.object({ agentId: z.string().min(1), token: z.string().min(1) }),
  output: z.object({ stopped: z.boolean() }),
});
