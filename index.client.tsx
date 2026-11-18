import type { PluginButtonRegistration, PluginClientContext, PluginButtonContentProps, PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { listTasks, stopTask, type Task } from "./shared/tasks";

import { TaskPopover, type TaskListState } from "./client/task-list";
import { deleteManagedTask, isActiveTask, listManagedTasks, readTaskLog, stopManagedTask, taskLogLocation, type ManagedTask } from "./shared/managed";
import { ManagedTaskPanel, type ReadLog } from "./client/managed-tasks";

export default function contribute(client: PluginClientContext) {
  let disposed = false;
  const states = new Map<string, TaskListState>();
  const pills = new Map<string, PluginButtonRegistration>();
  const listeners = new Set<() => void>();
  const agents = new Map<string, { id: string; workspaceId?: string; provider: string; archivedAt?: string | null }>();
  const pending = new Map<string, Promise<void>>();
  const selectedTasks = new Map<string, string>();
  const readLog: ReadLog = (input) => client.rpc(readTaskLog, input);

  function publish(agentId: string) {
    const state = states.get(agentId);
    const agent = agents.get(agentId);
    const pill = pills.get(agentId);
    const count = state ? state.tasks.length + state.managedTasks.filter(isActiveTask).length : 0;
    if (state && agent?.workspaceId && count > 0) {
      const label = state.error ? "后台任务 · !" : `后台任务 · ${count}`;
      if (pill) pill.update({ label });
      else pills.set(agentId, client.addComposerPill({ id: `tasks-${agentId}`, workspaceId: agent.workspaceId, agentId,
        button: { title: "后台任务", label, icon: "Terminal", behavior: { kind: "popover", Content: TaskList } } }));
    } else if (pill) { pill.remove(); pills.delete(agentId); }
    for (const listener of listeners) listener();
  }
  function refresh(agentId: string): Promise<void> {
    const existing = pending.get(agentId);
    if (existing) return existing;
    const request = (async () => {
      try {
        const [result, managed] = await Promise.all([client.rpc(listTasks, { agentId }), client.rpc(listManagedTasks, { agentId })]);
        if (!disposed && states.has(agentId)) states.set(agentId, { ...result, managedTasks: managed.tasks, retentionDays: managed.retentionDays, error: null, loading: false });
      } catch (error) {
        if (!disposed && states.has(agentId)) states.set(agentId, { ...states.get(agentId)!, loading: false, error: String(error) });
      } finally { pending.delete(agentId); if (!disposed) publish(agentId); }
    })();
    pending.set(agentId, request);
    return request;
  }

  function useActions(agentId: string | null) {
    const [, render] = useState(0);
    const [stopping, setStopping] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
      if (!agentId) return;
      const update = () => render(value => value + 1);
      listeners.add(update); void refresh(agentId);
      return () => { listeners.delete(update); };
    }, [agentId]);
    async function stop(task: Task | ManagedTask) {
      if (!agentId) return;
      setStopping("id" in task ? task.id : task.token); setError(null);
      try {
        if ("id" in task) await client.rpc(stopManagedTask, { agentId, taskId: task.id });
        else await client.rpc(stopTask, { agentId, token: task.token });
        await refresh(agentId);
      } catch (err) { setError(String(err)); }
      finally { setStopping(null); }
    }
    return { stopping, error, stop };
  }

  function TaskList(props: PluginButtonContentProps) {
    const agentId = props.context === "agent" ? props.agentId : null;
    const { stopping, error, stop } = useActions(agentId);
    if (!agentId) return null;
    const state = states.get(agentId);
    return <TaskPopover state={state} theme={props.theme} compact={props.layout.compact}
      stopping={stopping} actionError={error} onRefresh={() => refresh(agentId)} onStop={(task) => void stop(task)}
      onStopManaged={task => void stop(task)} onOpenLogs={taskId => {
        if (taskId) selectedTasks.set(agentId, taskId);
        publish(agentId); props.close();
        client.openPanel("task-logs", { workspaceId: props.workspaceId, agentId, location: "explorer" });
      }} />;
  }

  function TaskPanel(props: PluginAgentPanelProps) {
    const agentId = props.params.agentId;
    const { stopping, error, stop } = useActions(agentId);
    const state = states.get(agentId);
    const savedId = props.tab.state && typeof props.tab.state === "object" && "taskId" in props.tab.state && typeof props.tab.state.taskId === "string" ? props.tab.state.taskId : null;
    return <ManagedTaskPanel agentId={agentId} tasks={state?.managedTasks ?? []} theme={props.theme}
      compact={props.layout.compact}
      selectedId={selectedTasks.get(agentId) ?? savedId} stopping={stopping}
      loading={!state || state.loading} error={error || state?.error} retentionDays={state?.retentionDays ?? 7}
      onSelect={id => {
        if (id) { selectedTasks.set(agentId, id); props.tab.setState({ taskId: id }); }
        else { selectedTasks.delete(agentId); props.tab.setState({}); }
        publish(agentId);
      }}
      onStop={task => void stop(task)} onRefresh={() => void refresh(agentId)} readLog={readLog}
      logLocation={async taskId => (await client.rpc(taskLogLocation, { agentId, taskId })).path}
      onDelete={async task => {
        await client.rpc(deleteManagedTask, { agentId, taskId: task.id });
        selectedTasks.delete(agentId); props.tab.setState({}); await refresh(agentId);
      }} />;
  }
  const removePanel = client.addAgentPanel({ id: "task-logs", title: "后台任务与日志", icon: "Terminal", locations: ["explorer"], Component: TaskPanel });
  const removeCommand = client.addCommandCenterItem({ id: "task-logs", context: "agent", title: "后台任务与历史日志", icon: "Terminal",
    onSelect(context) { context.openPanel("task-logs", { location: "explorer" }); } });

  function reconcile() {
    if (disposed) return;
    for (const [id] of states) {
      const agent = agents.get(id);
      if (!agent?.workspaceId || !["codex", "pi"].includes(agent.provider) || agent.archivedAt) {
        pills.get(id)?.remove(); pills.delete(id); states.delete(id); selectedTasks.delete(id);
      }
    }
    for (const agent of agents.values()) {
      if (!agent.workspaceId || !["codex", "pi"].includes(agent.provider) || agent.archivedAt || states.has(agent.id)) continue;
      states.set(agent.id, { tasks: [], managedTasks: [], retentionDays: 7, error: null, supported: true, loading: true });
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
  const timer = setInterval(() => { for (const id of states.keys()) void refresh(id); }, 2000);
  return async () => { disposed = true; clearInterval(timer); removePanel(); removeCommand(); for (const pill of pills.values()) pill.remove(); (await subscription)?.(); listeners.clear(); };
}
