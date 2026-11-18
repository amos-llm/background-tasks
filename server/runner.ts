// A self-contained CommonJS program, written to the state directory before launch.
// No dependency on the plugin bundle or node_modules: a running task survives reload/update.
export const runnerSource = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const dir = process.argv[2];
const metaPath = path.join(dir, "task.json");
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
function stat(pid) {
  try {
    const value = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
    return { pid: Number(pid), state: fields[0], group: Number(fields[2]), start: fields[19] };
  } catch { return null; }
}
function save() {
  fs.writeFileSync(metaPath + ".next", JSON.stringify(meta), { mode: 0o600 });
  fs.renameSync(metaPath + ".next", metaPath);
}
function members() {
  if (!meta.pid) return [];
  return fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(stat)
    .filter(p => p && p.group === meta.pid && p.state !== "Z" && p.state !== "X");
}
function owned(list) {
  return list.every(p => {
    try {
      return fs.readFileSync("/proc/" + p.pid + "/environ", "utf8").split("\0")
        .includes("PASEO_MANAGED_TASK_ID=" + meta.id);
    } catch { return false; }
  });
}
meta.runnerPid = process.pid;
meta.runnerStart = stat(process.pid).start;
let child, output, exited = false, stdoutDone = false, stderrDone = false, finishing = false;
let reason = null, stopAt = 0, originals = [], written = 0, outputFailed = false;
function signalGroup(signal) {
  const list = members();
  if (!list.length) return;
  if (!owned(list) || !list.some(p => originals.some(old => old.pid === p.pid && old.start === p.start))) {
    meta.error = "进程组身份发生变化，未向未知进程发送信号";
    save(); return;
  }
  try { process.kill(-meta.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") { meta.error = error.message; save(); } }
}
function stop(why) {
  if (reason) return;
  reason = why; stopAt = Date.now(); originals = members();
  meta.stopReason = why; save(); signalGroup("SIGTERM");
}
async function finish() {
  if (finishing || !exited || !stdoutDone || !stderrDone || members().length) return;
  finishing = true; clearInterval(tick);
  if (output && !outputFailed) await new Promise(resolve => {
    output.once("error", resolve); output.end(resolve);
  });
  meta.endedAt = Date.now();
  meta.state = reason === "timeout" ? "timed_out" : reason === "log_limit" ? "log_limit"
    : reason === "capture_error" ? "error" : reason ? "stopped"
    : meta.exitCode === 0 ? "completed" : "failed";
  save();
}
function capture(chunk) {
  if (outputFailed || meta.logTruncated) return;
  const remaining = Math.max(0, meta.maxLogBytes - written);
  const data = chunk.subarray(0, remaining);
  written += data.length;
  if (data.length && !output.write(data)) {
    child.stdout.pause(); child.stderr.pause();
  }
  if (data.length !== chunk.length) {
    meta.logTruncated = true;
    stop("log_limit");
  }
}
let tick;
try {
  output = fs.createWriteStream(path.join(dir, "output.log"), { flags: "a", mode: 0o600 });
  output.on("drain", () => { child.stdout.resume(); child.stderr.resume(); });
  output.on("error", error => {
    outputFailed = true; meta.logTruncated = true; meta.error = "日志写入失败: " + error.message;
    if (child) { stop("capture_error"); child.stdout.resume(); child.stderr.resume(); }
  });
  child = spawn("/bin/bash", ["-c", meta.command], {
    cwd: meta.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PASEO_AGENT_ID: meta.agentId, PASEO_MANAGED_TASK_ID: meta.id,
      CODEX_TOOL_CALL_ID: "", CODEX_THREAD_ID: "" },
  });
  meta.pid = child.pid || null;
  meta.start = meta.pid ? (stat(meta.pid) || {}).start || null : null;
  meta.state = "running"; save();
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  child.stdout.on("end", () => { stdoutDone = true; void finish(); });
  child.stderr.on("end", () => { stderrDone = true; void finish(); });
  child.on("error", error => {
    meta.error = error.message; meta.exitCode = null;
    reason = "capture_error"; exited = stdoutDone = stderrDone = true;
    void finish();
  });
  child.on("exit", (code, signal) => {
    meta.exitCode = code; meta.exitSignal = signal; exited = true; void finish();
  });
  tick = setInterval(() => {
    try {
      if (!reason && fs.existsSync(path.join(dir, "stop"))) stop("user");
      if (!reason && meta.timeoutSeconds && Date.now() - meta.createdAt >= meta.timeoutSeconds * 1000) stop("timeout");
      if (reason && Date.now() - stopAt >= 3000) signalGroup("SIGKILL");
      void finish();
    } catch (error) { meta.error = error.message; save(); }
  }, 200);
  process.on("SIGTERM", () => stop("user"));
  process.on("SIGINT", () => stop("user"));
} catch (error) {
  meta.error = error.message; meta.state = "error"; meta.endedAt = Date.now(); save();
  if (child) stop("capture_error");
  else { if (output) output.end(); process.exitCode = 1; }
}
`;
