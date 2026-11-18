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
    pending.set(id, { resolve, reject });
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
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  });
  await call("Page.enable");
  async function navigate(mode, width, height) {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    await call("Page.navigate", { url: `${base}/?mode=${mode}` });
    await waitFor("typeof window.uiTest?.finish === 'function'");
    await delay(600);
  }

  await navigate("running", 390, 844);
  await waitFor("document.body.innerText.includes('第 200 行')");
  assert.equal(await evaluate("innerWidth"), 390, "mobile toolbar must not expand the viewport");
  const controls = await evaluate("[...document.querySelectorAll('[role=button]')].filter(el=>el.getBoundingClientRect().top>=0&&el.getBoundingClientRect().top<150).map(el=>({height:el.getBoundingClientRect().height,right:el.getBoundingClientRect().right}))");
  assert.ok(controls.every(control => control.height >= 44 && control.right <= 390));
  assert.equal(await evaluate("!!document.querySelector('[aria-expanded=true]')"), false, "long command details should start collapsed");
  await screenshot("mobile");
  await click("暂停跟随日志"); await delay(600);
  const requestsBefore = await evaluate("window.uiTest.requests.length");
  await evaluate("window.uiTest.finish()"); await delay(900);
  assert.equal(await evaluate("window.uiTest.requests.length"), requestsBefore, "completing a task must not remount a paused viewer");
  assert.ok(await evaluate("document.body.innerText.includes('已完成') && !document.body.innerText.includes('运行中 ·') && document.body.innerText.includes('已暂停跟随')"));
  console.log("PASS: mobile sizing, collapsed details, paused completion keeps status fresh and preserves the viewer");

  await navigate("history", 1280, 800);
  await waitFor("document.querySelector('[role=tab][aria-selected=true]')?.textContent === '历史 2'");
  assert.ok(await evaluate("!document.body.innerText.includes('暂无任务') && document.body.innerText.includes('第 200 行')"));
  assert.ok(await evaluate("!document.querySelector('[role=tab][aria-selected=true]').hasAttribute('aria-disabled')"));
  await screenshot("desktop");
  console.log("PASS: desktop history default, automatic selection and enabled selected tab");

  await navigate("history", 320, 700);
  assert.equal(await evaluate("innerWidth"), 320);
  assert.equal(await evaluate("window.uiTest.requests.length"), 0, "mobile history opens the list before reading a task");
  await screenshot("mobile-list");
  await click("日志");
  await waitFor("!!document.querySelector('[aria-label=\"返回任务列表\"]')");
  await click("返回任务列表");
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"返回任务列表\"]')"), false);
  await click("日志"); await click("更多");
  assert.ok(await evaluate("!!document.querySelector('[role=dialog]')"));
  await click("删除任务和日志"); assert.equal(await evaluate("window.uiTest.deleted"), 0);
  await click("取消"); await click("展开任务详情");
  assert.ok(await evaluate("document.body.innerText.includes('工作目录：')"));
  console.log("PASS: 320px list/detail/back navigation, more menu, details and delete confirmation");

  await navigate("running", 320, 700);
  await click("加载更早日志"); await click("回到底部并跟随日志"); await delay(1000);
  const requests = await evaluate("window.uiTest.requests");
  const historyIndex = requests.findIndex(request => request.before !== undefined);
  assert.ok(historyIndex >= 0 && requests[historyIndex + 1], "return to bottom must queue a request while history is loading");
  assert.equal(requests[historyIndex + 1].before, undefined);
  assert.equal(requests[historyIndex + 1].after, undefined);
  assert.equal(await evaluate("innerWidth"), 320);
  console.log("PASS: return-to-bottom request survives an in-flight history load");
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
