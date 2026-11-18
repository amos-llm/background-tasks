import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, Pressable, StyleSheet, Text, View, type ScrollView as NativeScrollView } from "react-native";
import { isActiveTask, type LogPage, type ManagedTask } from "../shared/managed";
import { mergeLogPage, plainLog, type LogWindow } from "./log-format";

export const stateLabels: Record<ManagedTask["state"], string> = {
  starting: "启动中", running: "运行中", completed: "已完成", failed: "失败", stopped: "已终止",
  timed_out: "超时", log_limit: "日志达到上限", error: "任务错误", unknown: "状态未知",
};
const monoFont = Platform.select({ web: "Menlo, Monaco, Consolas, monospace", ios: "Menlo", default: "monospace" });
export function Action({ label, onPress, theme, disabled = false, danger = false }: {
  label: string; onPress(): void; theme: PluginTheme; disabled?: boolean; danger?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, { borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surface2 : undefined }, disabled && { opacity: 0.5 }]}>
    <Text style={{ color: danger ? theme.colors.statusDanger : theme.colors.foreground, fontSize: 12 }}>{label}</Text>
  </Pressable>;
}
export function ManagedRow({ task, theme, selected, stopping, onSelect, onStop }: {
  task: ManagedTask; theme: PluginTheme; selected?: boolean; stopping: boolean; onSelect(): void; onStop(): void;
}) {
  const seconds = Math.max(0, Math.floor(((task.endedAt ?? Date.now()) - task.createdAt) / 1000));
  return <View style={[styles.row, { borderColor: theme.colors.border, backgroundColor: selected ? theme.colors.surface2 : undefined }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`查看日志 ${task.command}`} onPress={onSelect} style={styles.rowContent}>
      <Text numberOfLines={1} style={[styles.command, { color: theme.colors.foreground }]}>{task.command}</Text>
      <Text style={[styles.meta, { color: theme.colors.foregroundMuted }]}>
        {stateLabels[task.state]} · {seconds}s{task.exitCode !== null ? ` · 退出码 ${task.exitCode}` : ""}
      </Text>
    </Pressable>
    <Action label="日志" theme={theme} onPress={onSelect} />
    {(isActiveTask(task) || task.state === "unknown") && <Action label={stopping ? "终止中" : "终止"} theme={theme} danger disabled={stopping} onPress={onStop} />}
  </View>;
}
export type ReadLog = (input: { agentId: string; taskId: string; before?: number; after?: number; limit?: number }) => Promise<LogPage>;

function LogViewer({ agentId, taskId, theme, readLog, logLocation }: {
  agentId: string; taskId: string; theme: PluginTheme; readLog: ReadLog; logLocation(taskId: string): Promise<string>;
}) {
  const [window, setWindow] = useState<LogWindow | null>(null);
  const windowRef = useRef<LogWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const scroll = useRef<NativeScrollView>(null);
  const loadRef = useRef<(direction: "replace" | "before" | "after") => Promise<void>>(async () => {});
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false, pending = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load(direction: "replace" | "before" | "after") {
      if (disposed || pending) return;
      pending = true; setBusy(true);
      try {
        const current = windowRef.current;
        const page = await readLog({ agentId, taskId,
          ...(direction === "before" && current ? { before: current.start } : {}),
          ...(direction === "after" && current ? { after: current.end } : {}),
        });
        if (disposed) return;
        const next = mergeLogPage(current, page, direction);
        windowRef.current = next; setWindow(next); setError(null);
      } catch (err) { if (!disposed) setError(String(err)); }
      finally { pending = false; if (!disposed) setBusy(false); }
    }
    loadRef.current = load;
    async function poll() {
      if (disposed) return;
      if (followingRef.current && (AppState.currentState === "active" || AppState.currentState === null)) {
        const current = windowRef.current;
        if (!current || isActiveTask(current.task) || current.end < current.totalBytes) await load(current ? "after" : "replace");
      }
      if (!disposed) timer = setTimeout(() => void poll(), 500);
    }
    void load("replace").then(() => { if (!disposed) timer = setTimeout(() => void poll(), 500); });
    return () => { disposed = true; clearTimeout(timer); };
  }, [agentId, taskId, readLog]);
  const text = plainLog(window?.pages.map(page => page.text).join("") ?? "");
  const colors = theme.colors;
  function follow() {
    followingRef.current = true; setFollowing(true);
    void loadRef.current("replace"); scroll.current?.scrollToEnd({ animated: false });
  }
  async function copy() {
    try { await copyText(text); setNotice("已复制当前加载的日志"); }
    catch (err) { setNotice(String(err)); }
  }
  async function copyLocation() {
    try { await copyText(await logLocation(taskId)); setNotice("已复制主机上的原始日志路径，可在主机上读取或导出。"); }
    catch (err) { setNotice(String(err)); }
  }
  return <View style={[styles.viewer, { borderColor: colors.border }]}>
    <View style={styles.toolbar}>
      <Text style={[styles.meta, { color: colors.foregroundMuted }]}>
        {window ? `${stateLabels[window.task.state]} · ${(window.totalBytes / 1024).toFixed(1)} KiB` : "正在读取日志…"}
      </Text>
      <View style={styles.buttons}>
        <Action label="更早日志" disabled={busy || !window || window.start === 0} theme={theme} onPress={() => {
          followingRef.current = false; setFollowing(false); void loadRef.current("before");
        }} />
        <Action label={following ? "暂停跟随" : "回到底部"} theme={theme} onPress={() => {
          if (following) { followingRef.current = false; setFollowing(false); } else follow();
        }} />
        <Action label="复制已加载" disabled={!text} theme={theme} onPress={() => void copy()} />
        <Action label="复制原始日志路径" theme={theme} onPress={() => void copyLocation()} />
        <Action label="重试" disabled={busy} theme={theme} onPress={() => void loadRef.current(windowRef.current ? "after" : "replace")} />
      </View>
    </View>
    {window && <Text selectable style={[styles.meta, { color: colors.foregroundMuted }]}>{window.task.command}{"\n"}{window.task.cwd}</Text>}
    {window?.task.logTruncated && <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
      日志采集已中断：{window.task.error ?? "达到日志容量上限，已停止任务；当前文件不是完整输出。"}
    </Text>}
    {(error || window?.task.error) && <Text selectable accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error ?? window?.task.error}</Text>}
    {notice && <Text selectable style={[styles.meta, { color: colors.foregroundMuted }]}>{notice}</Text>}
    {window && window.start > 0 && <Text style={[styles.meta, { color: colors.foregroundMuted }]}>当前从第 {window.start} 字节开始显示；完整保留内容可向前翻阅。显示窗口最多 2 MiB。</Text>}
    <ScrollView ref={scroll} style={[styles.output, { backgroundColor: colors.surface1 }]}
      contentContainerStyle={styles.outputContent} scrollEventThrottle={100}
      onScroll={(event) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        if (contentOffset.y + layoutMeasurement.height < contentSize.height - 40 && followingRef.current) {
          followingRef.current = false; setFollowing(false);
        }
      }}
      onContentSizeChange={() => { if (followingRef.current) scroll.current?.scrollToEnd({ animated: false }); }}>
      {busy && !window ? <ActivityIndicator color={colors.foregroundMuted} />
        : <Text selectable style={[styles.outputText, { color: colors.foreground }]}>{text || (isActiveTask(window?.task ?? { state: "starting" }) ? "等待任务输出…" : "任务没有输出")}</Text>}
    </ScrollView>
  </View>;
}

export function ManagedTaskPanel({ agentId, tasks, selectedId, theme, error, loading, stopping, retentionDays, onSelect, onStop, onDelete, onRefresh, readLog, logLocation }: {
  agentId: string; tasks: ManagedTask[]; selectedId: string | null; theme: PluginTheme; error?: string | null;
  loading: boolean; stopping: string | null; retentionDays: number;
  onSelect(id: string): void; onStop(task: ManagedTask): void; onDelete(task: ManagedTask): Promise<void>;
  onRefresh(): void; readLog: ReadLog; logLocation(taskId: string): Promise<string>;
}) {
  const [tab, setTab] = useState<"running" | "ended">("running");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const selected = tasks.find(task => task.id === selectedId);
  useEffect(() => { setConfirmDelete(false); setDeleteError(null); }, [selectedId]);
  useEffect(() => { if (selected) setTab(isActiveTask(selected) ? "running" : "ended"); }, [selectedId, selected?.state]);
  const filtered = tasks.filter(task => (isActiveTask(task) ? "running" : "ended") === tab);
  return <View style={styles.panel}>
    <View style={styles.toolbar}>
      <View style={styles.buttons}>
        <Action label={`运行中 (${tasks.filter(isActiveTask).length})`} theme={theme} onPress={() => setTab("running")} disabled={tab === "running"} />
        <Action label={`已结束 / 未知 (${tasks.filter(task => !isActiveTask(task)).length})`} theme={theme} onPress={() => setTab("ended")} disabled={tab === "ended"} />
        <Action label="刷新" theme={theme} onPress={onRefresh} disabled={loading} />
      </View>
      <Text style={[styles.meta, { color: theme.colors.foregroundMuted }]}>受管任务 · 结束后日志保留 {retentionDays} 天</Text>
    </View>
    {error && <Text selectable accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error}</Text>}
    <ScrollView style={styles.taskList}>
      {filtered.length ? filtered.map(task => <ManagedRow key={task.id} task={task} theme={theme} selected={task.id === selectedId}
        stopping={stopping === task.id} onSelect={() => onSelect(task.id)} onStop={() => onStop(task)} />)
        : <Text style={[styles.meta, { color: theme.colors.foregroundMuted }]}>{loading ? "正在获取任务…" : "暂无任务。让 agent 使用 task_start 启动后台命令。"}</Text>}
    </ScrollView>
    {selected && !isActiveTask(selected) && <View style={styles.buttons}>
      <Action label={confirmDelete ? "确认永久删除此任务和日志" : "删除此任务和日志"} theme={theme} danger disabled={deleting} onPress={() => {
        if (!confirmDelete) { setConfirmDelete(true); return; }
        setDeleting(true); setDeleteError(null);
        void onDelete(selected).catch(err => setDeleteError(String(err))).finally(() => setDeleting(false));
      }} />
      {confirmDelete && <Action label="取消" theme={theme} disabled={deleting} onPress={() => setConfirmDelete(false)} />}
      {deleteError && <Text style={{ color: theme.colors.statusDanger }}>{deleteError}</Text>}
    </View>}
    {selectedId ? <LogViewer key={`${agentId}:${selectedId}`} agentId={agentId} taskId={selectedId} theme={theme} readLog={readLog} logLocation={logLocation} />
      : <View style={styles.empty}><Icon name="Terminal" color={theme.colors.foregroundMuted} size={24} /><Text style={{ color: theme.colors.foregroundMuted }}>选择任务查看日志</Text></View>}
  </View>;
}
const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 320, padding: 12, gap: 12 },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" },
  action: { minHeight: 32, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  rowContent: { flex: 1, minWidth: 0, gap: 2 },
  command: { fontFamily: monoFont, fontSize: 12, lineHeight: 18 },
  meta: { fontSize: 12, lineHeight: 18 },
  taskList: { maxHeight: 180, flexGrow: 0 },
  viewer: { flex: 1, minHeight: 200, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
  output: { flex: 1, minHeight: 120, borderRadius: 6 },
  outputContent: { padding: 10 },
  outputText: { fontFamily: monoFont, fontSize: 12, lineHeight: 18 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", gap: 8 },
});
