import type { PluginButtonRegistration, PluginClientContext, PluginButtonContentProps, PluginAgentPanelProps, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";

import { TaskPopover, type TaskListState } from "./client/task-list";
import { deleteManagedTask, listManagedTasks, readTaskLog, stopManagedTask, taskLogLocation, type ManagedTask } from "./shared/managed";
import { TaskLogSidebar, type ReadLog } from "./client/managed-tasks";
import { CompletionNotice, completionNoticeSchema } from "./client/completion-notice";
import { completionNoticeKind, transformCompletionNotice } from "./client/completion-transform";
import { taskPillPresentation } from "./client/task-presentation";

// The SDK requires an icon field; render no element for a text-only pill.
function NoPillIcon() { return null; }

export default function contribute(client: PluginClientContext) {
  const removeNoticeRenderer = client.addTimelineRenderer({ kind: completionNoticeKind, version: 1, schema: completionNoticeSchema, Component: TaskCompletion });
  const removeNoticeTransformer = client.addTimelineTransformer({ id: "background-task-completion", query: { itemType: "user_message" }, transform: ({ item }) => transformCompletionNotice(item) });
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
    if (state && agent?.workspaceId && state.managedTasks.length > 0) {
      const { label } = taskPillPresentation(state.managedTasks, !!state.error);
      const presentation = { label };
      if (pill) pill.update(presentation);
      else pills.set(agentId, client.addComposerPill({ id: `tasks-${agentId}`, workspaceId: agent.workspaceId, agentId,
        button: { title: "后台任务", icon: NoPillIcon, ...presentation, behavior: { kind: "popover", Content: TaskList } } }));
    } else if (pill) { pill.remove(); pills.delete(agentId); }
    for (const listener of listeners) listener();
  }
  function refresh(agentId: string): Promise<void> {
    const existing = pending.get(agentId);
    if (existing) return existing;
    const request = (async () => {
      try {
        const managed = await client.rpc(listManagedTasks, { agentId });
        if (!disposed && states.has(agentId)) states.set(agentId, { managedTasks: managed.tasks, retentionDays: managed.retentionDays, supported: managed.supported, error: null, loading: false });
      } catch (error) {
        if (!disposed && states.has(agentId)) states.set(agentId, { ...states.get(agentId)!, loading: false, error: String(error) });
      } finally { pending.delete(agentId); if (!disposed) publish(agentId); }
    })();
    pending.set(agentId, request);
    return request;
  }

  function openLogs(agentId: string, taskId: string) {
    const agent = agents.get(agentId);
    if (!agent?.workspaceId) return;
    selectedTasks.set(agentId, taskId);
    publish(agentId);
    client.openPanel("task-logs", { workspaceId: agent.workspaceId, agentId, location: "explorer" });
  }

  function TaskCompletion(props: PluginTimelineItemProps<{ taskIds: string[] }>) {
    useActions(props.agentId);
    const state = states.get(props.agentId);
    return <CompletionNotice taskIds={props.item.data.taskIds} tasks={state?.managedTasks ?? []}
      theme={props.theme} compact={props.layout.compact} loading={!state || state.loading} error={state?.error}
      onOpen={taskId => openLogs(props.agentId, taskId)} onRetry={() => void refresh(props.agentId)} />;
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
    async function stop(task: ManagedTask) {
      if (!agentId) return;
      setStopping(task.id); setError(null);
      try {
        await client.rpc(stopManagedTask, { agentId, taskId: task.id });
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
      stopping={stopping} actionError={error} onRefresh={() => refresh(agentId)}
      onStopManaged={task => void stop(task)} onOpenLogs={taskId => {
        props.close(); openLogs(agentId, taskId);
      }} />;
  }

  function TaskLog(props: PluginAgentPanelProps) {
    const agentId = props.params.agentId;
    const { stopping, error, stop } = useActions(agentId);
    const state = states.get(agentId);
    const savedId = props.tab.state && typeof props.tab.state === "object" && "taskId" in props.tab.state && typeof props.tab.state.taskId === "string" ? props.tab.state.taskId : null;
    const taskId = selectedTasks.get(agentId) ?? savedId;
    useEffect(() => { if (taskId) props.tab.setState({ taskId }); }, [taskId]);
    return <TaskLogSidebar agentId={agentId} task={state?.managedTasks.find(task => task.id === taskId)} theme={props.theme}
      compact={props.layout.compact}
      stopping={stopping} loading={!state || state.loading} error={error || state?.error}
      onStop={task => void stop(task)} onRefresh={() => void refresh(agentId)} readLog={readLog}
      logLocation={async taskId => (await client.rpc(taskLogLocation, { agentId, taskId })).path}
      onDelete={async task => {
        await client.rpc(deleteManagedTask, { agentId, taskId: task.id });
        selectedTasks.delete(agentId); props.tab.setState({}); await refresh(agentId);
      }} />;
  }
  const removeLog = client.addAgentPanel({ id: "task-logs", title: "任务日志", icon: "Terminal", locations: ["explorer"], Component: TaskLog });

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
      states.set(agent.id, { managedTasks: [], error: null, supported: true, loading: true });
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
  return async () => { disposed = true; clearInterval(timer); removeLog(); removeNoticeTransformer(); removeNoticeRenderer(); for (const pill of pills.values()) pill.remove(); (await subscription)?.(); listeners.clear(); };
}
