import { InteractivePressable } from "./interactive-pressable";
import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, StyleSheet, Text, TextInput, View, type ScrollView as NativeScrollView } from "react-native";
import { isActiveTask, type LogPage, type ManagedTask } from "../shared/managed";
import { mergeLogPage, plainLog, type LogWindow } from "./log-format";
import { latestTask, taskTitle } from "./task-presentation";
import { TaskStatus } from "./task-status";

export { stateLabels } from "./task-presentation";
const monoFont = Platform.select({ web: "Menlo, Monaco, Consolas, monospace", ios: "Menlo", default: "monospace" });
export function Action({ label, onPress, theme, disabled = false, danger = false, compact = false, icon, accessibilityLabel }: {
  label: string; onPress(): void; theme: PluginTheme; disabled?: boolean; danger?: boolean;
  compact?: boolean; icon?: string; accessibilityLabel?: string;
}) {
  const color = danger ? theme.colors.statusDanger : theme.colors.foreground;
  return <InteractivePressable theme={theme} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, compact && styles.touchAction,
      { borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surface2 : undefined }, disabled && styles.disabled]}>
    {icon && <Icon name={icon} size={14} color={color} />}
    <Text style={{ color, fontSize: 12 }}>{label}</Text>
  </InteractivePressable>;
}
export function ManagedRow({ task, theme, selected, stopping, onSelect, onStop, compact = false }: {
  task: ManagedTask; theme: PluginTheme; selected?: boolean; stopping: boolean; compact?: boolean;
  onSelect(): void; onStop(): void;
}) {
  return <View style={[styles.row, { borderColor: theme.colors.border, backgroundColor: selected ? theme.colors.surface2 : undefined }]}>
    <InteractivePressable theme={theme} accessibilityRole="button" accessibilityLabel={`查看日志 ${taskTitle(task)}`} accessibilityState={{ selected: !!selected }} aria-selected={!!selected}
      onPress={onSelect} style={[styles.rowContent, compact && styles.touchRow]}>
      <View style={styles.titleLine}>
        <Text numberOfLines={1} style={[styles.taskTitle, styles.flexText, { color: theme.colors.foreground }]}>{taskTitle(task)}</Text>
        <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
      </View>
      <Text numberOfLines={1} style={[styles.command, { color: theme.colors.foregroundMuted }]}>{task.command}</Text>
      <TaskStatus task={task} theme={theme} />
    </InteractivePressable>
    {(isActiveTask(task) || task.state === "unknown") && <Action label={stopping ? "终止中" : "终止"} theme={theme}
      compact={compact} danger disabled={stopping} onPress={onStop} />}
  </View>;
}
export type ReadLog = (input: { agentId: string; taskId: string; before?: number; after?: number; limit?: number }) => Promise<LogPage>;
type Direction = "replace" | "before" | "after";

function LogViewer({ agentId, task, theme, readLog, logLocation, compact, stopping, onStop }: {
  agentId: string; task: ManagedTask; theme: PluginTheme; readLog: ReadLog; compact: boolean;
  logLocation(taskId: string): Promise<string>; stopping: boolean;
  onStop(): void;
}) {
  const [window, setWindow] = useState<LogWindow | null>(null);
  const windowRef = useRef<LogWindow | null>(null);
  const taskRef = useRef(task);
  taskRef.current = task;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const scroll = useRef<NativeScrollView>(null);
  const lastScrollY = useRef(0);
  const loadRef = useRef<(direction: Direction) => Promise<void>>(async () => {});
  const [notice, setNotice] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let disposed = false, pending = false, replaceQueued = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load(direction: Direction) {
      if (disposed) return;
      // A click on "back to bottom" must survive an earlier in-flight history request.
      if (pending) { if (direction === "replace") replaceQueued = true; return; }
      pending = true; setBusy(true);
      try {
        const current = windowRef.current;
        const page = await readLog({ agentId, taskId: taskRef.current.id,
          ...(direction === "before" && current ? { before: current.start } : {}),
          ...(direction === "after" && current ? { after: current.end } : {}),
        });
        if (disposed) return;
        const next = mergeLogPage(current, page, direction);
        windowRef.current = next; setWindow(next); setError(null);
      } catch (err) { if (!disposed) setError(String(err)); }
      finally {
        pending = false;
        if (!disposed) {
          setBusy(false);
          if (replaceQueued) { replaceQueued = false; void load("replace"); }
        }
      }
    }
    loadRef.current = load;
    async function poll() {
      if (disposed) return;
      if (followingRef.current && (AppState.currentState === "active" || AppState.currentState === null)) {
        const current = windowRef.current;
        const latest = latestTask(taskRef.current, current?.task);
        if (!current || isActiveTask(latest) || current.end < Math.max(latest.logBytes, current.totalBytes)) {
          await load(current ? "after" : "replace");
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 500);
    }
    void load("replace").then(() => { if (!disposed) timer = setTimeout(() => void poll(), 500); });
    return () => { disposed = true; clearTimeout(timer); };
  }, [agentId, task.id, readLog]);

  const pages = window?.pages;
  const text = useMemo(() => plainLog(pages?.map(page => page.text).join("") ?? ""), [pages]);
  const matches = useMemo(() => query ? text.split("\n").filter(line => line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : null, [text, query]);
  const displayedText = matches ? matches.join("\n") : text;
  // Directory snapshots keep this header fresh even when the user is reading older output.
  const currentTask = latestTask(task, window?.task);
  const totalBytes = Math.max(currentTask.logBytes, window?.totalBytes ?? 0);
  const hasNewOutput = !!window && totalBytes > window.end;
  const colors = theme.colors;
  function follow() {
    followingRef.current = true; setFollowing(true);
    void loadRef.current("replace");
    scroll.current?.scrollToEnd({ animated: false });
  }
  function pause() { followingRef.current = false; setFollowing(false); }
  function toggleSearch() {
    setSearching(value => !value); setQuery("");
    if (!searching) pause();
  }
  async function copy() {
    try { await copyText(text); setNotice("已复制当前加载的日志"); }
    catch (err) { setNotice(String(err)); }
  }
  async function copyLocation() {
    try { await copyText(await logLocation(task.id)); setNotice("已复制主机上的原始日志路径"); }
    catch (err) { setNotice(String(err)); }
  }
  return <View style={styles.viewer}>
    <View style={styles.summary}>
      <View style={styles.summaryTitle}>
        <View style={styles.titleLine}>
          <Text numberOfLines={1} style={[styles.taskTitle, styles.flexText, { color: colors.foreground }]}>{taskTitle(currentTask)}</Text>
        </View>
        <TaskStatus task={currentTask} theme={theme} />
      </View>
      {(isActiveTask(currentTask) || currentTask.state === "unknown") && <Action label={stopping ? "终止中" : "终止"}
        compact={compact} danger disabled={stopping} theme={theme} onPress={onStop} />}
    </View>
    <ScrollView style={[styles.details, { backgroundColor: colors.surface2 }]} contentContainerStyle={styles.detailContent}>
      <Text selectable style={[styles.command, { color: colors.foreground }]}>{currentTask.command}</Text>
      {currentTask.instruction && <Text selectable style={[styles.meta, { color: colors.foregroundMuted }]}>完成后：{currentTask.instruction}</Text>}
      <Text selectable style={[styles.meta, { color: colors.foregroundMuted }]}>
        工作目录：{currentTask.cwd}{"\n"}PID：{currentTask.pid ?? "—"} · 日志：{(totalBytes / 1024).toFixed(1)} KiB
        {"\n"}已加载字节：{window?.start ?? 0}–{window?.end ?? 0} · 显示窗口最多 2 MiB
      </Text>
      <Action label="复制原始日志路径" compact={compact} theme={theme} onPress={() => void copyLocation()} />
    </ScrollView>
    <View style={styles.logToolbar}>
      <Text style={[styles.meta, { color: colors.foregroundMuted }]}>日志</Text>
      <View style={styles.primaryActions}>
        <Action label={following ? "暂停" : "跟随"} accessibilityLabel={following ? "暂停跟随日志" : "回到底部并跟随日志"}
          compact={compact} theme={theme} onPress={following ? pause : follow} />
        <Action label={searching ? "收起" : "搜索"} accessibilityLabel={searching ? "收起日志搜索" : "搜索日志"}
          compact={compact} theme={theme} onPress={toggleSearch} />
        <Action label="复制" accessibilityLabel="复制已加载日志" disabled={!text} compact={compact} theme={theme} onPress={() => void copy()} />
      </View>
    </View>
    <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: hasNewOutput ? colors.accent : colors.foregroundMuted }]}>
      {following ? isActiveTask(currentTask) ? "实时跟随" : "日志已结束" : hasNewOutput ? "已暂停跟随 · 有新日志" : "已暂停跟随"}
    </Text>
    {searching && <View style={{ gap: 4 }}>
      <TextInput accessibilityLabel="搜索已加载日志" placeholder="搜索已加载日志" placeholderTextColor={colors.foregroundMuted}
        value={query} onChangeText={setQuery} autoFocus autoCapitalize="none" autoCorrect={false}
        style={[styles.searchInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface1 }]} />
      <Text style={[styles.meta, { color: colors.foregroundMuted }]}>{query ? `${matches?.length ?? 0} 行匹配 · ` : ""}仅搜索已加载日志，可加载更早内容扩大范围</Text>
    </View>}
    {currentTask.logTruncated && <Text accessibilityRole="alert" style={[styles.meta, { color: colors.statusDanger }]}>
      日志采集已中断：{currentTask.error ?? "达到容量上限，任务已停止。当前保存的内容不是完整输出。"}
    </Text>}
    {!currentTask.logTruncated && currentTask.error && <Text selectable accessibilityRole="alert" style={{ color: colors.statusDanger }}>{currentTask.error}</Text>}
    {error && <View style={styles.errorRow}>
      <Text selectable accessibilityRole="alert" style={[styles.flexText, styles.meta, { color: colors.statusDanger }]}>{error}</Text>
      <Action label="重试" compact={compact} disabled={busy} theme={theme} onPress={() => void loadRef.current(windowRef.current ? "after" : "replace")} />
    </View>}
    {notice && <Text selectable accessibilityLiveRegion="polite" style={[styles.meta, { color: colors.foregroundMuted }]}>{notice}</Text>}
    <ScrollView ref={scroll} style={[styles.output, { backgroundColor: colors.surface1 }]} contentContainerStyle={styles.outputContent}
      scrollEventThrottle={100} onScroll={(event) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        if (contentOffset.y < lastScrollY.current && contentOffset.y + layoutMeasurement.height < contentSize.height - 40 && followingRef.current) {
          followingRef.current = false; setFollowing(false);
        }
        lastScrollY.current = contentOffset.y;
      }} onContentSizeChange={() => { if (followingRef.current) scroll.current?.scrollToEnd({ animated: false }); }}>
      {window && window.start > 0 && <Action label="加载更早日志" disabled={busy} theme={theme} compact={compact} onPress={() => {
        followingRef.current = false; setFollowing(false); void loadRef.current("before");
      }} />}
      {busy && !window ? <ActivityIndicator color={colors.foregroundMuted} />
        : <Text selectable style={[styles.outputText, { color: colors.foreground }]}>
          {displayedText || (query ? "没有匹配的日志" : error ? "日志暂不可用，请重试" : isActiveTask(currentTask) ? "等待任务输出…" : "任务没有输出")}
        </Text>}
      {!following && window && window.end < totalBytes && <Action label="加载较新日志" disabled={busy} compact={compact} theme={theme}
        onPress={() => void loadRef.current("after")} />}
    </ScrollView>
  </View>;
}

export function TaskLogSidebar({ agentId, task, theme, error, loading, stopping, compact = false,
  onStop, onRefresh, readLog, logLocation }: {
  agentId: string; task?: ManagedTask; theme: PluginTheme; error?: string | null;
  loading: boolean; stopping: string | null; compact?: boolean;
  onStop(task: ManagedTask): void;
  onRefresh(): void; readLog: ReadLog; logLocation(taskId: string): Promise<string>;
}) {
  const [width, setWidth] = useState(0);
  const narrow = compact || width < 720;
  return <View style={styles.logSidebar} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    {error && <View style={styles.errorRow}>
      <Text selectable accessibilityRole="alert" style={[styles.meta, styles.flexText, { color: theme.colors.statusDanger }]}>{error}</Text>
      <Action label="重试" compact={narrow} theme={theme} onPress={onRefresh} disabled={loading} />
    </View>}
    {task ? <LogViewer key={`${agentId}:${task.id}`} agentId={agentId} task={task} theme={theme} compact={narrow}
      stopping={stopping === task.id} onStop={() => onStop(task)} readLog={readLog} logLocation={logLocation} />
      : <View style={styles.empty}>
        {loading ? <ActivityIndicator color={theme.colors.foregroundMuted} /> : <Icon name="Terminal" color={theme.colors.foregroundMuted} size={24} />}
        <Text style={{ color: theme.colors.foregroundMuted }}>{loading ? "正在加载任务…" : "从后台任务列表选择任务查看日志"}</Text>
      </View>}
  </View>;
}
const styles = StyleSheet.create({
  logSidebar: { flex: 1, minHeight: 280, minWidth: 0, padding: 12, gap: 10 },
  action: { minHeight: 32, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row", gap: 4, alignItems: "center", justifyContent: "center" },
  touchAction: { minHeight: 44, minWidth: 44 },
  disabled: { opacity: 0.5 },
  row: { flexDirection: "row", alignItems: "center", minWidth: 0, gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderRadius: 6 },
  rowContent: { borderRadius: 6, padding: 8, flex: 1, minWidth: 0, minHeight: 40, justifyContent: "center", gap: 4 },
  touchRow: { minHeight: 44 },
  command: { fontFamily: monoFont, fontSize: 12, lineHeight: 18 },
  taskTitle: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  meta: { fontSize: 12, lineHeight: 18 },
  flexText: { flex: 1, minWidth: 0 },
  viewer: { flex: 1, minWidth: 0, minHeight: 0, gap: 10 },
  summary: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  summaryTitle: { borderRadius: 4, flex: 1, minWidth: 0, gap: 2, paddingVertical: 4, paddingHorizontal: 6 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 4 },
  details: { maxHeight: 160, flexGrow: 0, borderRadius: 6 },
  detailContent: { padding: 10, gap: 8 },
  logToolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", minWidth: 0, gap: 6 },
  primaryActions: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  searchInput: { minHeight: 44, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  output: { flex: 1, minHeight: 0, borderRadius: 6 },
  outputContent: { padding: 10, gap: 8 },
  outputText: { fontFamily: monoFont, fontSize: 13, lineHeight: 20 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", gap: 8 },
});
