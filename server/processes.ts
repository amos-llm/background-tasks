import { readdir, readFile, readlink } from "node:fs/promises";

export interface ProcessInfo {
  pid: number; ppid: number; group: number; start: string; state: string;
  args: string[]; agentId: string; threadId: string; toolId: string; cwd: string;
}
export function parseStat(value: string) {
  // comm may contain spaces and closing parentheses.
  const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
  return { state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), start: fields[19] };
}
export async function readProcess(pid: number): Promise<ProcessInfo | null> {
  try {
    const root = `/proc/${pid}`;
    const [stat, environment, command, cwd] = await Promise.all([
      readFile(`${root}/stat`, "utf8"), readFile(`${root}/environ`, "utf8"),
      readFile(`${root}/cmdline`, "utf8"), readlink(`${root}/cwd`).catch(() => ""),
    ]);
    const env = Object.fromEntries(environment.split("\0").map((item) => {
      const split = item.indexOf("="); return [item.slice(0, split), item.slice(split + 1)];
    }));
    return { pid, ...parseStat(stat), args: command.split("\0").filter(Boolean), cwd,
      agentId: env.PASEO_AGENT_ID ?? "", threadId: env.CODEX_THREAD_ID ?? "", toolId: env.CODEX_TOOL_CALL_ID ?? "" };
  } catch { return null; }
}
export async function snapshot(): Promise<ProcessInfo[]> {
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const result: ProcessInfo[] = [];
  for (let offset = 0; offset < names.length; offset += 64) {
    const batch = await Promise.all(names.slice(offset, offset + 64).map((name) => readProcess(Number(name))));
    result.push(...batch.filter((item): item is ProcessInfo => item !== null));
  }
  return result;
}
export function selectTasks(all: ProcessInfo[], agentId: string, provider: string, threadId: string | null) {
  const own = all.filter((p) => p.agentId === agentId && p.state !== "Z" && p.state !== "X");
  const groups = new Map<number, ProcessInfo[]>();
  for (const p of own) {
    if (provider === "codex" && (!p.toolId || !threadId || p.threadId !== threadId)) continue;
    const group = groups.get(p.group) ?? []; group.push(p); groups.set(p.group, group);
  }
  return [...groups.values()].flatMap((members) => {
    // Shell tools have separate process groups; never offer runtime/MCP groups.
    const leader = members.find((p) => p.pid === p.group);
    if (!leader || leader.group <= 1 || leader.pid === process.pid) return [];
    if (all.some((p) => p.group === leader.group && p.state !== "Z" && p.agentId !== agentId)) return [];
    if (provider === "codex" && all.some((p) => p.group === leader.group && p.state !== "Z" && (p.threadId !== threadId || p.toolId !== leader.toolId))) return [];
    const shell = /(?:^|\/)(?:ba|da|z|fi|k)?sh$/.test(leader.args[0] ?? "");
    // Bash may exec the final command, so its group leader can already be a
    // non-shell executable. A direct child of Pi's runtime is still a task.
    const parent = all.find((p) => p.pid === leader.ppid);
    const piParent = parent?.agentId === agentId && parent.args.some((arg) => /(?:^|\/)(?:pi(?:\.js)?|pi-coding-agent|pi-acp)(?:\/|$)/.test(arg));
    if (provider === "pi" && !piParent) return [];
    const commandIndex = shell ? leader.args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg)) : -1;
    const command = commandIndex >= 0 ? leader.args.slice(commandIndex + 1).join(" ") : leader.args.join(" ");
    return [{ leader, command }];
  });
}
