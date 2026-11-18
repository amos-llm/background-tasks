import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { isActiveTask, type ManagedTask } from "../shared/managed";
import { ManagedRow } from "./managed-tasks";

export interface TaskListState {
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
  onStopManaged(task: ManagedTask): void;
  onOpenLogs(taskId: string): void;
}
export function TaskPopover({ state, theme, compact, stopping, actionError, onRefresh, onStopManaged, onOpenLogs }: TaskPopoverProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshHovered, setRefreshHovered] = useState(false);
  const colors = theme.colors;
  const error = actionError || state?.error;
  const loading = !state || state.loading;
  const busy = refreshing || loading;
  const managed = state?.managedTasks.filter(isActiveTask) ?? [];
  const count = managed.length;
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
      <Text style={[styles.caption, { color: colors.foregroundMuted }]}>需要连接 Linux 主机查看后台任务。</Text>
    </View> : count === 0 && !error ? <View style={styles.empty}>
      <Icon name="Terminal" size={20} color={colors.foregroundMuted} />
      <Text style={[styles.messageTitle, { color: colors.foreground }]}>没有后台任务</Text>
      <Text style={[styles.caption, { color: colors.foregroundMuted }]}>当前会话没有正在运行的后台任务</Text>
    </View> : <View style={styles.list}>
      {managed.map(task => <ManagedRow key={task.id} task={task} theme={theme} compact={compact}
        stopping={stopping === task.id} onSelect={() => onOpenLogs(task.id)} onStop={() => onStopManaged(task)} />)}
    </View>}
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
  disabled: { opacity: 0.5 },
  message: { minHeight: 88, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  empty: { paddingVertical: 24, alignItems: "center", gap: 8 },
  messageTitle: { fontSize: 14, lineHeight: 20 },
  error: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  errorText: { flex: 1, fontSize: 12, lineHeight: 18 },
});
