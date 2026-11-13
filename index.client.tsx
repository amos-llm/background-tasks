import type { PluginButtonRegistration, PluginClientContext, PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { listTasks, stopTask, type Task } from "./shared/tasks";

import { TaskPopover, type TaskListState } from "./client/task-list";

export default function contribute(client: PluginClientContext) {
  let disposed = false;
  const states = new Map<string, TaskListState>();
  const pills = new Map<string, PluginButtonRegistration>();
  const listeners = new Set<() => void>();
  const agents = new Map<string, { id: string; workspaceId?: string; provider: string; archivedAt?: string | null }>();
  const pending = new Map<string, Promise<void>>();

  function publish(agentId: string) {
    const state = states.get(agentId);
    if (state) pills.get(agentId)?.update({ label: state.error ? "后台任务 · !" : `后台任务 · ${state.tasks.length}` });
    for (const listener of listeners) listener();
  }
  function refresh(agentId: string): Promise<void> {
    const existing = pending.get(agentId);
    if (existing) return existing;
    const request = (async () => {
      try {
        const result = await client.rpc(listTasks, { agentId });
        if (!disposed && agents.has(agentId)) states.set(agentId, { ...result, error: null, loading: false });
      } catch (error) {
        if (!disposed && agents.has(agentId)) states.set(agentId, { ...(states.get(agentId) ?? { tasks: [], supported: true }), loading: false, error: String(error) });
      } finally { pending.delete(agentId); if (!disposed) publish(agentId); }
    })();
    pending.set(agentId, request);
    return request;
  }

  function TaskList(props: PluginButtonContentProps) {
    const agentId = props.context === "agent" ? props.agentId : null;
    const [, render] = useState(0);
    const [stopping, setStopping] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
      if (!agentId) return;
      const update = () => render((value) => value + 1);
      listeners.add(update); void refresh(agentId);
      return () => { listeners.delete(update); };
    }, [agentId]);
    if (!agentId) return null;
    const state = states.get(agentId);
    async function stop(task: Task) {
      setStopping(task.token); setError(null);
      try { await client.rpc(stopTask, { agentId: agentId!, token: task.token }); await refresh(agentId!); }
      catch (err) { setError(String(err)); }
      finally { setStopping(null); }
    }
    return <TaskPopover state={state} theme={props.theme} compact={props.layout.compact}
      stopping={stopping} actionError={error} onRefresh={() => refresh(agentId)} onStop={(task) => void stop(task)} />;
  }

  function reconcile() {
    if (disposed) return;
    for (const [id, pill] of pills) if (!agents.has(id)) { pill.remove(); pills.delete(id); states.delete(id); }
    for (const agent of agents.values()) {
      if (!agent.workspaceId || !["codex", "pi"].includes(agent.provider) || agent.archivedAt || pills.has(agent.id)) continue;
      states.set(agent.id, { tasks: [], error: null, supported: true, loading: true });
      pills.set(agent.id, client.addComposerPill({ id: `tasks-${agent.id}`, workspaceId: agent.workspaceId, agentId: agent.id,
        button: { title: "后台任务", label: "后台任务 · …", icon: "Terminal", behavior: { kind: "popover", Content: TaskList } } }));
      void refresh(agent.id);
    }
  }
  const subscription = client.paseo.agents.list({ includeBackground: true, subscribe: {} }).then((result) => {
    if (disposed) { void result.subscription.release(); return; }
    const load = (entries: typeof result.entries) => { agents.clear(); for (const { agent } of entries) agents.set(agent.id, agent); reconcile(); };
    load(result.entries);
    const unsubscribe = result.subscription.subscribe({ snapshot: (value) => load(value.entries), update: (message) => {
      if (message.type === "agent_update") {
        if (message.payload.kind === "remove") agents.delete(message.payload.agentId);
        else { const agent = message.payload.agent; if (agent.archivedAt) agents.delete(agent.id); else agents.set(agent.id, agent); }
        reconcile();
      }
    } });
    return () => { unsubscribe(); void result.subscription.release(); };
  }).catch((error) => console.error("Background task subscription failed", error));
  const timer = setInterval(() => { for (const id of pills.keys()) void refresh(id); }, 2000);
  return async () => { disposed = true; clearInterval(timer); for (const pill of pills.values()) pill.remove(); (await subscription)?.(); listeners.clear(); };
}
