import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import { startNoticeKind, transformTaskStart } from "../client/start-transform";

const id = "506e44f1-0f0c-4a8e-a6ac-ed03b8d340be";
const payload = { task: { id, command: "npm test", state: "running" } };
function call(output: unknown, name = "paseo.task_start"): Extract<ToolCallTimelineItem, { status: "completed" }> {
  return { type: "tool_call", callId: "start-1", name, status: "completed", error: null, detail: { type: "unknown", input: { command: "npm test" }, output } };
}
test("successful task starts become cards across Codex and Pi result envelopes", () => {
  for (const output of [payload, { structuredContent: payload }, { structured_content: payload },
    { content: [{ type: "text", text: JSON.stringify(payload) }] },
    { details: { structuredContent: payload } }, JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }] })]) {
    for (const name of ["task_start", "paseo.task_start", "mcp__paseo__task_start", "mcp_paseo_task_start", "paseo_task_start"]) {
      const result = transformTaskStart(call(output, name));
      assert.equal(result?.items[0].kind, startNoticeKind);
      assert.deepEqual(result?.items[0].data, { taskIds: [id] });
    }
  }
});
test("pending, canceled and failed tool calls retain the host's original rendering", () => {
  assert.equal(transformTaskStart({ ...call(payload), status: "running" }), undefined);
  assert.equal(transformTaskStart({ ...call(payload), status: "canceled" }), undefined);
  assert.equal(transformTaskStart({ ...call(payload), status: "failed", error: "quota exceeded" }), undefined);
  assert.equal(transformTaskStart(call({ isError: true, structuredContent: payload })), undefined);
});
test("unrelated tools, log UUIDs and malformed results never create task links", () => {
  for (const name of ["paseo.task_status", "other.task_start", "exec_command"]) assert.equal(transformTaskStart(call(payload, name)), undefined);
  for (const output of [null, `started ${id}`, { text: JSON.stringify(payload) }, { task: { id } },
    { task: { ...payload.task, id: "not-a-uuid" } }, { task: { ...payload.task, state: "bogus" } }]) {
    assert.equal(transformTaskStart(call(output)), undefined);
  }
  const cyclic: Record<string, unknown> = {}; cyclic.result = cyclic;
  assert.equal(transformTaskStart(call(cyclic)), undefined);
});
test("a short-lived command that already failed still links to its saved task result", () => {
  const result = transformTaskStart(call({ task: { ...payload.task, state: "failed" } }));
  assert.deepEqual(result?.items[0].data, { taskIds: [id] });
});
