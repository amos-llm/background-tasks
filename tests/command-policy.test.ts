import assert from "node:assert/strict";
import test from "node:test";
import { assertUnfilteredTaskCommand } from "../server/command-policy";

test("rejects common output-filtering pipelines and tells the agent how to retry", () => {
  for (const command of [
    "npm test 2>&1 | tail -50",
    "npm run dev | grep --line-buffered ready",
    "npm test |head -n 10",
    "npm test |& /usr/bin/rg ERROR",
    "npm test | 'grep' ERROR",
    "npm test | gr\\ep ERROR",
    "npm test |\n  tail -n 20",
    "npm test |\\\n tail -n 20",
    "npm test | env LANG=C stdbuf -oL grep ERROR",
    "npm test | stdbuf -o L command -- /usr/bin/tail -20",
    "npm test | env -u LANG -C /tmp grep ERROR",
    "npm test | 2>/tmp/errors.log grep ERROR",
    "npm test | (tail -20)",
    "npm test | { grep ERROR; }",
    "(npm test) | sed -n '1,20p'",
    "npm test | tee test.log | awk '/FAIL/'",
    "npm test | egrep ERROR",
    "npm test | fgrep ERROR",
    "bash -lc 'npm test 2>&1 | tail -20'",
    'env CI=1 sh -c "npm test | grep ERROR"',
    "cd /tmp && bash -c 'npm test | head'",
    "cat <<< 'data'\nnpm test | tail -20",
  ]) {
    assert.throws(() => assertUnfilteredTaskCommand(command), error => {
      assert.ok(error instanceof Error);
      for (const text of ["task_start", "original foreground command", "task_logs", "tailLines/filter/before", "not started or modified"]) {
        assert.ok(error.message.includes(text), text);
      }
      return true;
    }, command);
  }
});

test("preserves literal arguments, file searches and non-filtering pipelines", () => {
  for (const command of [
    "npm test", "npm run dev -- --host 0.0.0.0", "CI=1 npm test 2>&1",
    "grep ERROR test.log", "tail -f server.log", "head -20 test.log",
    "printf '%s' 'npm test | tail -20'",
    'node -e "console.log(\'npm test | grep ERROR\')"',
    "printf 'a|tail\\n'", "printf '%s' foo\\|grep",
    "printf '%s' prefix#literal | cat", "npm test # | tail -20",
    "cat <<'EOF'\nnpm test | tail -20\nEOF\n",
    "cat <<-EOF\n\tnpm test | grep ERROR\n\tEOF\n",
    "cat <<A <<'B'\n| tail\nA\n| grep\nB\n",
    "npm test || tail -20 diagnostics.log",
    "npm test && grep ERROR diagnostics.log",
    "npm test | tee test.log", "printf 'data' | node transform.js",
    "bash -lc 'npm test'", "printf '%s' bash -c 'npm test | tail'",
    String.raw`bash -c "printf npm\|tail"`,
    "command -v bash -c 'npm test | tail'",
    "cat <<< 'literal | tail'\nprintf 'done'",
  ]) assert.doesNotThrow(() => assertUnfilteredTaskCommand(command), command);
});

test("heredoc data is ignored but pipelines on either side are checked", () => {
  assert.throws(() => assertUnfilteredTaskCommand("cat <<EOF | tail -20\ntext\nEOF\n"));
  assert.throws(() => assertUnfilteredTaskCommand("cat <<EOF\ntext\nEOF\nnpm test | grep ERROR"));
});
