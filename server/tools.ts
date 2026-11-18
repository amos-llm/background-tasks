import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { taskIdSchema, taskLogsInput, taskStartInput } from "../shared/managed";
import { ManagedTaskStore } from "./managed";

export function registerTaskTools(server: PluginServerContext, store: ManagedTaskStore) {
  const tools = [
    defineAgentTool({
      name: "task_start",
      description: "Start a managed background command on the Linux daemon host with the plugin user's permissions (not the provider shell sandbox). Saves stdout/stderr independently of model output. Submit the original foreground command without &, tail, or output-limiting grep; use task_logs for filtering. Returns a task ID and only the latest 20 lines. Tasks survive plugin/client disconnects. Logs are retained for 7 days after completion by default; exceeding the configured log limit stops the task and is reported explicitly.",
      input: taskStartInput,
      async execute(input, { agent, signal }) {
        if (signal.aborted) throw new Error("工具调用已取消");
        const task = await store.start(agent, input);
        return { structuredContent: await store.tail(agent.id, task.id) };
      },
    }),
    defineAgentTool({
      name: "task_status", description: "Get a managed task's status, elapsed timestamps and exit code. Does not return full logs.",
      input: z.object({ taskId: taskIdSchema }),
      async execute({ taskId }, { agent }) { return { structuredContent: await store.get(agent.id, taskId) }; },
    }),
    defineAgentTool({
      name: "task_logs", description: "Read the tail of a managed task's saved log. Optional literal filter affects only this response, never the full saved log. Searches one bounded 64 KiB page; use the returned before cursor to read/search older pages.",
      input: taskLogsInput,
      async execute(input, { agent }) { return { structuredContent: await store.tail(agent.id, input.taskId, input) }; },
    }),
    defineAgentTool({
      name: "task_stop", description: "Stop a managed task's process group with SIGTERM, then SIGKILL after 3 seconds if needed. Logs remain available.",
      input: z.object({ taskId: taskIdSchema }),
      async execute({ taskId }, { agent }) { return { structuredContent: { stopped: await store.stop(agent.id, taskId) } }; },
    }),
    defineAgentTool({
      name: "task_list", description: "List this agent's managed background tasks, including completed tasks whose logs are retained. Output is paginated and does not include log contents.",
      input: z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }),
      async execute({ offset, limit }, { agent }) {
        const tasks = await store.list(agent.id);
        return { structuredContent: { tasks: tasks.slice(offset, offset + limit), total: tasks.length } };
      },
    }),
  ];
  return server.addHook("agent.open.before", async ({ request }) => {
    if (process.platform !== "linux" || !["codex", "pi"].includes(request.provider) || request.purpose === "history") return;
    return { ...request, tools: [...request.tools, ...tools] };
  });
}
