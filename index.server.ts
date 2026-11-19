import type { PluginServerContext, PluginHandlerContext } from "@getpaseo/plugin/server";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { listTasks, stopTask } from "./shared/tasks";
import { readProcess, selectTasks, snapshot } from "./server/processes";
import { listManagedTasks, readTaskLog, stopManagedTask } from "./shared/managed";
import { ManagedTaskStore } from "./server/managed";
import { registerTaskTools } from "./server/tools";
import { TaskCompletionNotifier } from "./server/notifications";

export default function contribute(server: PluginServerContext) {
  const managed = new ManagedTaskStore();
  const notifier = new TaskCompletionNotifier(managed);
  const removeTools = registerTaskTools(server, managed, notifier);
  async function checkAgent(agentId: string, paseo: PluginHandlerContext["paseo"]) {
    if (process.platform !== "linux") throw new Error("受管后台任务需要 Linux 主机");
    notifier.connect(paseo);
    const agent = paseo.agents.ref(agentId);
    await agent.refresh();
    if (!agent.current() || !["codex", "pi"].includes(agent.current()!.provider)) throw new Error("会话不可用");
  }
  server.handle(listManagedTasks, async ({ agentId }, { paseo }) => {
    if (process.platform !== "linux") return { tasks: [], supported: false, retentionDays: managed.retentionDays };
    await checkAgent(agentId, paseo);
    return { tasks: await managed.list(agentId), supported: true, retentionDays: managed.retentionDays };
  });
  server.handle(readTaskLog, async ({ agentId, taskId, ...options }, { paseo }) => {
    await checkAgent(agentId, paseo);
    return managed.readLog(agentId, taskId, options);
  });
  server.handle(stopManagedTask, async ({ agentId, taskId }, { paseo }) => {
    await checkAgent(agentId, paseo);
    return { stopped: await managed.stop(agentId, taskId) };
  });
  const tokens = new Map<string, { agentId: string; pid: number; start: string; toolId: string; seen: number }>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const ticks = process.platform === "linux" ? Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) : 100;
  let cached: { at: number; value: ReturnType<typeof snapshot> } | undefined;
  function cachedSnapshot() {
    if (!cached || Date.now() - cached.at > 1000) {
      const value = snapshot(); cached = { at: Date.now(), value };
      void value.catch(() => { if (cached?.value === value) cached = undefined; });
    }
    return cached.value;
  }
  server.handle(listTasks, async ({ agentId }, { paseo }) => {
    if (process.platform !== "linux") return { tasks: [], supported: false };
    const agent = paseo.agents.ref(agentId);
    await agent.refresh();
    const current = agent.current();
    if (!current || !["codex", "pi"].includes(current.provider)) return { tasks: [], supported: false };
    const [all, uptime] = await Promise.all([cachedSnapshot(), readFile("/proc/uptime", "utf8")]);
    const now = Date.now();
    for (const [key, value] of tokens) if (now - value.seen > 60_000) tokens.delete(key);
    const tasks = selectTasks(all, agentId, current.provider, agent.runtimeInfo?.sessionId ?? null).map(({ leader, command }) => {
      let token = [...tokens].find(([, value]) => value.agentId === agentId && value.pid === leader.pid && value.start === leader.start)?.[0];
      token ??= randomUUID();
      tokens.set(token, { agentId, pid: leader.pid, start: leader.start, toolId: leader.toolId, seen: now });
      return { token, pid: leader.pid, command, cwd: leader.cwd,
        elapsedSeconds: Math.max(0, Number(uptime.split(" ")[0]) - Number(leader.start) / ticks) };
    });
    return { tasks: tasks.sort((a, b) => b.elapsedSeconds - a.elapsedSeconds), supported: true };
  });
  server.handle(stopTask, async ({ agentId, token }, { paseo }) => {
    const identity = tokens.get(token);
    if (!identity || identity.agentId !== agentId || Date.now() - identity.seen > 60_000) throw new Error("任务列表已过期，请刷新后重试");
    const agent = paseo.agents.ref(agentId);
    await agent.refresh();
    const provider = agent.current()?.provider;
    if (!provider || !["codex", "pi"].includes(provider)) throw new Error("会话不可用");
    const before = await snapshot();
    const tasks = selectTasks(before, agentId, provider, agent.runtimeInfo?.sessionId ?? null);
    const task = tasks.find(({ leader }) => leader.pid === identity.pid && leader.start === identity.start && leader.toolId === identity.toolId);
    if (!task) { tokens.delete(token); return { stopped: false }; }
    const members = before.filter((p) => p.group === identity.pid).map((p) => ({ pid: p.pid, start: p.start }));
    const threadId = agent.runtimeInfo?.sessionId ?? null;
    const latest = await readProcess(identity.pid);
    if (!latest || latest.start !== identity.start || latest.agentId !== agentId) return { stopped: false };
    try { process.kill(-identity.pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const timer = setTimeout(async () => {
      timers.delete(timer);
      try {
        const remaining = (await snapshot()).filter((p) => p.group === identity.pid && p.state !== "Z" && p.state !== "X");
        if (!remaining.some((p) => members.some((original) => original.pid === p.pid && original.start === p.start))) return;
        if (remaining.some((p) => p.agentId !== agentId || (provider === "codex" && (p.threadId !== threadId || p.toolId !== identity.toolId)))) return;
        process.kill(-identity.pid, "SIGKILL"); cached = undefined;
      } catch { /* Already exited or inaccessible. */ }
    }, 3000);
    timer.unref(); timers.add(timer); tokens.delete(token); cached = undefined;
    return { stopped: true };
  });
  const cleanupTimer = setInterval(() => { void managed.cleanup().catch(error => console.error("Background task cleanup failed", error)); }, 60_000);
  cleanupTimer.unref();
  return () => { const drained = removeTools(); clearInterval(cleanupTimer); for (const timer of timers) clearTimeout(timer); tokens.clear(); return drained; };
}
