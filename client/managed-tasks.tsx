import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, Pressable, StyleSheet, Text, View, type ScrollView as NativeScrollView } from "react-native";
import { isActiveTask, type LogPage, type ManagedTask } from "../shared/managed";
import { mergeLogPage, plainLog, type LogWindow } from "./log-format";
import { defaultTaskTab, elapsedTime, latestTask, taskTab, type TaskTab } from "./task-presentation";

export const stateLabels: Record<ManagedTask["state"], string> = {
  starting: "启动中", running: "运行中", completed: "已完成", failed: "失败", stopped: "已终止",
  timed_out: "超时", log_limit: "日志达到上限", error: "任务错误", unknown: "状态未知",
};
const monoFont = Platform.select({ web: "Menlo, Monaco, Consolas, monospace", ios: "Menlo", default: "monospace" });
export function Action({ label, onPress, theme, disabled = false, danger = false, compact = false, icon, accessibilityLabel }: {
  label: string; onPress(): void; theme: PluginTheme; disabled?: boolean; danger?: boolean;
  compact?: boolean; icon?: string; accessibilityLabel?: string;
}) {
  const color = danger ? theme.colors.statusDanger : theme.colors.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, compact && styles.touchAction,
      { borderColor: theme.colors.border, backgroundColor: pressed ? theme.colors.surface2 : undefined }, disabled && styles.disabled]}>
    {icon && <Icon name={icon} size={14} color={color} />}
    <Text style={{ color, fontSize: 12 }}>{label}</Text>
  </Pressable>;
}
export function ManagedRow({ task, theme, selected, stopping, onSelect, onStop, compact = false }: {
  task: ManagedTask; theme: PluginTheme; selected?: boolean; stopping: boolean; compact?: boolean;
  onSelect(): void; onStop(): void;
}) {
  return <View style={[styles.row, { borderColor: theme.colors.border, backgroundColor: selected ? theme.colors.surface2 : undefined }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`查看日志 ${task.command}`} accessibilityState={{ selected: !!selected }} aria-selected={!!selected}
      onPress={onSelect} style={[styles.rowContent, compact && styles.touchRow]}>
      <Text numberOfLines={1} style={[styles.command, { color: theme.colors.foreground }]}>{task.command}</Text>
      <Text style={[styles.meta, { color: theme.colors.foregroundMuted }]}>
        {stateLabels[task.state]} · {elapsedTime(task)}{task.exitCode !== null ? ` · 退出码 ${task.exitCode}` : ""}
      </Text>
    </Pressable>
    <Action label="日志" theme={theme} compact={compact} onPress={onSelect} />
    {(isActiveTask(task) || task.state === "unknown") && <Action label={stopping ? "终止中" : "终止"} theme={theme}
      compact={compact} danger disabled={stopping} onPress={onStop} />}
  </View>;
}
export type ReadLog = (input: { agentId: string; taskId: string; before?: number; after?: number; limit?: number }) => Promise<LogPage>;
type Direction = "replace" | "before" | "after";

function LogViewer({ agentId, task, theme, readLog, logLocation, compact, stopping, onBack, onStop, onDelete }: {
  agentId: string; task: ManagedTask; theme: PluginTheme; readLog: ReadLog; compact: boolean;
  logLocation(taskId: string): Promise<string>; stopping: boolean; onBack?(): void;
  onStop(): void; onDelete(): Promise<void>;
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
  const loadRef = useRef<(direction: Direction) => Promise<void>>(async () => {});
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [more, setMore] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
  // Directory snapshots keep this header fresh even when the user is reading older output.
  const currentTask = latestTask(task, window?.task);
  const totalBytes = Math.max(currentTask.logBytes, window?.totalBytes ?? 0);
  const hasNewOutput = !!window && totalBytes > window.end;
  const canPause = following && isActiveTask(currentTask);
  const colors = theme.colors;
  function follow() {
    followingRef.current = true; setFollowing(true);
    void loadRef.current("replace");
    scroll.current?.scrollToEnd({ animated: false });
  }
  async function copy() {
    try { await copyText(text); setNotice("已复制当前加载的日志"); }
    catch (err) { setNotice(String(err)); }
  }
  async function copyLocation() {
    try { await copyText(await logLocation(task.id)); setNotice("已复制主机上的原始日志路径"); }
    catch (err) { setNotice(String(err)); }
    setMore(false);
  }
  async function remove() {
    setDeleting(true); setNotice(null);
    try { await onDelete(); }
    catch (err) { setNotice(String(err)); setDeleting(false); setMore(false); }
  }
  return <View style={styles.viewer}>
    <View style={styles.summary}>
      {onBack && <Action label="任务" icon="ArrowLeft" accessibilityLabel="返回任务列表" compact={compact} theme={theme} onPress={onBack} />}
      <Pressable accessibilityRole="button" accessibilityLabel="任务详情" accessibilityHint="展开完整命令、工作目录和日志信息"
        accessibilityState={{ expanded: details }} aria-expanded={details} onPress={() => setDetails(value => !value)} style={styles.summaryTitle}>
        <View style={styles.titleLine}>
          <Text numberOfLines={1} style={[styles.command, styles.flexText, { color: colors.foreground }]}>{currentTask.command}</Text>
          <Icon name={details ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
        </View>
        <Text style={[styles.meta, { color: colors.foregroundMuted }]}>
          {stateLabels[currentTask.state]} · {elapsedTime(currentTask)}{currentTask.exitCode !== null ? ` · 退出码 ${currentTask.exitCode}` : ""}
        </Text>
      </Pressable>
      {(isActiveTask(currentTask) || currentTask.state === "unknown") && <Action label={stopping ? "终止中" : "终止"}
        compact={compact} danger disabled={stopping} theme={theme} onPress={onStop} />}
    </View>
    {details && <ScrollView style={[styles.details, { backgroundColor: colors.surface2 }]} contentContainerStyle={styles.detailContent}>
      <Text selectable style={[styles.command, { color: colors.foreground }]}>{currentTask.command}</Text>
      <Text selectable style={[styles.meta, { color: colors.foregroundMuted }]}>
        工作目录：{currentTask.cwd}{"\n"}PID：{currentTask.pid ?? "—"} · 日志：{(totalBytes / 1024).toFixed(1)} KiB
        {"\n"}已加载字节：{window?.start ?? 0}–{window?.end ?? 0} · 显示窗口最多 2 MiB
      </Text>
    </ScrollView>}
    <View style={styles.logToolbar}>
      <Text numberOfLines={1} style={[styles.meta, styles.flexText, { color: colors.foregroundMuted }]}>
        {following ? isActiveTask(currentTask) ? "实时跟随" : "日志已结束" : hasNewOutput ? "有新日志" : "已暂停跟随"}
      </Text>
      <View style={styles.primaryActions}>
        <Action label={canPause ? "暂停" : following ? "到底部" : "回到底部"} accessibilityLabel={canPause ? "暂停跟随日志" : "回到底部并跟随日志"}
          compact={compact} theme={theme} onPress={() => {
            if (canPause) { followingRef.current = false; setFollowing(false); } else follow();
          }} />
        <Action label="复制" accessibilityLabel="复制已加载日志" compact={compact} disabled={!text} theme={theme} onPress={() => void copy()} />
        <Action label="更多" compact={compact} theme={theme} onPress={() => { setConfirmDelete(false); setMore(true); }} />
      </View>
    </View>
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
        if (contentOffset.y + layoutMeasurement.height < contentSize.height - 40 && followingRef.current) {
          followingRef.current = false; setFollowing(false);
        }
      }} onContentSizeChange={() => { if (followingRef.current) scroll.current?.scrollToEnd({ animated: false }); }}>
      {window && window.start > 0 && <Action label="加载更早日志" disabled={busy} theme={theme} compact={compact} onPress={() => {
        followingRef.current = false; setFollowing(false); void loadRef.current("before");
      }} />}
      {busy && !window ? <ActivityIndicator color={colors.foregroundMuted} />
        : <Text selectable style={[styles.outputText, { color: colors.foreground }]}>
          {text || (error ? "日志暂不可用，请重试" : isActiveTask(currentTask) ? "等待任务输出…" : "任务没有输出")}
        </Text>}
      {!following && window && window.end < totalBytes && <Action label="加载较新日志" disabled={busy} compact={compact} theme={theme}
        onPress={() => void loadRef.current("after")} />}
    </ScrollView>
    <Modal title={confirmDelete ? "删除任务和日志" : "日志操作"} open={more} onOpenChange={open => { if (!deleting) setMore(open); }}>
      <Modal.Content>
        {confirmDelete ? <>
          <Text style={{ color: colors.foreground }}>将永久删除此任务的记录和日志，无法撤销。</Text>
          <Action label={deleting ? "删除中…" : "确认永久删除"} danger compact theme={theme} disabled={deleting} onPress={() => void remove()} />
          <Action label="取消" compact theme={theme} disabled={deleting} onPress={() => setConfirmDelete(false)} />
        </> : <>
          <Action label={details ? "收起任务详情" : "展开任务详情"} compact theme={theme} onPress={() => { setDetails(value => !value); setMore(false); }} />
          <Action label="复制原始日志路径" compact theme={theme} onPress={() => void copyLocation()} />
          <Action label="刷新到最新日志" compact theme={theme} onPress={() => { setMore(false); follow(); }} />
          {!isActiveTask(currentTask) && <Action label="删除任务和日志" compact danger theme={theme} onPress={() => setConfirmDelete(true)} />}
        </>}
      </Modal.Content>
    </Modal>
  </View>;
}

export function ManagedTaskPanel({ agentId, tasks, selectedId, theme, error, loading, stopping, retentionDays, compact = false,
  onSelect, onStop, onDelete, onRefresh, readLog, logLocation }: {
  agentId: string; tasks: ManagedTask[]; selectedId: string | null; theme: PluginTheme; error?: string | null;
  loading: boolean; stopping: string | null; retentionDays: number; compact?: boolean;
  onSelect(id: string | null): void; onStop(task: ManagedTask): void; onDelete(task: ManagedTask): Promise<void>;
  onRefresh(): void; readLog: ReadLog; logLocation(taskId: string): Promise<string>;
}) {
  const [width, setWidth] = useState(0);
  const narrow = compact || width < 720;
  const [requestedTab, setTab] = useState<TaskTab | null>(null);
  const explicit = tasks.find(task => task.id === selectedId);
  const tab = requestedTab ?? defaultTaskTab(tasks, selectedId);
  useEffect(() => { if (explicit) setTab(taskTab(explicit)); }, [selectedId, explicit?.state]);
  const running = tasks.filter(isActiveTask), ended = tasks.filter(task => !isActiveTask(task));
  const filtered = tab === "running" ? running : ended;
  // Keep the same viewer mounted across running -> ended while the filter catches up.
  // Switching filters explicitly clears the selection through chooseTab().
  const selected = explicit ?? filtered[0];
  const showDetail = !narrow || !!explicit;
  // Persist a desktop's automatic selection so later arrivals do not replace the log being read.
  useEffect(() => { if (!narrow && !loading && selected && !explicit) onSelect(selected.id); }, [narrow, loading, selected?.id, explicit?.id, onSelect]);
  function chooseTab(value: TaskTab) { if (value !== tab) { setTab(value); onSelect(null); } }
  return <View style={styles.panel} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    {error && <Text selectable accessibilityRole="alert" style={[styles.meta, { color: theme.colors.statusDanger }]}>{error}</Text>}
    <View style={[styles.workspace, narrow && styles.narrowWorkspace]}>
      {(!narrow || !showDetail) && <View style={[styles.sidebar, narrow && styles.narrowSidebar,
        !narrow && { borderRightColor: theme.colors.border, borderRightWidth: StyleSheet.hairlineWidth }]}>
        <View style={styles.listHeading}>
          <Text style={[styles.heading, { color: theme.colors.foreground }]}>后台任务</Text>
          <Action label="刷新" compact={narrow} theme={theme} onPress={onRefresh} disabled={loading} />
        </View>
        <View accessibilityRole="tablist" style={[styles.tabs, { backgroundColor: theme.colors.surface1 }]}>
          {([["running", `运行中 ${running.length}`], ["ended", `历史 ${ended.length}`]] as const).map(([value, label]) =>
            <Pressable key={value} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: tab === value }} aria-selected={tab === value}
              onPress={() => chooseTab(value)} style={[styles.tab, narrow && styles.touchAction,
                tab === value && { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border }]}>
              <Text style={{ fontSize: 12, fontWeight: tab === value ? "600" : "400", color: tab === value ? theme.colors.foreground : theme.colors.foregroundMuted }}>{label}</Text>
            </Pressable>)}
        </View>
        <ScrollView style={styles.taskList} contentContainerStyle={styles.taskListContent}>
          {filtered.length ? filtered.map(task => <ManagedRow key={task.id} task={task} theme={theme} compact={narrow}
            selected={!narrow && selected?.id === task.id} stopping={stopping === task.id} onSelect={() => onSelect(task.id)} onStop={() => onStop(task)} />)
            : <View style={styles.emptyList}>
              <Icon name="Terminal" color={theme.colors.foregroundMuted} size={24} />
              <Text style={{ color: theme.colors.foreground }}>{loading ? "正在获取任务…" : tab === "running" ? "没有运行中的任务" : "暂无历史任务"}</Text>
              <Text style={[styles.meta, { color: theme.colors.foregroundMuted }]}>
                {tab === "running" && ended.length ? "已结束任务可在“历史”中查看日志。" : "让 agent 启动后台任务后，会在这里显示。"}
              </Text>
            </View>}
        </ScrollView>
        <Text style={[styles.meta, styles.retention, { color: theme.colors.foregroundMuted }]}>历史日志保留 {retentionDays} 天</Text>
      </View>}
      {showDetail && <View style={styles.detailPane}>
        {selected ? <LogViewer key={`${agentId}:${selected.id}`} agentId={agentId} task={selected} theme={theme} compact={narrow}
          stopping={stopping === selected.id} onBack={narrow ? () => onSelect(null) : undefined} onStop={() => onStop(selected)}
          onDelete={() => onDelete(selected)} readLog={readLog} logLocation={logLocation} />
          : <View style={styles.empty}><Icon name="Terminal" color={theme.colors.foregroundMuted} size={24} />
            <Text style={{ color: theme.colors.foregroundMuted }}>选择任务查看日志</Text></View>}
      </View>}
    </View>
  </View>;
}
const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 280, minWidth: 0 },
  workspace: { flex: 1, minHeight: 0, minWidth: 0, flexDirection: "row" },
  narrowWorkspace: { flexDirection: "column" },
  sidebar: { width: 304, maxWidth: "42%", minHeight: 0, padding: 12, gap: 10 },
  narrowSidebar: { flex: 1, width: "100%", maxWidth: "100%" },
  listHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  heading: { fontSize: 14, fontWeight: "600" },
  tabs: { flexDirection: "row", padding: 3, borderRadius: 8, gap: 3 },
  tab: { flex: 1, minWidth: 0, minHeight: 32, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "transparent", borderRadius: 6 },
  action: { minHeight: 32, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row", gap: 4, alignItems: "center", justifyContent: "center" },
  touchAction: { minHeight: 44, minWidth: 44 },
  disabled: { opacity: 0.5 },
  row: { flexDirection: "row", alignItems: "center", minWidth: 0, gap: 6, paddingVertical: 8, paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderRadius: 6 },
  rowContent: { flex: 1, minWidth: 0, minHeight: 40, justifyContent: "center", gap: 2 },
  touchRow: { minHeight: 44 },
  command: { fontFamily: monoFont, fontSize: 12, lineHeight: 18 },
  meta: { fontSize: 12, lineHeight: 18 },
  flexText: { flex: 1, minWidth: 0 },
  taskList: { flex: 1, minHeight: 0 },
  taskListContent: { gap: 2 },
  retention: { paddingTop: 4 },
  detailPane: { flex: 1, minWidth: 0, minHeight: 0, padding: 12 },
  viewer: { flex: 1, minWidth: 0, minHeight: 0, gap: 10 },
  summary: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  summaryTitle: { flex: 1, minWidth: 0, gap: 2, paddingVertical: 4 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 4 },
  details: { maxHeight: 160, flexGrow: 0, borderRadius: 6 },
  detailContent: { padding: 10, gap: 8 },
  logToolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minWidth: 0, gap: 6 },
  primaryActions: { flexDirection: "row", flexShrink: 0, gap: 6 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  output: { flex: 1, minHeight: 0, borderRadius: 6 },
  outputContent: { padding: 10, gap: 8 },
  outputText: { fontFamily: monoFont, fontSize: 12, lineHeight: 18 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", gap: 8 },
  emptyList: { paddingVertical: 32, alignItems: "center", gap: 10 },
});
