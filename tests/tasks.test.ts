import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { parseStat, readProcess, selectTasks, type ProcessInfo } from "../server/processes";
import { listTasks, stopTask } from "../shared/tasks";

function proc(patch: Partial<ProcessInfo> = {}): ProcessInfo {
  return { pid: 100, ppid: 50, group: 100, start: "1234", state: "S", args: ["/bin/bash", "-lc", "sleep 60"],
    agentId: "a", threadId: "thread", toolId: "exec-task", cwd: "/tmp", ...patch };
}
test("stat parser handles parentheses and spaces in process names", () => {
  const fields = ["S", "50", "100", ...Array(16).fill("0"), "1234", "0"];
  assert.deepEqual(parseStat("100 (test ) name) " + fields.join(" ")), { state: "S", ppid: 50, group: 100, start: "1234" });
});
test("Codex deduplicates groups and isolates agents, threads and infrastructure", () => {
  const all = [proc(), proc({ pid: 101, ppid: 100 }), proc({ pid: 200, group: 200, agentId: "other" }),
    proc({ pid: 300, group: 300, threadId: "old" }), proc({ pid: 400, group: 400, toolId: "" })];
  assert.equal(selectTasks(all, "a", "codex", "thread").length, 1);
  assert.equal(selectTasks(all, "a", "codex", null).length, 0);
  assert.equal(selectTasks([...all, proc({ pid: 102, agentId: "other" })], "a", "codex", "thread").length, 0);
  assert.equal(selectTasks([...all, proc({ pid: 102, toolId: "other" })], "a", "codex", "thread").length, 0);
  assert.equal(selectTasks([proc({ state: "Z" })], "a", "codex", "thread").length, 0);
  assert.equal(selectTasks([proc({ managedTaskId: "managed" })], "a", "codex", "thread").length, 0);
});
test("Pi detects direct shell tasks and exec commands, excluding MCP runtimes", () => {
  const runtime = proc({ pid: 50, group: 1, args: ["node", "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", "--mode", "rpc"], toolId: "" });
  const task = proc({ args: ["/usr/bin/sleep", "60"], toolId: "" });
  assert.equal(selectTasks([runtime, task], "a", "pi", null).length, 1);
  assert.equal(selectTasks([runtime, proc({ ppid: 99 })], "a", "pi", null).length, 0);
});
function service(agentId: string) {
  const handlers = new Map<string, (input: any, context: any) => Promise<any>>();
  const cleanup = contribute({ handle(contract: { name: string }, handler: any) { handlers.set(contract.name, handler); }, addHook() { return () => {}; } } as unknown as PluginServerContext);
  const context = { paseo: { agents: { ref: () => ({ refresh: async () => {}, current: () => ({ provider: "codex" }), runtimeInfo: { sessionId: "test-thread" } }) } } };
  return {
    list: () => handlers.get(listTasks.name)!({ agentId }, context),
    stop: (token: string, id = agentId) => handlers.get(stopTask.name)!({ agentId: id, token }, context), cleanup,
  };
}
async function job(agentId: string, ignoreTerm = false): Promise<{ child: ChildProcess; descendant: number; exited: Promise<unknown[]> }> {
  const descendantSource = (ignoreTerm ? "process.on('SIGTERM', () => {});" : "") + "console.log('ready'); setInterval(() => {}, 1000);";
  const source = "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', " +
    JSON.stringify(descendantSource) + "], { stdio: ['ignore', 'pipe', 'ignore'] }); child.stdout.once('data', () => console.log(child.pid)); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PASEO_AGENT_ID: agentId, CODEX_THREAD_ID: "test-thread", CODEX_TOOL_CALL_ID: randomUUID() } });
  const exited = once(child, "exit");
  const [data] = await once(child.stdout!, "data");
  return { child, descendant: Number(data.toString().trim()), exited };
}
function cleanupJob(child: ChildProcess) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
async function waitGone(pid: number, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const p = await readProcess(pid);
    if (!p || p.state === "Z" || p.state === "X") return;
    await delay(40);
  }
  assert.fail("process " + pid + " remained alive");
}
test("live task elapsed time tracks the process lifetime", async () => {
  const id = randomUUID(); const api = service(id); const started = performance.now(); const running = await job(id);
  try {
    const first = (await api.list()).tasks[0];
    assert.ok(first, "task should be listed");
    assert.ok(first.elapsedSeconds >= 0 && first.elapsedSeconds < (performance.now() - started) / 1000 + 0.5);
    await delay(1200);
    const second = (await api.list()).tasks[0];
    assert.ok(second.elapsedSeconds - first.elapsedSeconds >= 1);
    assert.ok(second.elapsedSeconds < (performance.now() - started) / 1000 + 0.5);
  } finally { cleanupJob(running.child); await running.exited; api.cleanup(); }
});
test("live tasks stop their group; forged and cross-agent tokens cannot signal", async () => {
  const id = randomUUID(); const api = service(id); const running = await job(id);
  try {
    const result = await api.list();
    assert.equal(result.supported, true); assert.equal(result.tasks.length, 1);
    const task = result.tasks[0]; assert.equal(task.pid, running.child.pid);
    await assert.rejects(api.stop("forged"));
    await assert.rejects(api.stop(task.token, "different-agent"));
    assert.equal((await readProcess(task.pid))?.state === "Z", false);
    assert.deepEqual(await api.stop(task.token), { stopped: true });
    await running.exited; await waitGone(running.descendant);
  } finally { cleanupJob(running.child); api.cleanup(); }
});
test("TERM-resistant children are killed after the group leader exits", async () => {
  const id = randomUUID(); const api = service(id); const running = await job(id, true);
  try {
    const { tasks } = await api.list(); assert.equal(tasks.length, 1);
    await api.stop(tasks[0].token); await running.exited;
    await waitGone(running.descendant);
  } finally { cleanupJob(running.child); api.cleanup(); }
});
test("an exited process cannot be stopped through its old list entry", async () => {
  const id = randomUUID(); const api = service(id); const running = await job(id);
  try {
    const { tasks } = await api.list(); assert.equal(tasks.length, 1);
    cleanupJob(running.child); await running.exited;
    assert.deepEqual(await api.stop(tasks[0].token), { stopped: false });
  } finally { cleanupJob(running.child); api.cleanup(); }
});
