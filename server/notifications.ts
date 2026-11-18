import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { isActiveTask } from "../shared/managed";
import { ManagedTaskStore } from "./managed";

type Paseo = PluginHandlerContext["paseo"];
export class TaskCompletionNotifier {
  private paseo?: Paseo;
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private disposed = false;
  private readonly held = new Map<string, number>();
  private readonly retries = new Map<string, { attempts: number; after: number }>();

  constructor(private readonly store: ManagedTaskStore, private readonly onError: (error: unknown) => void = error => console.error("Background task notification failed", error)) {}

  connect(paseo: Paseo) {
    if (this.disposed) return;
    this.paseo = paseo;
    this.schedule(25);
  }

  // Do not wake an owner before its task_start tool has returned its initial result.
  hold(agentId: string) {
    this.held.set(agentId, (this.held.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.held.get(agentId) ?? 1) - 1;
      if (count) this.held.set(agentId, count); else this.held.delete(agentId);
    };
  }

  private schedule(delay: number) {
    if (this.disposed || this.timer || !this.paseo) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().finally(() => this.schedule(1000));
    }, delay);
    this.timer.unref();
  }

  flush(): Promise<void> {
    if (this.disposed || !this.paseo) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver(this.paseo).catch(this.onError).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async deliver(paseo: Paseo) {
    const groups = new Map<string, Awaited<ReturnType<ManagedTaskStore["pendingCompletions"]>>>();
    for (const completion of await this.store.pendingCompletions()) {
      const group = groups.get(completion.agentId) ?? [];
      group.push(completion); groups.set(completion.agentId, group);
    }
    for (const [agentId, completions] of groups) {
      if (this.disposed) return;
      if (this.held.has(agentId) || (this.retries.get(agentId)?.after ?? 0) > Date.now()) continue;
      try {
        const agent = paseo.agents.ref(agentId);
        await agent.refresh();
        const current = agent.current();
        if (current?.archivedAt) { await this.store.cancelNotifications(agentId); continue; }
        if (!current || !["codex", "pi"].includes(current.provider) || current.status !== "idle" || current.activeTurn || current.pendingPermissions?.length) continue;
        const events: { eventId: string; taskId: string }[] = [];
        for (const { task } of completions) {
          const current = await this.store.get(agentId, task.id);
          if (current.notificationStatus !== "pending" || isActiveTask(current)) continue;
          events.push({ eventId: `task-completed:${task.id}`, taskId: task.id });
          if (events.length === 8) break;
        }
        if (!events.length || this.disposed || this.held.has(agentId)) continue;
        // Refresh again after reading logs. The non-interrupting mode also guards
        // the race where a user starts a turn just after this snapshot.
        await agent.refresh();
        const latest = agent.current();
        if (!latest || latest.archivedAt || latest.status !== "idle" || latest.activeTurn || latest.pendingPermissions?.length || this.disposed) continue;
        const ready = [];
        for (const event of events) {
          if ((await this.store.get(agentId, event.taskId)).notificationStatus === "pending") ready.push(event);
        }
        if (!ready.length || this.disposed) continue;
        const messageId = `background-tasks:${createHash("sha256").update(ready.map(event => event.eventId).join("\n")).digest("hex")}`;
        await agent.send(`后台任务已完成：${ready.map(event => event.taskId).join(", ")}。请用 task_status 获取结果和指令，按指令继续；需要输出时使用 task_logs。`, { messageId, activeTurnBehavior: "steer" });
        for (const event of ready) {
          await this.store.settleNotification(agentId, event.taskId, "delivered").catch(this.onError);
        }
        this.retries.delete(agentId);
      } catch (error) {
        const attempts = Math.min((this.retries.get(agentId)?.attempts ?? 0) + 1, 6);
        this.retries.set(agentId, { attempts, after: Date.now() + Math.min(60000, 1000 * 2 ** (attempts - 1)) });
        this.onError(error);
      }
    }
  }

  async dispose() {
    this.disposed = true;
    clearTimeout(this.timer); this.timer = undefined;
    await this.flushing;
  }
}
