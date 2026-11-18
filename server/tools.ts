import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { isActiveTask, taskIdSchema, taskLogsInput, taskStartInput } from "../shared/managed";
import { ManagedTaskStore } from "./managed";
import { TaskCompletionNotifier } from "./notifications";

const taskGuidanceMarker = "[Paseo background-tasks]";
const completionGuidanceMarker = "[Paseo task completion notifications]";
const completionGuidance = `${completionGuidanceMarker}
task_start defaults to notifyOnExit=true. Task completion or failure is queued and automatically resumes this agent when idle, with its task ID, exit code, saved instruction and a bounded output tail. Continue independent work, or end this turn with a brief status if only waiting for completion. Do not sleep, run sleep commands, or repeatedly poll task_status merely to wait. Set instruction to explain what to do with the result, and label for a short task name. Full logs stay on disk; use task_logs only when more output is needed. A manual task_stop cancels pending completion delivery. notifyOnExit=false disables automatic delivery, so that explicit mode requires checking completion yourself.`;
const taskGuidance = `${taskGuidanceMarker}
Command execution rule: you MUST use the Paseo task_start tool for development servers, watchers, builds, test runs, typechecks, dependency installs, background jobs, other potentially long-running commands, and commands whose complete logs the user wants to inspect. This applies even when you intend to wait for the command to finish in the foreground, expect it to finish quickly, or only need a small output summary. Do not start these commands with exec_command, bash, terminal tools, shell backgrounding, or a provider's built-in background/yield option. If the expected duration is unclear, use task_start.
Short commands for file inspection, search, Git inspection, and file edits can use the normal shell. Before executing a command, choose the tool using the rule above. For example, run npm test, npm run typecheck, npm run build, npm run dev, pytest, cargo test, and npm install with task_start; use the normal shell for rg, cat, ls, and git diff. Split inspection and task execution into separate calls so a build or test is not hidden inside an ordinary shell command.
If task_start is not visible, use the available tool discovery/search mechanism to find task_start on the paseo MCP server (it may be named mcp__paseo__task_start). Discover task_status, task_logs, task_stop and task_list as needed. Do not assume these tools are unavailable just because they are not in the initial tool list.
Pass the original foreground command and cwd to task_start; do not add &, nohup, output redirection, or tail/grep solely to reduce model output. The plugin saves stdout/stderr for the user's task/log panel while returning only the latest 20 lines to you. Use task_logs with tailLines/filter/before for concise inspection, task_status for progress, task_stop to stop, and task_list to find this session's tasks. Report the returned task ID; do not invent one. When a job must finish before dependent work, check its terminal state and exit code first. Do not repeatedly poll a persistent server waiting for it to finish.
Commands run on the Linux daemon host with the plugin user's permissions, outside the provider shell sandbox. Respect the user's instructions and applicable permission requirements; do not use this tool to bypass a denial or restriction. If the tools cannot be found or a start fails, explain that limitation before using a fallback that cannot preserve complete managed logs.
${completionGuidance}`;

export function registerTaskTools(server: PluginServerContext, store: ManagedTaskStore, notifier = new TaskCompletionNotifier(store)) {
  // open.before can attach tools, but SDK 0.15.4 cannot change the session prompt
  // there. Add durable guidance at creation so it is present before the first turn
  // and survives resume. Children may inherit it, so avoid appending it twice.
  const removeGuidance = server.addHook("agent.create.before", async ({ request }) => {
    if (process.platform !== "linux" || !["codex", "pi"].includes(request.config.provider) || request.config.internal) return;
    const prompt = request.config.systemPrompt ?? "";
    if (prompt.includes(taskGuidanceMarker) && prompt.includes(completionGuidanceMarker)) return;
    const guidance = prompt.includes(taskGuidanceMarker) ? completionGuidance : taskGuidance;
    return {
      ...request,
      config: { ...request.config, systemPrompt: prompt ? `${prompt}\n\n${guidance}` : guidance },
    };
  });
  const tools = [
    defineAgentTool({
      name: "task_start",
      description: "REQUIRED for running servers, watchers, builds, tests, typechecks, dependency installs, background jobs, potentially long-running commands, or commands needing complete user-visible logs. Use instead of exec_command/bash/terminal even for foreground waits or quick jobs. Returns immediately with a task ID and latest 20 lines. Completion or failure automatically resumes this agent when idle by default; continue other work or finish this turn. Do NOT sleep or poll merely to wait. Set instruction for what to do with the result and label for a short name. notifyOnExit=false opts out. Full logs stay on disk; task_logs reads bounded output on demand. Pass the original foreground command and cwd without &, nohup or output-limiting tail/grep. Runs on the Linux daemon host with the plugin user's permissions, outside the provider shell sandbox. Tasks survive plugin/client disconnects; logs are retained for 7 days by default. Log limits stop the task explicitly.",
      input: taskStartInput,
      async execute(input, { agent, signal, paseo }) {
        if (signal.aborted) throw new Error("工具调用已取消");
        const release = notifier.hold(agent.id);
        notifier.connect(paseo);
        try {
          const task = await store.start(agent, input);
          // A cancellation hook can run before a queued start has created its
          // record. Check the tool signal again while delivery is still held.
          if (signal.aborted) await store.settleNotification(agent.id, task.id, "cancelled");
          const page = await store.tail(agent.id, task.id);
          if (!isActiveTask(page.task) && page.task.notificationStatus === "pending") {
            await store.settleNotification(agent.id, task.id, "delivered");
            page.task.notificationStatus = (await store.get(agent.id, task.id)).notificationStatus;
          }
          const text = !isActiveTask(page.task) ? "Task already finished; its result is included below. No additional completion wake is needed."
            : page.task.notificationStatus === "pending" ? "Running in the background. Completion will automatically resume this agent when idle. Continue other work or finish this turn; do not sleep or poll merely to wait."
              : "Running in the background with automatic completion delivery disabled. Check task_status before dependent work.";
          // Some MCP clients use only text when it is supplied, ignoring the
          // structured payload. Keep guidance and task facts in one SDK-rendered result.
          return { structuredContent: { ...page, message: text } };
        } finally { release(); }
      },
    }),
    defineAgentTool({
      name: "task_status", description: "Get task state, timestamps, exit code and notification delivery status. Completion wakes the agent automatically by default; do not poll merely to wait. Does not return full logs.",
      input: z.object({ taskId: taskIdSchema }),
      async execute({ taskId }, { agent }) { return { structuredContent: await store.get(agent.id, taskId) }; },
    }),
    defineAgentTool({
      name: "task_logs", description: "Read the tail of a managed task's saved log. Optional literal filter affects only this response, never the full saved log. Searches one bounded 64 KiB page; use the returned before cursor to read/search older pages.",
      input: taskLogsInput,
      async execute(input, { agent }) { return { structuredContent: await store.tail(agent.id, input.taskId, input) }; },
    }),
    defineAgentTool({
      name: "task_stop", description: "Cancel pending completion notification and stop the task's process group with SIGTERM, then SIGKILL after 3 seconds if needed. Logs remain available.",
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
  const removeTools = server.addHook("agent.open.before", async ({ request }, context) => {
    if (process.platform !== "linux" || !["codex", "pi"].includes(request.provider) || request.purpose === "history") return;
    if (context?.paseo) notifier.connect(context.paseo);
    return { ...request, tools: [...request.tools, ...tools] };
  });
  const removeTurn = server.addHook("agent.turn.after", async ({ agent, outcome }, { paseo }) => {
    if (process.platform !== "linux" || !["codex", "pi"].includes(agent.provider)) return;
    if (outcome.kind === "canceled") await store.cancelNotifications(agent.id);
    notifier.connect(paseo);
  });
  const removeArchive = server.addHook("agent.archive.after", async ({ agent }) => {
    await store.cancelNotifications(agent.id);
  });
  return () => { removeTools(); removeGuidance(); removeTurn(); removeArchive(); return notifier.dispose(); };
}
