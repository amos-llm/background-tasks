import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ManagedTaskPanel } from "../client/managed-tasks";

const history = new URLSearchParams(location.search).get("mode") === "history";
const colors = { foreground: "#e7e9ef", foregroundMuted: "#9098aa", border: "#333b4b", surface1: "#171c26", surface2: "#252d3c", statusDanger: "#ff7b87" };
const task = {
  id: "506e44f1-0f0c-4a8e-a6ac-ed03b8d340be", provider: "pi",
  command: "printf '=== 日志演示开始 ===\\n'; for i in {1..60}; do printf '[%s] INFO 进度 %02d/60\\n' \"$(date '+%H:%M:%S')\" \"$i\"; sleep 1; done; printf '=== 任务完成 ===\\n'",
  cwd: "/home/ubuntu/background-tasks", state: history ? "completed" : "running", createdAt: Date.now() - 17000,
  endedAt: history ? Date.now() : null, pid: 100, exitCode: history ? 0 : null, exitSignal: null,
  logBytes: 40000, logTruncated: false, error: null,
};
const tasks = [task, { ...task, id: "e24c2613-f14b-463b-9def-880fc8d37204", command: "npm run dev -- --port 3000", state: "completed", endedAt: Date.now(), exitCode: 0 }];
window.uiTest = { requests: [], deleted: 0, copied: null };
const readLog = async input => {
  window.uiTest.requests.push({ ...input });
  if (input.before !== undefined) await new Promise(resolve => setTimeout(resolve, 700));
  // Return a separate snapshot, exactly as an RPC does, so stale-state tests are meaningful.
  const snapshot = { ...task };
  if (input.after !== undefined) return { text: "", start: 40000, end: 40000, totalBytes: 40000, hasEarlier: true, task: snapshot };
  const text = Array.from({ length: 200 }, (_, index) => `INFO 第 ${index + 1} 行日志：任务正常运行`).join("\n");
  return { text, start: 12000, end: 40000, totalBytes: 40000, hasEarlier: true, task: snapshot };
};
function App() {
  const [, render] = useState(0);
  const [selected, setSelected] = useState(history ? null : task.id);
  window.uiTest.finish = () => { task.state = "completed"; task.endedAt = Date.now(); task.exitCode = 0; render(value => value + 1); };
  return <ManagedTaskPanel agentId="test" tasks={tasks} selectedId={selected} theme={{ colors }} error={null}
    loading={false} stopping={null} retentionDays={7} onSelect={setSelected} onStop={() => {}} onRefresh={() => {}}
    onDelete={async target => { window.uiTest.deleted++; tasks.splice(tasks.findIndex(item => item.id === target.id), 1); setSelected(null); render(value => value + 1); }}
    readLog={readLog} logLocation={async () => "/test/output.log"} />;
}
createRoot(document.getElementById("root")).render(<App />);
