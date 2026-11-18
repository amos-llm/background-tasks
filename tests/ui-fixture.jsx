import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import contribute from "../index.client";

const mode = new URLSearchParams(location.search).get("mode");
const colors = { foreground: "#e7e9ef", foregroundMuted: "#9098aa", border: "#333b4b", surface1: "#171c26", surface2: "#252d3c", statusDanger: "#ff7b87" };
const task = {
  id: "506e44f1-0f0c-4a8e-a6ac-ed03b8d340be", provider: "pi",
  command: "printf '=== 日志演示开始 ===\\n'; for i in {1..60}; do printf '[%s] INFO 进度 %02d/60\\n' \"$(date '+%H:%M:%S')\" \"$i\"; sleep 1; done; printf '=== 任务完成 ===\\n'",
  cwd: "/home/ubuntu/background-tasks", state: mode === "ended" ? "completed" : "running", createdAt: Date.now() - 17000,
  endedAt: mode === "ended" ? Date.now() : null, pid: 100, exitCode: mode === "ended" ? 0 : null, exitSignal: null,
  logBytes: 40000, logTruncated: false, error: null,
};
const second = { ...task, id: "e24c2613-f14b-463b-9def-880fc8d37204", command: "npm run dev -- --port 3000" };
const tasks = [task, second, { ...task, id: "8bad3d3d-5191-473e-af32-54051b5dc022", command: "completed-history-task", state: "completed", endedAt: Date.now(), exitCode: 0 }];
const agent = { id: "test", workspaceId: "workspace", provider: "pi" };
let update = () => {}, pill = null, log = null, popoverOpen = false, sidebarOpen = mode === "restore";
const tab = { state: mode === "restore" ? { taskId: second.id } : {}, setState(state) { this.state = state; } };
window.uiTest = { requests: [], opens: [], commands: [], deleted: 0, copied: null, taskId: task.id, secondId: second.id, command: task.command,
  finish() { for (const item of tasks) { item.state = "completed"; item.endedAt = Date.now(); item.exitCode = 0; } },
  savedTask() { return tab.state.taskId; },
};

// Run the real client contribution. Only the Paseo host and RPC boundary are
// simulated, so list clicks, sidebar routing, selection and live refresh are real.
contribute({
  addAgentPanel(entry) { log = entry; return () => { log = null; update(); }; },
  addCommandCenterItem(entry) { window.uiTest.commands.push(entry.id); return () => {}; },
  addComposerPill(entry) {
    pill = entry.button; update();
    return { update(patch) { pill = { ...pill, ...patch }; update(); }, remove() { pill = null; popoverOpen = false; update(); } };
  },
  openPanel(id, options) { window.uiTest.opens.push({ id, ...options }); sidebarOpen = true; update(); },
  paseo: { agents: { async list() { return { entries: [{ agent }], subscription: { subscribe: () => () => {}, release: async () => {} } }; } } },
  async rpc(contract, input) {
    switch (contract.name) {
      case "tasks.list": return { tasks: [], supported: true };
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
      case "managed.delete": window.uiTest.deleted++; tasks.splice(tasks.findIndex(item => item.id === input.taskId), 1); return { deleted: true };
      case "managed.log-location": return { path: "/test/output.log" };
      default: throw new Error(`Unexpected RPC: ${contract.name}`);
    }
  },
});

function App() {
  const [, render] = useState(0);
  update = () => render(value => value + 1);
  const compact = innerWidth < 720;
  const host = { theme: { colors }, layout: { compact, platform: "web" }, host: { id: "test", label: "Test" }, workspaceId: agent.workspaceId };
  const List = pill?.behavior.Content, Log = log?.Component;
  return <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative", width: "100%" }}>
    <main aria-label="对话" style={{ display: compact && sidebarOpen ? "none" : "flex", flexDirection: "column", flex: 1, minWidth: 0, padding: 16 }}>
      <div style={{ flex: 1 }}>对话内容</div>
      {pill && <button role="button" aria-label="后台任务列表" onClick={() => { popoverOpen = !popoverOpen; update(); }}>{pill.label}</button>}
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
