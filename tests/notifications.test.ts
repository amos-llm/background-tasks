import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { AgentToolDefinition, PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { isActiveTask, type ManagedTask } from "../shared/managed";
import { ManagedTaskStore } from "../server/managed";
import { TaskCompletionNotifier } from "../server/notifications";
import { registerTaskTools } from "../server/tools";

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const node = (source: string) => quote(process.execPath) + " -e " + quote(source);
async function finished(store: ManagedTaskStore, agentId: string, id: string): Promise<ManagedTask> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = await store.get(agentId, id);
    if (!isActiveTask(task)) return task;
    await delay(25);
  }
  throw new Error("Task did not finish");
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "background-notifications-"));
  const store = new ManagedTaskStore({ root, maxLogBytes: 512 * 1024, totalLogBytes: 8 * 1024 * 1024 });
  const owner = { id: randomUUID(), provider: "codex", cwd: root };
  const snapshots = new Map<string, any>([[owner.id, { provider: "codex", status: "running", activeTurn: null, pendingPermissions: [], archivedAt: null }]]);
  const sent: { agentId: string; text: string; options: any }[] = [], errors: unknown[] = [];
  const attemptedMessages: { text: string; options: any }[] = [];
  let failures = 0, attempts = 0;
  const paseo = { agents: { ref(agentId: string) { return {
    refresh: async () => {}, current: () => snapshots.get(agentId),
    async send(text: string, options: unknown) {
      attempts++;
      attemptedMessages.push({ text, options });
      if (failures > 0) { failures--; throw new Error("Temporary transport failure"); }
      sent.push({ agentId, text, options });
    },
  }; } } } as unknown as PluginHandlerContext["paseo"];
  const notifier = new TaskCompletionNotifier(store, error => errors.push(error));
  notifier.connect(paseo);
  t.after(async () => {
    await notifier.dispose();
    for (const agentId of snapshots.keys()) {
      for (const task of await store.list(agentId)) {
        if (isActiveTask(task)) { await store.stop(agentId, task.id); await finished(store, agentId, task.id); }
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, owner, snapshots, current: snapshots.get(owner.id), paseo, notifier, sent, errors, attemptedMessages,
    failNext: () => { failures++; }, attempts: () => attempts };
}
const events = (message: { text: string }) => (message.text.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g) ?? []).map(taskId => ({ taskId }));

test("busy agents queue results; idle delivery sends short notices with results available through task status", async t => {
  const f = await fixture(t);
  const first = await f.store.start(f.owner, { command: node("for(let i=0;i<300;i++)console.log('line-'+i)"), label: "Tests", instruction: "Inspect failures and continue." });
  const second = await f.store.start(f.owner, { command: "printf 'failure-marker\\n'; exit 7" });
  const disabled = await f.store.start(f.owner, { command: "true", notifyOnExit: false });
  await Promise.all([first, second, disabled].map(task => finished(f.store, f.owner.id, task.id)));
  await f.notifier.flush();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.store.pendingCompletions()).length, 2);
  f.current.status = "idle";
  await Promise.all([f.notifier.flush(), f.notifier.flush()]);
  assert.equal(f.sent.length, 1);
  const delivered = events(f.sent[0]);
  assert.deepEqual(new Set(delivered.map(event => event.taskId)), new Set([first.id, second.id]));
  assert.ok(f.sent[0].text.includes("task_status"));
  assert.ok(!f.sent[0].text.includes("line-299") && !f.sent[0].text.includes("Inspect failures"));
  assert.equal((await f.store.get(f.owner.id, first.id)).instruction, "Inspect failures and continue.");
  assert.equal((await f.store.get(f.owner.id, second.id)).exitCode, 7);
  assert.equal(f.sent[0].options.activeTurnBehavior, "steer");
  assert.equal((await f.store.get(f.owner.id, first.id)).notificationStatus, "delivered");
  assert.equal((await f.store.get(f.owner.id, disabled.id)).notificationStatus, "disabled");
  const receipt = join(f.root, createHash("sha256").update(f.owner.id).digest("hex"), first.id, "notification.json");
  assert.equal((await stat(receipt)).mode & 0o777, 0o600);
  await f.notifier.dispose();
  const reloaded = new TaskCompletionNotifier(new ManagedTaskStore({ root: f.root }));
  reloaded.connect(f.paseo);
  await reloaded.flush(); await reloaded.dispose();
  assert.equal(f.sent.length, 1, "delivered receipts must survive reload");
});

test("completion while the notifier is unloaded is recovered by a new store and isolated by owner", async t => {
  const f = await fixture(t);
  const other = { ...f.owner, id: randomUUID(), provider: "pi" };
  f.snapshots.set(other.id, { provider: "pi", status: "running" });
  const task = await f.store.start(f.owner, { command: node("setTimeout(()=>console.log('after-reload'),200)") });
  const otherTask = await f.store.start(other, { command: "true" });
  await f.notifier.dispose();
  await Promise.all([finished(f.store, f.owner.id, task.id), finished(f.store, other.id, otherTask.id)]);
  f.current.status = "idle";
  const recoveredStore = new ManagedTaskStore({ root: f.root });
  const recovered = new TaskCompletionNotifier(recoveredStore);
  t.after(() => recovered.dispose());
  recovered.connect(f.paseo);
  await recovered.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].agentId, f.owner.id);
  assert.equal(events(f.sent[0])[0].taskId, task.id);
  assert.equal((await recoveredStore.get(other.id, otherTask.id)).notificationStatus, "pending");
  f.snapshots.get(other.id).status = "idle";
  await recovered.flush();
  assert.equal(f.sent[1].agentId, other.id);
});

test("manual stop cancels both running and already queued completion notifications", async t => {
  const f = await fixture(t);
  const running = await f.store.start(f.owner, { command: "sleep 30" });
  await f.store.stop(f.owner.id, running.id);
  await finished(f.store, f.owner.id, running.id);
  const done = await f.store.start(f.owner, { command: "true" });
  await finished(f.store, f.owner.id, done.id);
  assert.equal(await f.store.stop(f.owner.id, done.id), false);
  f.current.status = "idle";
  await f.notifier.flush();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.store.get(f.owner.id, running.id)).notificationStatus, "cancelled");
  assert.equal((await f.store.get(f.owner.id, done.id)).notificationStatus, "cancelled");
  await assert.rejects(f.store.settleNotification("someone-else", done.id, "delivered"));
});

test("failed delivery stays pending and retries with the same message ID", async t => {
  const f = await fixture(t);
  const task = await f.store.start(f.owner, { command: "true" });
  await finished(f.store, f.owner.id, task.id);
  f.current.status = "idle"; f.failNext();
  await f.notifier.flush();
  assert.equal(f.attempts(), 1); assert.equal(f.errors.length, 1);
  assert.equal((await f.store.get(f.owner.id, task.id)).notificationStatus, "pending");
  await f.notifier.flush(); assert.equal(f.attempts(), 1, "failed sends should back off");
  await delay(1050); await f.notifier.flush();
  assert.equal(f.sent.length, 1); assert.equal(f.attempts(), 2);
  assert.equal(f.attemptedMessages[0].options.messageId, f.attemptedMessages[1].options.messageId);
  assert.equal((await f.store.get(f.owner.id, task.id)).notificationStatus, "delivered");
});

test("closed or permission-blocked agents are not woken; archiving cancels pending delivery", async t => {
  const f = await fixture(t);
  const task = await f.store.start(f.owner, { command: "true" });
  await finished(f.store, f.owner.id, task.id);
  f.current.status = "idle"; f.current.pendingPermissions = [{}];
  await f.notifier.flush(); assert.equal(f.sent.length, 0);
  f.current.pendingPermissions = []; f.current.status = "closed";
  await f.notifier.flush(); assert.equal(f.sent.length, 0);
  f.current.status = "idle"; f.current.activeTurn = { turnId: "still-finishing" };
  await f.notifier.flush(); assert.equal(f.sent.length, 0);
  f.current.activeTurn = null; f.current.archivedAt = new Date().toISOString();
  await f.notifier.flush(); assert.equal(f.sent.length, 0);
  assert.equal((await f.store.get(f.owner.id, task.id)).notificationStatus, "cancelled");
});

test("large output and instructions stay out of completion notices without dropping completions", async t => {
  const f = await fixture(t);
  const tasks = [];
  for (let i = 0; i < 8; i++) {
    const task = await f.store.start(f.owner, { command: node("process.stdout.write(('中文'+String.fromCharCode(1)).repeat(5000))"), instruction: "\u0001".repeat(2000) });
    await finished(f.store, f.owner.id, task.id); tasks.push(task);
  }
  f.current.status = "idle";
  for (let i = 0; i < 8 && (await f.store.pendingCompletions()).length; i++) await f.notifier.flush();
  assert.equal((await f.store.pendingCompletions()).length, 0);
  assert.equal(f.sent.length, 1);
  const delivered = f.sent.flatMap(message => events(message));
  assert.deepEqual(new Set(delivered.map(event => event.taskId)), new Set(tasks.map(task => task.id)));
  assert.equal(delivered.length, tasks.length);
  for (const message of f.sent) { assert.ok(Buffer.byteLength(message.text) <= 32768); assert.ok(!message.text.includes("�")); }
});

test("legacy records are not replayed and cancelled turns suppress future completion wakes", async t => {
  const f = await fixture(t);
  const legacy = await f.store.start(f.owner, { command: "true" });
  await finished(f.store, f.owner.id, legacy.id);
  const recordPath = join(f.root, createHash("sha256").update(f.owner.id).digest("hex"), legacy.id, "task.json");
  const record = JSON.parse(await readFile(recordPath, "utf8")); delete record.notifyOnExit;
  await writeFile(recordPath, JSON.stringify(record));
  f.current.status = "idle"; await f.notifier.flush(); assert.equal(f.sent.length, 0);
  const hooks = new Map<string, any>();
  const unregister = registerTaskTools({ addHook(name: string, handler: any) { hooks.set(name, handler); return () => { hooks.delete(name); }; } } as unknown as PluginServerContext, f.store, f.notifier);
  const running = await f.store.start(f.owner, { command: node("setTimeout(()=>{},200)") });
  await hooks.get("agent.turn.after")({ agent: f.owner, outcome: { kind: "canceled" } }, { paseo: f.paseo });
  await finished(f.store, f.owner.id, running.id);
  await f.notifier.flush(); assert.equal(f.sent.length, 0);
  assert.equal((await f.store.get(f.owner.id, running.id)).notificationStatus, "cancelled");
  await unregister();
});

test("task_start returns a completed result once without scheduling an additional wake", async t => {
  const f = await fixture(t);
  const start = f.store.start.bind(f.store);
  f.store.start = async (owner, input) => { const task = await start(owner, input); return finished(f.store, owner.id, task.id); };
  const hooks = new Map<string, any>();
  const unregister = registerTaskTools({ addHook(name: string, handler: any) { hooks.set(name, handler); return () => { hooks.delete(name); }; } } as unknown as PluginServerContext, f.store, f.notifier);
  const attached = await hooks.get("agent.open.before")({ request: { provider: "codex", purpose: "interactive", tools: [] } }, { paseo: f.paseo });
  const tool = attached.tools.find((tool: AgentToolDefinition) => tool.name === "task_start") as AgentToolDefinition;
  f.current.status = "idle";
  const result = await tool.execute(tool.input.parse({ command: "printf 'already-finished\\n'" }), { agent: { ...f.owner, workspaceId: null, parentAgentId: null, title: null }, paseo: f.paseo, signal: new AbortController().signal });
  assert.equal((result.structuredContent as any).task.notificationStatus, "delivered");
  const modelVisible = result.text ?? JSON.stringify(result.structuredContent);
  assert.ok(modelVisible.includes((result.structuredContent as any).task.id), "MCP text clients must receive the task ID as well as guidance");
  assert.ok(modelVisible.includes("already-finished"));
  await f.notifier.flush(); assert.equal(f.sent.length, 0);
  await unregister();
});

test("a cancellation during startup suppresses the wake even before the turn hook can see the task", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const start = f.store.start.bind(f.store);
  f.store.start = async (owner, input) => { const task = await start(owner, input); controller.abort(); return task; };
  const hooks = new Map<string, any>();
  const unregister = registerTaskTools({ addHook(name: string, handler: any) { hooks.set(name, handler); return () => { hooks.delete(name); }; } } as unknown as PluginServerContext, f.store, f.notifier);
  const attached = await hooks.get("agent.open.before")({ request: { provider: "codex", purpose: "interactive", tools: [] } }, { paseo: f.paseo });
  const tool = attached.tools.find((tool: AgentToolDefinition) => tool.name === "task_start") as AgentToolDefinition;
  f.current.status = "idle";
  const result = await tool.execute(tool.input.parse({ command: node("setTimeout(()=>{},200)") }), { agent: { ...f.owner, workspaceId: null, parentAgentId: null, title: null }, paseo: f.paseo, signal: controller.signal });
  const task = (result.structuredContent as any).task;
  await finished(f.store, f.owner.id, task.id);
  await f.notifier.flush(); assert.equal(f.sent.length, 0);
  assert.equal((await f.store.get(f.owner.id, task.id)).notificationStatus, "cancelled");
  await unregister();
});
