import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const tests = dirname(fileURLToPath(import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), "background-tasks-ui-"));
const userData = join(artifacts, "chrome");
let browser, socket, server;
let browserExited;
let sequence = 0;
const pending = new Map();
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`Chrome did not respond to ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
async function waitFor(expression) {
  for (let retry = 0; retry < 100; retry++) {
    if (await evaluate(expression)) return;
    await delay(50);
  }
  throw new Error("UI did not reach expected state: " + expression);
}
async function click(label) {
  const found = await evaluate(`(() => {
    const el = [...document.querySelectorAll('[role="button"]')].find(el => el.getAttribute('aria-label') === ${JSON.stringify(label)} || el.textContent === ${JSON.stringify(label)});
    el?.click(); return !!el;
  })()`);
  assert.ok(found, "Button missing: " + label);
  await delay(100);
}
async function screenshot(name) {
  const response = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(join(artifacts, name + ".png"), Buffer.from(response.data, "base64"));
}

async function checkFeedback(label, screenshotName, disabled = false) {
  const selector = `[aria-label=${JSON.stringify(label)}]`;
  const locate = `document.querySelector(${JSON.stringify(selector)})`;
  const before = await evaluate(`(() => { const el = ${locate}; const box = el.getBoundingClientRect(); return { background: getComputedStyle(el).backgroundColor, x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: before.x, y: before.y });
  await delay(100);
  const hovered = await evaluate(`({ background: getComputedStyle(${locate}).backgroundColor, cursor: getComputedStyle(${locate}).cursor })`);
  assert.equal(hovered.cursor, disabled ? "auto" : "pointer", label + " cursor");
  if (disabled) assert.equal(hovered.background, before.background, label + " disabled hover");
  else assert.notEqual(hovered.background, before.background, label + " hover feedback");
  if (screenshotName) await screenshot(screenshotName);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  await delay(100);
  assert.equal(await evaluate(`getComputedStyle(${locate}).backgroundColor`), before.background, label + " restores after hover");
  await evaluate(`${locate}.focus()`);
  await delay(100);
  assert.equal(await evaluate(`getComputedStyle(${locate}).outlineWidth`), disabled ? "0px" : "2px", label + " focus feedback");
  await evaluate(`${locate}.blur()`);
}

try {
  assert.equal(typeof WebSocket, "function", "UI smoke requires Node 22+ with WebSocket support");
  await build({ entryPoints: [join(tests, "ui-fixture.jsx")], bundle: true, platform: "browser", format: "iife", outfile: join(artifacts, "bundle.js"),
    alias: {
      "react": dirname(require.resolve("react/package.json")),
      "react-dom": dirname(require.resolve("react-dom/package.json")),
      "react-native": dirname(require.resolve("react-native-web/package.json")),
      "@getpaseo/plugin/client/ui": join(tests, "ui-host.jsx"),
    }, define: { "process.env.NODE_ENV": '"development"' }, logLevel: "warning" });
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%;background:#10151f;color:#e7e9ef}#root{display:flex;flex-direction:column}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';
  const bundle = await readFile(join(artifacts, "bundle.js"));
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/bundle.js" ? "text/javascript" : "text/html; charset=utf-8");
    response.end(request.url === "/bundle.js" ? bundle : html);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(process.env.CHROME_BINARY ?? "google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${userData}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", detached: true });
  await once(browser, "spawn");
  browserExited = once(browser, "exit");
  let debugPort;
  for (let retry = 0; retry < 200; retry++) {
    try { debugPort = (await readFile(join(userData, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
    catch { await delay(50); }
  }
  assert.ok(debugPort, "Chrome did not start; set CHROME_BINARY to an installed Chrome/Chromium executable");
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id); pending.delete(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  });
  await call("Page.enable");
  async function navigate(mode, width, height) {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    await call("Page.navigate", { url: `${base}/?mode=${mode}` });
    await waitFor("typeof window.uiTest?.finish === 'function'");
    await delay(600);
  }

  async function openTask(second = false) {
    await click("后台任务列表");
    const label = await evaluate(second ? "'查看日志 ' + window.uiTest.secondLabel" : "'查看日志 ' + window.uiTest.title");
    await click(label);
    await waitFor("document.body.innerText.includes('第 200 行')");
  }

  await navigate("started", 1280, 800);
  await waitFor("document.querySelector('[aria-label=\"任务启动通知\"]')?.innerText.includes('运行中')");
  assert.ok(await evaluate("document.querySelector('[aria-label=\"任务启动通知\"]').innerText.includes('后台任务已启动') && document.querySelector('[aria-label=\"任务启动通知\"]').innerText.includes('运行测试')"));
  assert.equal(await evaluate("window.uiTest.requests.length"), 0, "start cards must not open or read logs automatically");
  await screenshot("task-started");
  await checkFeedback("查看日志 运行测试", "task-started-hover");
  await click("查看日志 运行测试");
  await waitFor("document.querySelector('aside')?.innerText.includes('第 200 行')");
  assert.equal(await evaluate("window.uiTest.requests[0].taskId"), await evaluate("window.uiTest.taskId"));
  await evaluate("window.uiTest.finish()");
  await waitFor("document.querySelector('[aria-label=\"任务启动通知\"]')?.innerText.includes('已完成 · 退出码 0')");
  assert.ok(await evaluate("!document.querySelector('[aria-label=\"任务启动通知\"]').innerText.includes('运行中')"));
  await click("关闭日志");
  await click("查看日志 运行测试");
  await waitFor("document.querySelector('aside')?.innerText.includes('第 200 行')");
  console.log("PASS: task_start result renders a live card, opens the exact log and stays usable after completion");

  await navigate("started", 320, 700);
  await waitFor("document.querySelector('[aria-label=\"任务启动通知\"]')?.innerText.includes('运行中')");
  assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"));
  await screenshot("task-started-mobile");
  await click("查看日志 运行测试");
  await waitFor("document.querySelector('aside')?.innerText.includes('第 200 行')");
  console.log("PASS: task start cards fit 320px screens and link to logs");

  await navigate("external-only", 1280, 800);
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"后台任务列表\"]')"), false, "external processes alone must not create a pill");
  assert.ok(await evaluate("!window.uiTest.rpcCalls.includes('tasks.list')"), "the client must not scan external processes");
  console.log("PASS: external processes do not create a background-task pill or trigger scanning");

  await navigate("external-unavailable", 1280, 800);
  await waitFor("document.body.innerText.includes('后台任务 2/3')");
  await click("后台任务列表");
  assert.ok(await evaluate("document.body.innerText.includes('运行中 2 · 已完成 1') && !document.body.innerText.includes('external-shell-command')"));
  assert.ok(await evaluate("!window.uiTest.rpcCalls.includes('tasks.list')"), "managed tasks must not depend on external scanning");
  console.log("PASS: managed tasks remain available when external process scanning is unavailable");

  await navigate("running", 390, 844);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"后台任务列表\"]').textContent"), "后台任务 2/3", "the pill shows active tasks over all retained managed tasks");
  assert.ok(await evaluate("!!document.querySelector('[aria-label=\"后台任务列表\"]').querySelector('svg')"), "the pill fills its leading slot with the terminal icon");
  assert.ok(await evaluate("(() => { const label = document.querySelector('[data-testid=pill-label]'); return label.scrollWidth <= label.clientWidth; })()"), "both counts must fit inside the bounded pill label");
  await screenshot("pill-compact");
  await click("后台任务列表");
  assert.ok(await evaluate("!document.body.innerText.includes('external-shell-command') && !document.body.innerText.includes('外部任务')"));
  await click("后台任务列表");
  assert.equal(await evaluate("window.uiTest.requests.length"), 0, "logs should not load until a list entry is selected");
  await openTask();
  await waitFor("document.body.innerText.includes('第 200 行')");
  assert.equal(await evaluate("innerWidth"), 390, "mobile toolbar must not expand the viewport");
  const controls = await evaluate("[...document.querySelector('aside').querySelectorAll('[role=button]')].filter(el=>!el.closest('header')&&el.getBoundingClientRect().top>=0&&el.getBoundingClientRect().top<180).map(el=>({height:el.getBoundingClientRect().height,right:el.getBoundingClientRect().right}))");
  assert.ok(controls.every(control => control.height >= 44 && control.right <= 390));
  assert.equal(await evaluate("!!document.querySelector('[aria-expanded=true]')"), false, "long command details should start collapsed");
  await screenshot("mobile");
  await evaluate("(() => { const el = [...document.querySelectorAll('aside *')].find(el => el.scrollHeight > el.clientHeight + 100 && el.innerText.includes('第 200 行')); el.scrollTop = 0; el.dispatchEvent(new Event('scroll', { bubbles: true })); })()"); await waitFor("document.body.innerText.includes('已暂停跟随')"); await delay(600);
  const requestsBefore = await evaluate("window.uiTest.requests.length");
  await evaluate("window.uiTest.finish()");
  await waitFor("document.body.innerText.includes('已完成') && document.querySelector('[aria-label=\"后台任务列表\"]')?.textContent === '后台任务 0/3'");
  assert.equal(await evaluate("window.uiTest.requests.length"), requestsBefore, "completing a task must not remount a paused viewer");
  assert.ok(await evaluate("document.body.innerText.includes('已完成') && !document.body.innerText.includes('运行中 ·') && document.body.innerText.includes('已暂停跟随')"));
  console.log("PASS: mobile row-to-log flow, sizing, and paused completion preserves history without remounting logs");

  await navigate("running", 1280, 800);
  await click("后台任务列表");
  await checkFeedback("最近结束任务");
  await checkFeedback("刷新后台任务");
  await checkFeedback(await evaluate("'查看日志 ' + window.uiTest.title"), "desktop-row-hover");
  assert.ok(await evaluate("!document.body.innerText.includes('completed-history-task') && !document.querySelector('[role=tablist]')"));
  assert.equal(await evaluate("window.uiTest.requests.length"), 0);
  await click(await evaluate("'查看日志 ' + window.uiTest.title"));
  await waitFor("document.body.innerText.includes('第 200 行')");
  assert.deepEqual(await evaluate("window.uiTest.opens[0]"), { id: "task-logs", workspaceId: "workspace", agentId: "test", location: "explorer" });
  assert.equal(await evaluate("window.uiTest.commands.length"), 0, "there should be no standalone task panel command");
  assert.ok(await evaluate("document.querySelector('main').getBoundingClientRect().width > 0 && document.querySelector('aside').getBoundingClientRect().right === 1280"));
  assert.equal(await evaluate("document.querySelector('aside').querySelector('[role=tablist], [aria-label=\"返回任务列表\"]')"), null);
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"后台任务列表弹层\"]')"), false);
  await screenshot("desktop");
  await checkFeedback("任务详情");
  await checkFeedback("复制已加载日志");
  await openTask(true);
  await waitFor("window.uiTest.savedTask() === window.uiTest.secondId && document.querySelector('aside').innerText.includes('任务二正常运行')");
  assert.equal(await evaluate("window.uiTest.requests.at(-1).taskId"), await evaluate("window.uiTest.secondId"));
  assert.ok(await evaluate("document.querySelector('aside').innerText.includes('开发服务')"));
  await click("任务详情");
  assert.ok(await evaluate("document.querySelector('aside').innerText.includes('npm run dev -- --port 3000') && document.querySelector('aside').innerText.includes('完成后：检查服务退出原因。')"));
  console.log("PASS: running-only list opens logs beside the conversation, closes the popover, and switches the saved task");

  await navigate("restore", 1280, 800);
  await waitFor("document.querySelector('aside')?.innerText.includes('任务二正常运行')");
  assert.ok(await evaluate("window.uiTest.requests.every(request => request.taskId === window.uiTest.secondId)"));
  console.log("PASS: restored sidebar reads the previously selected task directly");

  await navigate("ended", 1280, 800);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"后台任务列表\"]').textContent"), '后台任务 0/3');
  assert.equal(await evaluate("window.uiTest.requests.length"), 0);
  assert.equal(await evaluate("!!document.querySelector('aside')"), false);
  await click("后台任务列表");
  assert.ok(await evaluate("document.body.innerText.includes('最近结束') && document.body.innerText.includes('日志保留 7 天')"));
  await screenshot("history");
  await click("查看日志 后台命令");
  await waitFor("document.body.innerText.includes('第 200 行')");
  console.log("PASS: completed tasks can be reopened from history without loading logs in advance");

  await navigate("running", 1280, 800);
  await click("后台任务列表"); await click("终止");
  assert.equal(await evaluate("window.uiTest.opens.length"), 0, "stopping a task must not activate its log row");
  assert.equal(await evaluate("window.uiTest.requests.length"), 0);
  assert.ok(await evaluate("!document.querySelector('[aria-label=\"后台任务列表弹层\"]').innerText.includes('日志演示开始')"));
  assert.equal(await evaluate("document.querySelector('[aria-label=\"后台任务列表\"]').textContent"), "后台任务 1/3");
  assert.ok(await evaluate("document.querySelector('[aria-label=\"后台任务列表弹层\"]').innerText.includes('已终止 1')"));
  console.log("PASS: stopped tasks stay distinct from running and successfully completed pill counts");

  await navigate("running", 320, 700);
  assert.equal(await evaluate("innerWidth"), 320);
  await click("后台任务列表");
  await screenshot("mobile-list");
  await click(await evaluate("'查看日志 ' + window.uiTest.title"));
  await waitFor("document.body.innerText.includes('第 200 行')");
  assert.equal(await evaluate("innerWidth"), 320);
  await click("任务详情");
  assert.ok(await evaluate("document.body.innerText.includes('工作目录：')"));
  await evaluate("window.uiTest.finish()");
  await waitFor("document.body.innerText.includes('日志已结束')");
  await click("更多");
  assert.ok(await evaluate("!!document.querySelector('[role=dialog]')"));
  await click("删除任务和日志"); assert.equal(await evaluate("window.uiTest.deleted"), 0);
  await click("取消"); await click("删除任务和日志"); await click("确认永久删除");
  await waitFor("document.body.innerText.includes('从后台任务列表选择任务查看日志')");
  assert.equal(await evaluate("window.uiTest.deleted"), 1);
  assert.ok(await evaluate("window.uiTest.requests.every(request => request.taskId === window.uiTest.taskId)"), "deletion must not automatically open another task");
  console.log("PASS: 320px row-to-log navigation, details, delete confirmation and no automatic task fallback");

  await navigate("running", 320, 700);
  await openTask();
  await click("加载更早日志"); await click("回到底部并跟随日志"); await delay(1000);
  const requests = await evaluate("window.uiTest.requests");
  const historyIndex = requests.findIndex(request => request.before !== undefined);
  assert.ok(historyIndex >= 0 && requests[historyIndex + 1], "return to bottom must queue a request while history is loading");
  assert.equal(requests[historyIndex + 1].before, undefined);
  assert.equal(requests[historyIndex + 1].after, undefined);
  assert.equal(await evaluate("innerWidth"), 320);
  console.log("PASS: return-to-bottom request survives an in-flight history load");
  await navigate("failed", 1280, 800);
  await waitFor("document.querySelector('[aria-label=\"任务完成通知\"]')?.innerText.includes('失败 · 退出码 1')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"后台任务列表\"]').textContent"), "后台任务 0/3");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"后台任务列表\"]').title"), "后台任务");
  await click("后台任务列表");
  assert.ok(await evaluate("document.querySelector('[aria-label=\"后台任务列表弹层\"]').innerText.includes('失败 1')"));
  await click("后台任务列表");
  assert.ok(await evaluate("(() => { const label = document.querySelector('[data-testid=pill-label]'); return label.scrollWidth <= label.clientWidth; })()"));
  await screenshot("completion-failed");
  await checkFeedback("查看日志 运行测试", "completion-hover");
  await click("查看日志 运行测试");
  await waitFor("document.querySelector('aside')?.innerText.includes('第 200 行')");
  assert.equal(await evaluate("window.uiTest.opens[0].agentId"), "test");
  assert.equal(await evaluate("window.uiTest.requests[0].taskId"), await evaluate("window.uiTest.taskId"));
  await click("关闭日志");
  await click("查看日志 运行测试");
  await waitFor("document.querySelector('aside')?.innerText.includes('第 200 行')");
  await evaluate("window.uiTest.finish()");
  await waitFor("document.querySelector('[aria-label=\"任务完成通知\"]')?.innerText.includes('已完成 · 退出码 0')");
  assert.ok(await evaluate("!document.querySelector('[aria-label=\"任务完成通知\"]').innerText.includes('失败')"));
  await screenshot("completion-success");
  console.log("PASS: failed completion shows the real result and reopens the correct log after closing");

  await navigate("missing", 1280, 800);
  await waitFor("document.body.innerText.includes('记录已删除或超过保留期限')");
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"后台任务列表\"]')"), false);
  assert.equal(await evaluate("window.uiTest.opens.length"), 0);
  assert.ok(await evaluate("!document.body.innerText.includes('已完成')"));
  await checkFeedback("任务结果不可用", undefined, true);
  console.log("PASS: expired or deleted results have no success claim or actionable log link");

  await navigate("running", 320, 700);
  await openTask();
  await click("暂停跟随日志");
  await waitFor("document.body.innerText.includes('已暂停跟随')");
  await click("复制已加载日志");
  assert.ok(await evaluate("window.uiTest.copied.includes('第 200 行')"));
  await click("搜索日志");
  await evaluate(`(() => { const el = document.querySelector('[aria-label="搜索已加载日志"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, '第 199 行'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor("document.body.innerText.includes('1 行匹配')");
  assert.ok(await evaluate("!document.body.innerText.includes('第 198 行') && document.body.innerText.includes('第 199 行')"));
  await screenshot("mobile-search");
  await click("收起日志搜索");
  await waitFor("document.body.innerText.includes('第 198 行')");
  await click("更多");
  await click("增大日志字号");
  assert.ok(await evaluate("document.body.innerText.includes('日志字号 · 14')"));
  await click("关闭");
  assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"));
  console.log("PASS: 320px pause, copy, loaded-log search and font adjustment");
  console.log("UI screenshots:", artifacts);
} finally {
  socket?.close();
  if (browser?.pid) {
    try { process.kill(-browser.pid, "SIGTERM"); } catch {}
    if (browserExited) await Promise.race([browserExited, delay(3000)]);
    try { process.kill(-browser.pid, "SIGKILL"); } catch {}
  }
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
