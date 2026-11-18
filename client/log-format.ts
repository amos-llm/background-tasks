import type { LogPage } from "../shared/managed";

export const LOG_WINDOW_BYTES = 2 * 1024 * 1024;
export type LogWindow = { pages: LogPage[]; start: number; end: number; totalBytes: number; task: LogPage["task"] };
export function mergeLogPage(current: LogWindow | null, page: LogPage, direction: "replace" | "before" | "after"): LogWindow {
  if (current && direction === "after" && page.end === page.start) {
    return { ...current, totalBytes: page.totalBytes, task: page.task };
  }
  let pages = !current || direction === "replace" ? [page]
    : direction === "before" ? [page, ...current.pages] : [...current.pages, page];
  // Empty polling responses update status without accumulating React nodes or cached chunks.
  pages = pages.filter(part => part.end > part.start);
  while (pages.length > 1 && pages.at(-1)!.end - pages[0].start > LOG_WINDOW_BYTES) {
    if (direction === "before") pages.pop(); else pages.shift();
  }
  return { pages, start: pages[0]?.start ?? page.start, end: pages.at(-1)?.end ?? page.end,
    totalBytes: page.totalBytes, task: page.task };
}
export function plainLog(text: string) {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n").map(line => line.split("\r").at(-1) ?? "").join("\n");
}
