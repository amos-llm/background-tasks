import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import contribute from "../index.client";

const mode = new URLSearchParams(location.search).get("mode");
const colors = { foreground: "#e7e9ef", foregroundMuted: "#9098aa", border: "#333b4b", surface1: "#171c26", surface2: "#252d3c", accent: "#88b4ff", statusSuccess: "#7bdba3", statusWarning: "#f0c674", statusDanger: "#ff7b87" };
const task = {
  id: "506e44f1-0f0c-4a8e-a6ac-ed03b8d340be", provider: "pi",
  command: "printf '=== 日志演示开始 ===\\n'; for i in {1..60}; do printf '[%s] INFO 进度 %02d/60\\n' \"$(date '+%H:%M:%S')\" \"$i\"; sleep 1; done; printf '=== 任务完成 ===\\n'",
  cwd: "/home/ubuntu/background-tasks", state: mode === "ended" ? "completed" : "running", createdAt: Date.now() - 17000,
  endedAt: mode === "ended" ? Date.now() : null, pid: 100, exitCode: mode === "ended" ? 0 : null, exitSignal: null,
  logBytes: 40000, logTruncated: false, error: null,
};
const second = { ...task, id: "e24c2613-f14b-463b-9def-880fc8d37204", command: "npm run dev -- --port 3000", label: "开发服务", instruction: "检查服务退出原因。" };
if (mode === "failed") { task.state = "failed"; task.endedAt = Date.now(); task.exitCode = 1; task.label = "运行测试"; second.state = "completed"; second.endedAt = Date.now(); second.exitCode = 0; }
if (mode === "started") { task.label = "运行测试"; task.command = "npm test"; }
const startResult = { structuredContent: { task: { ...task } } };
const tasks = mode === "external-only" || mode === "missing" ? [] : [task, second, { ...task, label: "历史任务", id: "8bad3d3d-5191-473e-af32-54051b5dc022", command: "completed-history-task", state: "completed", endedAt: Date.now(), exitCode: 0 }];
const agent = { id: "test", workspaceId: "workspace", provider: "pi" };
let update = () => {}, pill = null, log = null, popoverOpen = false, sidebarOpen = mode === "restore";
const renderers = new Map(), transformers = new Map();
const tab = { state: mode === "restore" ? { taskId: second.id } : {}, setState(state) { this.state = state; } };
window.uiTest = { rpcCalls: [], requests: [], opens: [], commands: [], copied: null, taskId: task.id, secondId: second.id, secondLabel: second.label, title: task.label ?? "后台命令", command: task.command,
  finish() { for (const item of tasks) { item.state = "completed"; item.endedAt = Date.now(); item.exitCode = 0; } },
  savedTask() { return tab.state.taskId; },
};

// Run the real client contribution. Only the Paseo host and RPC boundary are
// simulated, so list clicks, sidebar routing, selection and live refresh are real.
contribute({
  addTimelineRenderer(entry) { if (!/^[a-z][a-z0-9-]*$/.test(entry.kind)) throw new Error("Invalid timeline renderer kind"); renderers.set(entry.kind, entry); return () => renderers.delete(entry.kind); },
  addTimelineTransformer(entry) { transformers.set(entry.query.itemType, entry.transform); return () => transformers.delete(entry.query.itemType); },
  addAgentPanel(entry) { log = entry; return () => { log = null; update(); }; },
  addCommandCenterItem(entry) { window.uiTest.commands.push(entry.id); return () => {}; },
  addComposerPill(entry) {
    pill = entry.button; update();
    return { update(patch) { pill = { ...pill, ...patch }; update(); }, remove() { pill = null; popoverOpen = false; update(); } };
  },
  openPanel(id, options) { window.uiTest.opens.push({ id, ...options }); sidebarOpen = true; update(); },
  paseo: { agents: { async list() { return { entries: [{ agent }], subscription: { subscribe: () => () => {}, release: async () => {} } }; } } },
  async rpc(contract, input) {
    window.uiTest.rpcCalls.push(contract.name);
    switch (contract.name) {
      case "tasks.list": {
        if (mode === "external-unavailable") throw new Error("External process scan unavailable");
        return { tasks: [{ token: "external", pid: 101, command: "external-shell-command", cwd: "/tmp", elapsedSeconds: 5 }], supported: true };
      }
      case "managed.list": return { tasks: tasks.map(item => ({ ...item })), supported: true, retentionDays: 7 };
      case "managed.logs": {
        window.uiTest.requests.push({ ...input });
        if (input.before !== undefined) await new Promise(resolve => setTimeout(resolve, 700));
        const snapshot = { ...tasks.find(item => item.id === input.taskId) };
        if (input.after !== undefined) return { text: "", start: 40000, end: 40000, totalBytes: 40000, hasEarlier: true, task: snapshot };
        const text = Array.from({ length: 200 }, (_, index) => `INFO 第 ${index + 1} 行日志：${input.taskId === task.id ? "任务一" : "任务二"}正常运行`).join("\n");
        return { text, start: 12000, end: 40000, totalBytes: 40000, hasEarlier: true, task: snapshot };
      }
      case "managed.stop": { const item = tasks.find(item => item.id === input.taskId); item.state = "stopped"; item.endedAt = Date.now(); return { stopped: true }; }
      default: throw new Error(`Unexpected RPC: ${contract.name}`);
    }
  },
});

function App() {
  const [, render] = useState(0);
  update = () => render(value => value + 1);
  const compact = innerWidth < 720;
  const host = { theme: { colors }, layout: { compact, platform: "web" }, host: { id: "test", label: "Test" }, workspaceId: agent.workspaceId };
  const notice = renderers.get("background-tasks-completion"), start = renderers.get("background-tasks-started");
  const List = pill?.behavior.Content, Log = log?.Component, Notice = notice?.Component, StartNotice = start?.Component;
  const PillIcon = typeof pill?.icon === "function" ? pill.icon : null;
  const noticeItem = transformers.get("user_message")?.({ item: { type: "user_message", clientMessageId: "background-tasks:test", text: `后台任务已完成：${task.id}。请用 task_status 获取结果和指令，按指令继续；需要输出时使用 task_logs。` }, phase: "complete" })?.items[0];
  const startItem = transformers.get("tool_call")?.({ item: { type: "tool_call", callId: "start-fixture", name: "paseo.task_start", status: "completed", error: null,
    detail: { type: "unknown", input: { command: task.command }, output: startResult } }, phase: "complete" })?.items[0];
  return <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative", width: "100%" }}>
    <main aria-label="对话" style={{ display: compact && sidebarOpen ? "none" : "flex", flexDirection: "column", flex: 1, minWidth: 0, padding: 16 }}>
      <div style={{ flex: 1 }}>对话内容
        {["failed", "missing"].includes(mode) && Notice && noticeItem && <div aria-label="任务完成通知"><Notice {...host} agentId={agent.id} item={{ ...noticeItem, data: notice.schema.parse(noticeItem.data) }} timestamp={new Date()} /></div>}
        {mode === "started" && StartNotice && startItem && <div aria-label="任务启动通知"><StartNotice {...host} agentId={agent.id} item={{ ...startItem, data: start.schema.parse(startItem.data) }} timestamp={new Date()} /></div>}
      </div>
      {pill && <button role="button" aria-label="后台任务列表" title={pill.title}
        style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 8, maxWidth: 152,
          padding: "6px 8px", border: "1px solid #333b4b", borderRadius: 6, background: "#171c26", color: "#e7e9ef", fontSize: 12 }}
        onClick={() => { popoverOpen = !popoverOpen; update(); }}>
        <span data-testid="pill-icon-slot" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {PillIcon ? <PillIcon {...host} context="agent" agentId={agent.id} size={14} color={colors.foreground} /> : <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" style={{ flexShrink: 0 }} fill="none" stroke="currentColor" strokeWidth="2">
          {pill.icon === "CircleAlert" ? <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3v1" /></> : <path d="m5 6 6 6-6 6m8 0h6" />}
        </svg>}
        </span>
        <span data-testid="pill-label" style={{ minWidth: 0, maxWidth: 112, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pill.label}</span>
      </button>}
    </main>
    {sidebarOpen && Log && <aside aria-label="任务日志侧栏" style={{ width: compact ? "100%" : 400, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, borderLeft: "1px solid #333b4b" }}>
      <header style={{ padding: 8, display: "flex", justifyContent: "space-between" }}><span>{log.title}</span><button role="button" aria-label="关闭日志" onClick={() => { sidebarOpen = false; update(); }}>关闭</button></header>
      <Log {...host} params={{ agentId: agent.id }} tab={tab} revision={0} />
    </aside>}
    {popoverOpen && List && <div aria-label="后台任务列表弹层" style={{ position: "absolute", left: 12, bottom: 48, padding: 12, width: compact ? "calc(100% - 24px)" : 360, maxHeight: "calc(100% - 72px)", overflowY: "auto", background: "#171c26", border: "1px solid #333b4b", borderRadius: 8 }}>
      <List {...host} context="agent" agentId={agent.id} close={() => { popoverOpen = false; update(); }} />
    </div>}
  </div>;
}
createRoot(document.getElementById("root")).render(<App />);
