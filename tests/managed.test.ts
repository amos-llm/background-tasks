import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { AgentToolDefinition, PluginServerContext } from "@getpaseo/plugin/server";
import { ManagedTaskStore, type StoreOptions, type TaskOwner } from "../server/managed";
import { registerTaskTools } from "../server/tools";
import { readProcess } from "../server/processes";
import { isActiveTask, type ManagedTask } from "../shared/managed";
import { mergeLogPage, plainLog, LOG_WINDOW_BYTES } from "../client/log-format";

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const node = (source: string) => quote(process.execPath) + " -e " + quote(source);
async function fixture(t: TestContext, options: StoreOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "background-tasks-test-"));
  const owner: TaskOwner = { id: randomUUID(), provider: "codex", cwd: root };
  const store = new ManagedTaskStore({ root, maxLogBytes: 4 * 1024 * 1024, totalLogBytes: 16 * 1024 * 1024, ...options });
  const owners = [owner];
  t.after(async () => {
    for (const own of owners) {
      for (const task of await store.list(own.id)) {
        if (isActiveTask(task)) {
          await store.stop(own.id, task.id);
          await finished(store, own.id, task.id);
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, owner, owners, store };
}
async function finished(store: ManagedTaskStore, owner: string, id: string, timeout = 9000): Promise<ManagedTask> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const task = await store.get(owner, id);
    if (!isActiveTask(task)) return task;
    await delay(30);
  }
  assert.fail("managed task did not finish: " + id);
}
function directory(root: string, agentId: string, id: string) {
  return join(root, createHash("sha256").update(agentId).digest("hex"), id);
}

test("full output survives tail/filter queries, UTF-8 pages and a new store instance", async t => {
  const { store, owner, root } = await fixture(t);
  const task = await store.start(owner, { command: node("for(let i=0;i<3000;i++) console.log('第'+i+'行 '+(i%10===0?'ERROR':'OK')); console.error('stderr-marker');") });
  assert.equal((await finished(store, owner.id, task.id)).state, "completed");
  const raw = await readFile(join(directory(root, owner.id, task.id), "output.log"), "utf8");
  assert.equal((await stat(join(directory(root, owner.id, task.id), "output.log"))).mode & 0o777, 0o600);
  assert.ok(raw.includes("第0行 ERROR\n")); assert.ok(raw.includes("第2999行 OK\n")); assert.ok(raw.includes("stderr-marker"));
  assert.equal(raw.split("\n").length, 3002);
  const tail = await store.tail(owner.id, task.id, { tailLines: 5, filter: "ERROR" });
  assert.equal(tail.text.split("\n").length, 5);
  assert.ok(tail.text.split("\n").every(line => line.includes("ERROR")));
  assert.equal(await readFile(join(directory(root, owner.id, task.id), "output.log"), "utf8"), raw);
  let tailBefore: number | undefined, allTails = "";
  do {
    const part = await store.tail(owner.id, task.id, { tailLines: 17, before: tailBefore });
    allTails = part.text + (allTails ? "\n" + allTails : "");
    tailBefore = part.before;
  } while (tailBefore > 0);
  assert.equal(allTails + "\n", raw, "tail pagination must not skip lines cropped from the model response");
  const recovered = new ManagedTaskStore({ root });
  assert.equal((await recovered.get(owner.id, task.id)).exitCode, 0);
  let end: number | undefined, assembled = "";
  do {
    const page = await recovered.readLog(owner.id, task.id, { before: end, limit: 101 });
    assembled = page.text + assembled; end = page.start;
    assert.ok(!page.text.includes("�"));
  } while (end > 0);
  assert.equal(assembled, raw);
  let cursor = 0, forward = "";
  while (cursor < Buffer.byteLength(raw)) {
    const page = await store.readLog(owner.id, task.id, { after: cursor, limit: 97 });
    assert.ok(page.end > cursor); forward += page.text; cursor = page.end;
  }
  assert.equal(forward, raw);
  await assert.rejects(store.get("other-agent", task.id));
  await assert.rejects(store.readLog("other-agent", task.id));
  await assert.rejects(store.stop("other-agent", task.id));
  await assert.rejects(store.get(owner.id, "../../etc/passwd"));
  await assert.rejects(store.readLog(owner.id, task.id, { after: -1 }));
});

test("filtered commands are rejected before execution or task creation; retry keeps full live output", async t => {
  const { store, owner, root } = await fixture(t);
  const marker = join(root, "must-not-exist");
  const rejected = node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); console.log('line');`) + " 2>&1 | tail -1";
  await assert.rejects(store.start(owner, { command: rejected }), /task_start rejected.*task_logs/);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  assert.deepEqual(await store.list(owner.id), []);
  const command = node("for(let i=0;i<100;i++) console.log('early-'+i); console.error('live-stderr'); setTimeout(()=>console.log('late'),700);");
  const task = await store.start(owner, { command });
  let live = await store.readLog(owner.id, task.id);
  for (let attempt = 0; attempt < 30 && !live.text.includes('live-stderr'); attempt++) {
    await delay(10); live = await store.readLog(owner.id, task.id);
  }
  assert.equal(live.task.state, "running");
  assert.ok(live.text.includes("early-0\n"));
  assert.ok(live.text.includes("early-99\n"));
  assert.ok(live.text.includes("live-stderr\n"));
  assert.equal((await store.tail(owner.id, task.id, { tailLines: 1, filter: "early-" })).text, "early-99");
  await finished(store, owner.id, task.id);
  const full = await store.readLog(owner.id, task.id);
  assert.ok(full.text.startsWith("early-0\n"));
  assert.ok(full.text.endsWith("late\n"));
  assert.equal(full.task.command, command);
});

test("runner and task outlive the process that started them", async t => {
  const { root, owner, store } = await fixture(t);
  const source = `import {ManagedTaskStore} from ${JSON.stringify(join(process.cwd(), "server/managed.ts"))};
    const store=new ManagedTaskStore({root:${JSON.stringify(root)}});
    const task=await store.start(${JSON.stringify(owner)}, {command:${JSON.stringify(node("console.log('before'); setTimeout(()=>console.log('after'), 1200);"))}});
    console.log(task.id);`;
  const launcher = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(launcher, "exit");
  let output = "", errors = "";
  launcher.stdout!.on("data", value => { output += value; });
  launcher.stderr!.on("data", value => { errors += value; });
  const [code] = await exited;
  assert.equal(code, 0, errors);
  const id = output.trim();
  assert.equal((await store.get(owner.id, id)).state, "running");
  const done = await finished(store, owner.id, id);
  assert.equal(done.state, "completed");
  assert.equal((await store.readLog(owner.id, id)).text, "before\nafter\n");
});

test("group stop kills TERM-resistant descendants even after the shell leader exits", async t => {
  const { store, owner } = await fixture(t);
  const childSource = "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000);";
  const source = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:['ignore','inherit','inherit']}); setInterval(()=>{},1000);`;
  const task = await store.start(owner, { command: node(source) });
  let pid = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    pid = Number((await store.readLog(owner.id, task.id)).text.trim());
    if (pid) break;
    await delay(20);
  }
  assert.ok(pid > 0);
  assert.equal(await store.stop(owner.id, task.id), true);
  const done = await finished(store, owner.id, task.id);
  assert.equal(done.state, "stopped");
  assert.ok((await store.readLog(owner.id, task.id)).text.includes(String(pid)), "stopping preserves the captured output");
  const remaining = await readProcess(pid);
  assert.ok(!remaining || remaining.state === "Z" || remaining.state === "X");
  assert.equal(await store.stop(owner.id, task.id), false);
});

test("timeouts, log capacity and launch failures are explicit terminal states", async t => {
  const { store, owner } = await fixture(t, { maxLogBytes: 1024 });
  const timeout = await store.start(owner, { command: "sleep 60", timeoutSeconds: 1 });
  assert.equal((await finished(store, owner.id, timeout.id)).state, "timed_out");
  const huge = await store.start(owner, { command: node("setInterval(()=>process.stdout.write('x'.repeat(10000)),10)") });
  const limit = await finished(store, owner.id, huge.id);
  assert.equal(limit.state, "log_limit"); assert.equal(limit.logTruncated, true); assert.equal(limit.logBytes, 1024);
  const failed = await store.start(owner, { command: "printf 'failed\n' >&2; exit 7" });
  const done = await finished(store, owner.id, failed.id);
  assert.equal(done.state, "failed"); assert.equal(done.exitCode, 7);
  await assert.rejects(store.start(owner, { command: "true", cwd: "/definitely/missing/directory" }));
});

test("quota reservations prevent simultaneous starts and release unused capacity after stopping", async t => {
  const { store, owner } = await fixture(t, { maxLogBytes: 1024, totalLogBytes: 1024 });
  const starts = await Promise.allSettled([
    store.start(owner, { command: "sleep 60" }), store.start(owner, { command: "sleep 60" }),
  ]);
  assert.equal(starts.filter(result => result.status === "fulfilled").length, 1);
  const running = starts.find(result => result.status === "fulfilled") as PromiseFulfilledResult<ManagedTask>;
  await store.stop(owner.id, running.value.id); await finished(store, owner.id, running.value.id);
  assert.equal((await store.list(owner.id))[0].state, "stopped", "stopped task records remain available");
  const next = await store.start(owner, { command: "true" });
  assert.equal((await finished(store, owner.id, next.id)).state, "completed");
});

test("retention removes only completed tasks, and a killed runner reports unknown", async t => {
  const { store, owner, root } = await fixture(t);
  const old = await store.start(owner, { command: "true" }); await finished(store, owner.id, old.id);
  const oldFile = join(directory(root, owner.id, old.id), "task.json");
  const metadata = JSON.parse(await readFile(oldFile, "utf8"));
  metadata.endedAt = Date.now() - 8 * 86400_000;
  await writeFile(oldFile, JSON.stringify(metadata));
  const fresh = new ManagedTaskStore({ root });
  assert.deepEqual(await fresh.list(owner.id), []);
  const orphan = await store.start(owner, { command: "sleep 60" });
  const orphanFile = join(directory(root, owner.id, orphan.id), "task.json");
  const original = JSON.parse(await readFile(orphanFile, "utf8"));
  process.kill(original.runnerPid, "SIGKILL");
  await delay(100);
  original.createdAt = Date.now() - 10000;
  await writeFile(orphanFile, JSON.stringify(original));
  assert.equal((await fresh.get(owner.id, orphan.id)).state, "unknown");
  assert.equal(await fresh.stop(owner.id, orphan.id), true);
  await delay(100);
  assert.equal((await fresh.get(owner.id, orphan.id)).id, orphan.id, "recovery stop preserves the task record");
});

test("live UTF-8 fragments wait for complete characters and terminal fragments do not stall cursors", async t => {
  const { store, owner } = await fixture(t);
  const task = await store.start(owner, { command: node("const b=Buffer.from('中文');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),500);") });
  let partial;
  for (let attempt = 0; attempt < 20; attempt++) {
    partial = await store.readLog(owner.id, task.id, { after: 0 });
    if (partial.totalBytes) break;
    await delay(10);
  }
  assert.equal(partial?.text, ""); assert.equal(partial?.end, 0); assert.equal(partial?.totalBytes, 1);
  await finished(store, owner.id, task.id);
  assert.equal((await store.readLog(owner.id, task.id, { after: 0 })).text, "中文");
  const broken = await store.start(owner, { command: node("process.stdout.write(Buffer.from([0xe4]));") });
  await finished(store, owner.id, broken.id);
  const end = await store.readLog(owner.id, broken.id, { after: 0 });
  assert.equal(end.end, 1); assert.equal(end.totalBytes, 1);
  const huge = await store.start(owner, { command: node("console.log('中'.repeat(10000))") });
  await finished(store, owner.id, huge.id);
  const tail = await store.tail(owner.id, huge.id);
  assert.ok(Buffer.byteLength(tail.text) <= 16384);
  assert.ok(!tail.text.includes("�")); assert.equal(tail.displayTruncated, true);
});

test("the same attached tool definitions execute for Pi and Codex and isolate callers", async t => {
  const { store, owner, owners } = await fixture(t);
  const hooks = new Map<string, any>();
  const unregister = registerTaskTools({ addHook(name: string, handler: any) {
    hooks.set(name, handler); return () => { hooks.delete(name); };
  } } as unknown as PluginServerContext, store);
  const hook = hooks.get("agent.open.before");
  const create = hooks.get("agent.create.before");
  for (const provider of ["pi", "codex"]) {
    const agent = { ...owner, id: randomUUID(), provider, title: null, workspaceId: null, parentAgentId: null };
    owners.push(agent);
    const request = { provider, purpose: "interactive", tools: [] };
    const existingConfig = { provider, cwd: owner.cwd, systemPrompt: "Keep this existing instruction.", model: "test-model" };
    const creation = { config: existingConfig, env: { TEST_ENV: "preserved" } };
    const guided = await create({ request: creation });
    assert.equal(creation.config, existingConfig);
    assert.equal(existingConfig.systemPrompt, "Keep this existing instruction.");
    assert.equal(guided.env, creation.env);
    assert.equal(guided.config.model, "test-model");
    assert.ok(guided.config.systemPrompt.startsWith(`${existingConfig.systemPrompt}\n\n`));
    for (const text of ["task_start", "discovery/search", "mcp__paseo__task_start", "task_logs", "task_stop", "task_list", "Short commands", "sandbox", "exit code", "user's live logs", "npm test 2>&1 | tail -50", "Do not bypass rejection"]) {
      assert.ok(guided.config.systemPrompt.includes(text), text);
    }
    // The daemon persists config.systemPrompt for resume and may pass it to children.
    assert.equal(await create({ request: guided }), undefined);
    const fresh = await create({ request: { config: { provider, cwd: owner.cwd } } });
    assert.ok(fresh.config.systemPrompt.startsWith("[Paseo background-tasks]"));
    const attached = await hook({ request });
    assert.equal(attached.tools.length, 5);
    const tools = new Map<string, AgentToolDefinition>(attached.tools.map((tool: AgentToolDefinition) => [tool.name, tool]));
    const context = { agent, paseo: { agents: { ref: () => ({ refresh: async () => {}, current: () => ({ provider, status: "running" }) }) } } as any, signal: new AbortController().signal };
    const start = tools.get("task_start")!;
    await assert.rejects(async () => start.execute(start.input.parse({ command: "npm test | tail -20" }), context), /task_logs/);
    const result = await start.execute(start.input.parse({ command: "printf 'original output\n'" }), context);
    const task = (result.structuredContent as any).task;
    await finished(store, agent.id, task.id);
    const logs = tools.get("task_logs")!;
    const output = await logs.execute(logs.input.parse({ taskId: task.id }), context);
    assert.equal((output.structuredContent as any).text, "original output");
    await assert.rejects(async () => logs.execute(logs.input.parse({ taskId: task.id }), { ...context, agent: { ...agent, id: "someone-else" } }));
  }
  assert.equal(await hook({ request: { provider: "claude", purpose: "interactive", tools: [] } }), undefined);
  assert.equal(await hook({ request: { provider: "pi", purpose: "history", tools: [] } }), undefined);
  assert.equal(await create({ request: { config: { provider: "claude" } } }), undefined);
  assert.equal(await create({ request: { config: { provider: "pi", internal: true } } }), undefined);
  await unregister();
  assert.equal(hooks.size, 0);
});

test("display formatting and bounded windows preserve saved log data", () => {
  assert.equal(plainLog("\x1b[31mred\x1b[0m\r\n10%\r20%\n\x1b]0;title\x07hello"), "red\n20%\nhello");
  const task = { state: "completed" } as ManagedTask;
  const first = { text: "first", start: 0, end: LOG_WINDOW_BYTES, totalBytes: LOG_WINDOW_BYTES + 10, hasEarlier: false, task };
  const window = mergeLogPage(null, first, "replace");
  const second = { ...first, text: "second", start: LOG_WINDOW_BYTES, end: LOG_WINDOW_BYTES + 10 };
  const next = mergeLogPage(window, second, "after");
  assert.deepEqual(next.pages.map(page => page.text), ["second"]);
  assert.equal(next.start, LOG_WINDOW_BYTES);
  const polled = mergeLogPage(next, { ...second, text: "", start: second.end, end: second.end }, "after");
  assert.equal(polled.pages.length, 1);
  assert.equal(polled.pages, next.pages, "status-only polls should not rebuild a multi-megabyte log display");
});
