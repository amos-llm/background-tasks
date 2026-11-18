import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { taskIdSchema, taskLogsInput, taskStartInput } from "../shared/managed";
import { ManagedTaskStore } from "./managed";

const taskGuidanceMarker = "[Paseo background-tasks]";
const taskGuidance = `${taskGuidanceMarker}
The background-tasks plugin is available in this session. For background jobs, long-running commands (such as development servers, watchers, builds or test suites), or commands whose complete logs the user wants to inspect, prefer the Paseo task_start tool over shell backgrounding. Short commands and file inspection can use the normal shell.
If task_start is not visible, use the available tool discovery/search mechanism to find task_start on the paseo MCP server (it may be named mcp__paseo__task_start). Discover task_status, task_logs, task_stop and task_list as needed. Do not assume these tools are unavailable just because they are not in the initial tool list.
Pass the original foreground command and cwd to task_start; do not add &, nohup, output redirection, or tail/grep solely to reduce model output. The plugin saves stdout/stderr for the user's task/log panel while returning only the latest 20 lines to you. Use task_logs with tailLines/filter/before for concise inspection, task_status for progress, task_stop to stop, and task_list to find this session's tasks. Report the returned task ID; do not invent one. When a job must finish before dependent work, check its terminal state and exit code first. Do not repeatedly poll a persistent server waiting for it to finish.
Commands run on the Linux daemon host with the plugin user's permissions, outside the provider shell sandbox. Respect the user's instructions and applicable permission requirements; do not use this tool to bypass a denial or restriction. If the tools cannot be found or a start fails, explain that limitation before using a fallback that cannot preserve complete managed logs.`;

export function registerTaskTools(server: PluginServerContext, store: ManagedTaskStore) {
  // open.before can attach tools, but SDK 0.15.4 cannot change the session prompt
  // there. Add durable guidance at creation so it is present before the first turn
  // and survives resume. Children may inherit it, so avoid appending it twice.
  const removeGuidance = server.addHook("agent.create.before", async ({ request }) => {
    if (process.platform !== "linux" || !["codex", "pi"].includes(request.config.provider) || request.config.internal) return;
    const prompt = request.config.systemPrompt ?? "";
    if (prompt.includes(taskGuidanceMarker)) return;
    return {
      ...request,
      config: { ...request.config, systemPrompt: prompt ? `${prompt}\n\n${taskGuidance}` : taskGuidance },
    };
  });
  const tools = [
    defineAgentTool({
      name: "task_start",
      description: "Use for background jobs, long-running servers/watchers/builds/tests, or commands needing complete user-visible logs. Start a managed background command on the Linux daemon host with the plugin user's permissions (not the provider shell sandbox). Saves stdout/stderr independently of model output. Submit the original foreground command without &, tail, or output-limiting grep; use task_logs for filtering. Returns a task ID and only the latest 20 lines. Tasks survive plugin/client disconnects. Logs are retained for 7 days after completion by default; exceeding the configured log limit stops the task and is reported explicitly.",
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
  const removeTools = server.addHook("agent.open.before", async ({ request }) => {
    if (process.platform !== "linux" || !["codex", "pi"].includes(request.provider) || request.purpose === "history") return;
    return { ...request, tools: [...request.tools, ...tools] };
  });
  return () => { removeTools(); removeGuidance(); };
}
