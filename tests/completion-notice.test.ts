import { test } from "node:test";
import assert from "node:assert/strict";
import { transformCompletionNotice } from "../client/completion-transform";

test("completion notices render as a compact timeline item without changing ordinary messages", () => {
  const text = "后台任务已完成：f33f3f90-59cb-46f3-9bac-603f43cde46d。请用 task_status 获取结果和指令，按指令继续；需要输出时使用 task_logs。";
  const notice = transformCompletionNotice({ type: "user_message", text });
  assert.equal(notice?.items[0].kind, "background-tasks-completion");
  assert.deepEqual(notice?.items[0].data, {});
  assert.ok(transformCompletionNotice({ type: "user_message", text: "notification", clientMessageId: "background-tasks:abc" }));
  assert.equal(transformCompletionNotice({ type: "user_message", text: "后台任务已完成：请检查。" }), undefined);
  assert.equal(transformCompletionNotice({ type: "user_message", text: "hello" }), undefined);
});
