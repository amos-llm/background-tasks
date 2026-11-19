import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { isActiveTask, managedTaskSchema, taskIdSchema, type LogPage, type ManagedTask, type taskStartInput } from "../shared/managed";
import { readProcess, snapshot } from "./processes";
import { runnerSource } from "./runner";

const recordSchema = managedTaskSchema.omit({ logBytes: true, notificationStatus: true }).extend({
  agentId: z.string(), runnerPid: z.number().nullable(), runnerStart: z.string().nullable(),
  start: z.string().nullable(), timeoutSeconds: z.number().optional(), maxLogBytes: z.number(),
  stopReason: z.string().nullable(),
  // Old records predate automatic notifications and must never wake an agent retroactively.
  notifyOnExit: z.boolean().default(false),
});
type Record = z.infer<typeof recordSchema>;
export interface TaskOwner { id: string; provider: string; cwd: string }
type StartOptions = z.input<typeof taskStartInput>;
export interface TaskCompletion { agentId: string; task: ManagedTask }
export interface StoreOptions {
  root?: string; maxLogBytes?: number; totalLogBytes?: number; retentionDays?: number; maxConcurrent?: number;
}
function configured(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function agentKey(agentId: string) { return createHash("sha256").update(agentId).digest("hex"); }
function publicTask(record: Record, logBytes: number): ManagedTask {
  return managedTaskSchema.parse({ ...record, logBytes });
}
function utf8End(buffer: Buffer) {
  if (!buffer.length) return 0;
  let last = buffer.length - 1;
  while (last >= 0 && (buffer[last] & 0xc0) === 0x80) last--;
  if (last < 0) return buffer.length;
  const byte = buffer[last];
  const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return buffer.length - last < needed ? last : buffer.length;
}

export class ManagedTaskStore {
  readonly root: string;
  readonly retentionDays: number;
  private readonly maxLogBytes: number;
  private readonly totalLogBytes: number;
  private readonly maxConcurrent: number;
  private queue: Promise<unknown> = Promise.resolve();
  private cleanedAt = 0;

  constructor(options: StoreOptions = {}) {
    this.root = resolve(options.root ?? process.env.BACKGROUND_TASKS_DATA_DIR ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "background-tasks"));
    this.maxLogBytes = options.maxLogBytes ?? configured("BACKGROUND_TASKS_MAX_LOG_BYTES", 100 * 1024 * 1024);
    this.totalLogBytes = options.totalLogBytes ?? configured("BACKGROUND_TASKS_TOTAL_LOG_BYTES", 1024 * 1024 * 1024);
    this.retentionDays = options.retentionDays ?? configured("BACKGROUND_TASKS_RETENTION_DAYS", 7);
    this.maxConcurrent = options.maxConcurrent ?? configured("BACKGROUND_TASKS_MAX_CONCURRENT", 8);
  }
  private directory(agentId: string, id: string) {
    taskIdSchema.parse(id);
    return join(this.root, agentKey(agentId), id);
  }
  private async record(agentId: string, id: string): Promise<Record> {
    try {
      const record = recordSchema.parse(JSON.parse(await readFile(join(this.directory(agentId, id), "task.json"), "utf8")));
      if (record.agentId !== agentId || record.id !== id) throw new Error("任务归属不匹配");
      return record;
    } catch (error) {
      if (missing(error)) throw new Error("任务不存在或日志已过保留期限");
      throw error;
    }
  }
  private async entries(agentId?: string): Promise<Record[]> {
    let agents: string[];
    try { agents = agentId ? [agentKey(agentId)] : (await readdir(this.root)).filter(name => /^[a-f0-9]{64}$/.test(name)); }
    catch (error) { if (missing(error)) return []; throw error; }
    const records: Record[] = [];
    for (const key of agents) {
      let ids: string[];
      try { ids = await readdir(join(this.root, key)); }
      catch (error) { if (missing(error)) continue; throw error; }
      for (const id of ids) {
        if (!taskIdSchema.safeParse(id).success) continue;
        try {
          const entry = recordSchema.parse(JSON.parse(await readFile(join(this.root, key, id, "task.json"), "utf8")));
          if (entry.id === id && agentKey(entry.agentId) === key && (!agentId || entry.agentId === agentId)) records.push(entry);
        } catch (error) { if (!missing(error)) throw new Error(`任务记录损坏 (${id}): ${String(error)}`); }
      }
    }
    return records;
  }
  private async bytes(record: Record) {
    try { return (await stat(join(this.directory(record.agentId, record.id), "output.log"))).size; }
    catch (error) { if (missing(error)) return 0; throw error; }
  }
  private async view(record: Record): Promise<ManagedTask> {
    const result = publicTask(record, await this.bytes(record));
    result.notificationStatus = await this.notificationStatus(record);
    if (isActiveTask(result)) {
      const runner = record.runnerPid ? await readProcess(record.runnerPid) : null;
      const alive = runner && runner.start === record.runnerStart && runner.managedTaskId === record.id && runner.agentId === record.agentId && runner.state !== "Z" && runner.state !== "X";
      if (!alive && Date.now() - record.createdAt > 5000) {
        // The runner may have finalized the metadata between our read and its exit.
        const latest = await this.record(record.agentId, record.id);
        if (!isActiveTask(latest)) return this.view(latest);
        result.state = "unknown";
        result.logTruncated = true;
        result.error = "任务 runner 已退出，日志采集可能中断，无法确认退出码；已保存日志仍可查看";
      }
    }
    return result;
  }
  async cleanup() {
    if (Date.now() - this.cleanedAt < 60_000) return;
    this.cleanedAt = Date.now();
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    for (const record of await this.entries()) {
      if (!isActiveTask(record) && record.endedAt !== null && record.endedAt < cutoff) {
        await rm(this.directory(record.agentId, record.id), { recursive: true, force: true });
      }
    }
  }
  async list(agentId: string) {
    await this.cleanup();
    const records = await this.entries(agentId);
    const tasks = await Promise.all(records.map(record => this.view(record)));
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }
  async get(agentId: string, taskId: string) { return this.view(await this.record(agentId, taskId)); }

  private async notificationStatus(record: Record): Promise<NonNullable<ManagedTask["notificationStatus"]>> {
    if (!record.notifyOnExit) return "disabled";
    try {
      return z.enum(["delivered", "cancelled"]).parse(JSON.parse(await readFile(join(this.directory(record.agentId, record.id), "notification.json"), "utf8")).status);
    } catch (error) { if (missing(error)) return "pending"; throw error; }
  }
  async pendingCompletions(agentId?: string): Promise<TaskCompletion[]> {
    const pending: TaskCompletion[] = [];
    for (const record of await this.entries(agentId)) {
      if (!record.notifyOnExit || record.stopReason === "user") continue;
      const task = await this.view(record);
      if (!isActiveTask(task) && task.notificationStatus === "pending") pending.push({ agentId: record.agentId, task });
    }
    return pending.sort((a, b) => a.task.createdAt - b.task.createdAt || a.task.id.localeCompare(b.task.id));
  }
  async settleNotification(agentId: string, id: string, status: "delivered" | "cancelled") {
    await this.record(agentId, id);
    // A separate, write-once receipt cannot be overwritten by the independent runner.
    // In particular, a cancellation wins over a later delivery acknowledgement.
    const directory = this.directory(agentId, id);
    const temporary = join(directory, `.notification-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ status, at: Date.now() }), { mode: 0o600, flag: "wx" });
      // Publish the complete receipt atomically without replacing a competing receipt.
      try { await link(temporary, join(directory, "notification.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await rm(temporary, { force: true }); }
  }
  async cancelNotifications(agentId: string, before = Date.now()) {
    for (const record of await this.entries(agentId)) {
      if (record.notifyOnExit && record.createdAt <= before) await this.settleNotification(agentId, record.id, "cancelled");
    }
  }

  start(owner: TaskOwner, input: StartOptions): Promise<ManagedTask> {
    const request = this.queue.then(() => this.startUnlocked(owner, input));
    this.queue = request.catch(() => {});
    return request;
  }
  private async startUnlocked(owner: TaskOwner, input: StartOptions) {
    if (process.platform !== "linux") throw new Error("受管后台任务需要 Linux 主机");
    if (owner.provider !== "codex" && owner.provider !== "pi") throw new Error("仅支持 Codex 和 Pi 会话");
    const cwd = await realpath(resolve(owner.cwd, input.cwd ?? "."));
    if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不存在");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.cleanup();
    const records = await this.entries();
    const views = await Promise.all(records.map(record => this.view(record)));
    const active = views.filter(isActiveTask);
    if (active.length >= this.maxConcurrent) throw new Error(`最多同时运行 ${this.maxConcurrent} 个受管任务`);
    // Reserve the whole allowance for running tasks so simultaneous jobs cannot exhaust the budget.
    let reserved = this.maxLogBytes;
    for (let index = 0; index < records.length; index++) reserved += isActiveTask(views[index]) ? records[index].maxLogBytes : views[index].logBytes;
    if (reserved > this.totalLogBytes) throw new Error("后台任务日志配额不足；请等待已结束日志过期清理或增加配额");
    const id = randomUUID();
    const dir = this.directory(owner.id, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const record: Record = {
      id, agentId: owner.id, provider: owner.provider, command: input.command, cwd,
      label: input.label, instruction: input.instruction, notifyOnExit: input.notifyOnExit ?? true,
      state: "starting", createdAt: Date.now(), endedAt: null, pid: null, start: null,
      runnerPid: null, runnerStart: null, exitCode: null, exitSignal: null,
      maxLogBytes: this.maxLogBytes, timeoutSeconds: input.timeoutSeconds,
      logTruncated: false, error: null, stopReason: null,
    };
    await writeFile(join(dir, "task.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
    // Versioned runner filenames let active jobs survive installing a newer plugin bundle.
    const hash = createHash("sha256").update(runnerSource).digest("hex").slice(0, 16);
    const runnerPath = join(this.root, `runner-${hash}.cjs`);
    const runnerTemp = `${runnerPath}.${randomUUID()}.tmp`;
    await writeFile(runnerTemp, runnerSource, { mode: 0o600, flag: "wx" });
    await rename(runnerTemp, runnerPath);
    const child = spawn(process.execPath, [runnerPath, dir], { detached: true, stdio: "ignore",
      env: { ...process.env, PASEO_AGENT_ID: owner.id, PASEO_MANAGED_TASK_ID: id, CODEX_THREAD_ID: "", CODEX_TOOL_CALL_ID: "" } });
    const started = new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    try {
      await started;
      for (let retry = 0; retry < 150; retry++) {
        const latest = await this.record(owner.id, id);
        if (latest.state !== "starting") return this.view(latest);
        await delay(20);
      }
      throw new Error("后台任务 runner 启动超时，请在任务面板检查状态");
    } catch (error) {
      // Do not overwrite a runner that actually started while startup was timing out.
      if (!child.pid) {
        record.state = "error"; record.error = String(error); record.endedAt = Date.now();
        const temp = join(dir, "failed.json");
        await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
        await rename(temp, join(dir, "task.json"));
      }
      throw error;
    }
  }
  async stop(agentId: string, id: string) {
    const record = await this.record(agentId, id);
    await this.settleNotification(agentId, id, "cancelled");
    if (!isActiveTask(record) && record.state !== "unknown") return false;
    const runner = record.runnerPid ? await readProcess(record.runnerPid) : null;
    if (runner && runner.start === record.runnerStart && runner.managedTaskId === id && runner.agentId === agentId && runner.state !== "Z" && runner.state !== "X") {
      await writeFile(join(this.directory(agentId, id), "stop"), "stop\n", { mode: 0o600 });
      return true;
    }
    // Recovery when a runner was killed: only act on members bearing this task's identity.
    if (!record.pid || !record.start) return false;
    const members = (await snapshot()).filter(p => p.group === record.pid && p.state !== "Z" && p.state !== "X");
    if (!members.length || members.some(p => Number(p.start) < Number(record.start))) return false;
    const verified = await Promise.all(members.map(async p =>
      (await readFile(`/proc/${p.pid}/environ`, "utf8").catch(() => "")).split("\0").includes(`PASEO_MANAGED_TASK_ID=${id}`)));
    if (!verified.every(Boolean)) throw new Error("进程身份发生变化，无法安全终止");
    try { process.kill(-record.pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    await delay(3000);
    const remaining = (await snapshot()).filter(p => p.group === record.pid && p.state !== "Z" && p.state !== "X");
    if (remaining.length && remaining.some(p => members.some(old => old.pid === p.pid && old.start === p.start))) {
      const stillOwned = await Promise.all(remaining.map(async p =>
        (await readFile(`/proc/${p.pid}/environ`, "utf8").catch(() => "")).split("\0").includes(`PASEO_MANAGED_TASK_ID=${id}`)));
      if (!stillOwned.every(Boolean)) throw new Error("进程身份发生变化，未升级终止信号");
      try { process.kill(-record.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    return true;
  }
  async logLocation(agentId: string, id: string) {
    await this.record(agentId, id);
    return join(this.directory(agentId, id), "output.log");
  }
  async readLog(agentId: string, id: string, options: { before?: number; after?: number; limit?: number } = {}): Promise<LogPage> {
    const record = await this.record(agentId, id);
    const task = await this.view(record);
    const size = task.logBytes;
    const limit = Math.min(65536, Math.max(4, options.limit ?? 32768));
    if (options.before !== undefined && options.after !== undefined) throw new Error("只能使用一个日志游标");
    const cursor = options.after ?? options.before;
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > size)) throw new Error("日志游标超出范围，请重新打开日志");
    const end = options.after === undefined ? options.before ?? size : Math.min(size, options.after + limit);
    let start = options.after ?? Math.max(0, end - limit);
    if (end <= start) return { text: "", start, end, totalBytes: size, hasEarlier: start > 0, task };
    const file = await open(join(this.directory(agentId, id), "output.log"), "r");
    try {
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      let offset = 0;
      if (start > 0) while (offset < bytesRead && (buffer[offset] & 0xc0) === 0x80) offset++;
      start += offset;
      const data = buffer.subarray(offset, bytesRead);
      const length = end === size && !isActiveTask(task) ? data.length : utf8End(data);
      return { text: data.subarray(0, length).toString("utf8"), start, end: start + length,
        totalBytes: size, hasEarlier: start > 0, task };
    } finally { await file.close(); }
  }
  async tail(agentId: string, id: string, options: { tailLines?: number; filter?: string; before?: number } = {}) {
    const page = await this.readLog(agentId, id, { before: options.before, limit: 65536 });
    const lines = page.text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    let position = page.start;
    const entries = lines.map(text => {
      const entry = { text, start: position, bytes: Buffer.byteLength(text) };
      position += entry.bytes + 1;
      return entry;
    }).filter(entry => !options.filter || entry.text.includes(options.filter));
    const selected = entries.slice(-(options.tailLines ?? 20));
    let selectedBytes = selected.reduce((total, entry) => total + entry.bytes + 1, -1);
    while (selected.length > 1 && selectedBytes > 16384) selectedBytes -= selected.shift()!.bytes + 1;
    // Clip a single enormous line on a character boundary, keeping a cursor for its omitted prefix.
    const bytes = Buffer.from(selected.map(entry => entry.text).join("\n"));
    let offset = Math.max(0, bytes.length - 16384);
    while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
    const text = bytes.subarray(offset).toString("utf8");
    const before = selected.length ? selected[0].start + offset : page.start;
    return { task: page.task, text, before, hasEarlier: before > 0,
      scannedStart: page.start, scannedEnd: page.end, scannedBytes: page.end - page.start,
      displayTruncated: bytes.length > 16384 || selected.length < entries.length,
      note: "Only the latest 64 KiB page was searched. Use before to read older output; filtering never changes the saved log." };
  }
}
