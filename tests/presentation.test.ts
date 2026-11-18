import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedTask } from "../shared/managed";
import { defaultTaskTab, latestTask } from "../client/task-presentation";

const running: ManagedTask = {
  id: "e24c2613-f14b-463b-9def-880fc8d37204", command: "npm run dev", cwd: "/tmp", provider: "pi",
  state: "running", createdAt: 1000, endedAt: null, pid: 100, exitCode: null, exitSignal: null,
  logBytes: 100, logTruncated: false, error: null,
};
test("paused logs cannot keep showing running after the task directory reports completion", () => {
  const completed = { ...running, state: "completed" as const, endedAt: 2000, exitCode: 0 };
  assert.equal(latestTask(completed, running).state, "completed");
  assert.equal(latestTask(running, completed).state, "completed", "a slower directory refresh must not undo completion observed by log polling");
  const unknown = { ...running, state: "unknown" as const, logTruncated: true };
  assert.equal(latestTask(unknown, running).state, "unknown");
  assert.equal(latestTask(completed, unknown).state, "completed");
  const newer = { ...running, logBytes: 1000 };
  assert.equal(latestTask(running, newer).logBytes, 1000);
});
test("history is the default when only ended tasks exist; a direct task link selects its group", () => {
  const completed = { ...running, id: "8bad3d3d-5191-473e-af32-54051b5dc022", state: "completed" as const, endedAt: 2000 };
  assert.equal(defaultTaskTab([completed], null), "ended");
  assert.equal(defaultTaskTab([completed], "expired-selection"), "ended");
  assert.equal(defaultTaskTab([running, completed], null), "running");
  assert.equal(defaultTaskTab([running, completed], completed.id), "ended");
  assert.equal(defaultTaskTab([], null), "running");
});
