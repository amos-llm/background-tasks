import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { Task } from "../shared/tasks";
import { isActiveTask, type ManagedTask } from "../shared/managed";
import { ManagedRow } from "./managed-tasks";

export interface TaskListState {
  tasks: Task[];
  error: string | null;
  supported: boolean;
  loading: boolean;
  managedTasks: ManagedTask[];
}
interface TaskPopoverProps {
  state?: TaskListState;
  theme: PluginTheme;
  compact: boolean;
  stopping: string | null;
  actionError: string | null;
  onRefresh(): Promise<void>;
  onStop(task: Task): void;
  onStopManaged(task: ManagedTask): void;
  onOpenLogs(taskId: string): void;
}
const monoFont = Platform.select({
  web: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  ios: "Menlo",
  default: "monospace",
});
function elapsed(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return total + "s";
  if (total < 3600) return Math.floor(total / 60) + "m " + String(total % 60).padStart(2, "0") + "s";
  return Math.floor(total / 3600) + "h " + String(Math.floor(total / 60) % 60).padStart(2, "0") + "m";
}
function TaskRow({ task, theme, compact, stopping, disabled, onStop }: {
  task: Task; theme: PluginTheme; compact: boolean; stopping: boolean; disabled: boolean; onStop(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [stopHovered, setStopHovered] = useState(false);
  const colors = theme.colors;
  return <View
    onPointerEnter={() => setHovered(true)}
    onPointerLeave={() => setHovered(false)}
    style={[styles.row, hovered && { backgroundColor: colors.surface2 }]}
  >
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={task.command}
      accessibilityHint={expanded ? "收起命令详情" : "展开完整命令和工作目录"}
      accessibilityState={{ expanded }}
      onPress={() => setExpanded((value) => !value)}
      style={({ pressed }) => [styles.task, compact && styles.taskCompact, pressed && { backgroundColor: colors.surface2 }]}
    >
      <View style={styles.leading}><Icon name="Terminal" size={14} color={colors.foregroundMuted} /></View>
      <View style={styles.content}>
        <Text selectable={expanded} numberOfLines={expanded ? undefined : 1}
          style={[styles.command, { color: colors.foreground }]}>{task.command}</Text>
        <Text style={[styles.meta, { color: colors.foregroundMuted }]}>PID {task.pid} · {elapsed(task.elapsedSeconds)}</Text>
        {expanded && <Text selectable style={[styles.directory, { color: colors.foregroundMuted }]}>{task.cwd}</Text>}
      </View>
      <View style={styles.disclosure}>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={12} color={colors.foregroundMuted} />
      </View>
    </Pressable>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={"终止进程 " + task.pid}
      accessibilityHint="停止此命令及其子进程"
      accessibilityState={{ disabled, busy: stopping }}
      disabled={disabled}
      onHoverIn={() => setStopHovered(true)}
      onHoverOut={() => setStopHovered(false)}
      onPress={onStop}
      style={({ pressed }) => [
        styles.stop, compact && styles.stopCompact,
        (pressed || stopHovered) && { backgroundColor: colors.surface1 },
        disabled && styles.disabled,
      ]}
    >
      {stopping && <ActivityIndicator size="small" color={colors.foregroundMuted} />}
      <Text style={[styles.actionLabel, { color: stopping ? colors.foregroundMuted : colors.statusDanger }]}>
        {stopping ? "终止中" : "终止"}
      </Text>
    </Pressable>
  </View>;
}
export function TaskPopover({ state, theme, compact, stopping, actionError, onRefresh, onStop, onStopManaged, onOpenLogs }: TaskPopoverProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshHovered, setRefreshHovered] = useState(false);
  const colors = theme.colors;
  const error = actionError || state?.error;
  const loading = !state || state.loading;
  const busy = refreshing || loading;
  const managed = state?.managedTasks.filter(isActiveTask) ?? [];
  const count = (state?.tasks.length ?? 0) + managed.length;
  async function refresh() {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  }
  return <View style={[styles.popover, compact && styles.popoverCompact]}>
    <View style={styles.toolbar}>
      <Text style={[styles.caption, { color: colors.foregroundMuted }]}>
        当前会话{!loading && state?.supported ? " · " + count + " 个任务" : ""}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="刷新后台任务"
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onHoverIn={() => setRefreshHovered(true)}
        onHoverOut={() => setRefreshHovered(false)}
        onPress={() => void refresh()}
        style={({ pressed }) => [
          styles.refresh, compact && styles.refreshCompact,
          (pressed || refreshHovered) && { backgroundColor: colors.surface2 },
          busy && styles.disabled,
        ]}
      >
        {refreshing ? <ActivityIndicator size="small" color={colors.foregroundMuted} />
          : <Icon name="RefreshCw" size={14} color={colors.foregroundMuted} />}
      </Pressable>
    </View>
    {error && <View accessibilityRole="alert" style={[styles.error, { borderColor: colors.border }]}>
      <Icon name="CircleAlert" size={14} color={colors.statusDanger} />
      <Text selectable style={[styles.errorText, { color: colors.statusDanger }]}>{error}</Text>
    </View>}
    {loading ? <View style={styles.message}>
      <ActivityIndicator size="small" color={colors.foregroundMuted} />
      <Text style={[styles.caption, { color: colors.foregroundMuted }]}>正在获取任务…</Text>
    </View> : !state.supported ? <View style={styles.empty}>
      <Icon name="CircleAlert" size={20} color={colors.foregroundMuted} />
      <Text style={[styles.messageTitle, { color: colors.foreground }]}>暂不支持此主机</Text>
      <Text style={[styles.caption, { color: colors.foregroundMuted }]}>需要连接 Linux 主机查看进程。</Text>
    </View> : count === 0 && !error ? <View style={styles.empty}>
      <Icon name="Terminal" size={20} color={colors.foregroundMuted} />
      <Text style={[styles.messageTitle, { color: colors.foreground }]}>没有后台任务</Text>
      <Text style={[styles.caption, { color: colors.foregroundMuted }]}>当前会话没有正在运行的命令</Text>
    </View> : <View style={styles.list}>
      {managed.map(task => <ManagedRow key={task.id} task={task} theme={theme} compact={compact}
        stopping={stopping === task.id} onSelect={() => onOpenLogs(task.id)} onStop={() => onStopManaged(task)} />)}
      {state.tasks.map((task) => <TaskRow key={task.token} task={task} theme={theme} compact={compact}
        stopping={stopping === task.token} disabled={stopping !== null || !!state.error}
        onStop={() => onStop(task)} />)}
    </View>}
    {!!state?.tasks.length && <Text style={[styles.caption, { color: colors.foregroundMuted }]}>外部任务仅提供进程信息；完整日志需要通过 task_start 启动。</Text>}
  </View>;
}
// Paseo 0.15 menu spacing (4/8/12), md radius (6), sm/base typography
// (12/14). The host owns the popover/sheet, outer padding and scrolling.
const styles = StyleSheet.create({
  popover: { width: 336, maxWidth: "100%", gap: 4 },
  popoverCompact: { width: "100%" },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 28 },
  caption: { fontSize: 12, lineHeight: 18 },
  refresh: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 6 },
  refreshCompact: { width: 40, height: 40 },
  list: { gap: 2, marginHorizontal: -8 },
  row: { flexDirection: "row", alignItems: "flex-start", borderRadius: 6, paddingRight: 4 },
  task: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 8, borderRadius: 6 },
  taskCompact: { paddingVertical: 12 },
  leading: { width: 16, height: 18, alignItems: "center", justifyContent: "center" },
  content: { flex: 1, minWidth: 0, gap: 2 },
  command: { fontFamily: monoFont, fontSize: 12, lineHeight: 18 },
  meta: { fontSize: 12, lineHeight: 18, fontVariant: ["tabular-nums"] },
  directory: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  disclosure: { height: 18, justifyContent: "center" },
  stop: { minWidth: 52, minHeight: 28, marginTop: 4, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, borderRadius: 6 },
  stopCompact: { minWidth: 60, minHeight: 40, marginTop: 6 },
  actionLabel: { fontSize: 12, lineHeight: 18 },
  disabled: { opacity: 0.5 },
  message: { minHeight: 88, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  empty: { paddingVertical: 24, alignItems: "center", gap: 8 },
  messageTitle: { fontSize: 14, lineHeight: 20 },
  error: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  errorText: { flex: 1, fontSize: 12, lineHeight: 18 },
});
