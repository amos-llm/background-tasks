import { InteractivePressable } from "./interactive-pressable";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { isActiveTask, type ManagedTask } from "../shared/managed";
import { ManagedRow } from "./managed-tasks";
import { taskPillPresentation } from "./task-presentation";

export interface TaskListState {
  error: string | null;
  supported: boolean;
  loading: boolean;
  managedTasks: ManagedTask[];
  retentionDays?: number;
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
  const [section, setSection] = useState<"active" | "recent">("active");
  const colors = theme.colors;
  const error = actionError || state?.error;
  const loading = !state || state.loading;
  const busy = refreshing || loading;
  const managed = state?.managedTasks.filter(isActiveTask) ?? [];
  const recent = state?.managedTasks.filter(task => !isActiveTask(task))
    .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt)) ?? [];
  useEffect(() => { if (managed.length === 0 && recent.length > 0) setSection("recent"); }, [managed.length, recent.length]);
  const shown = section === "active" ? managed : recent.slice(0, 20);
  const count = managed.length;
  async function refresh() {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  }
  return <View style={[styles.popover, compact && styles.popoverCompact]}>
    <View style={styles.toolbar}>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={[styles.caption, { color: colors.foregroundMuted }]}>当前会话</Text>
        {!loading && state?.supported && <Text style={[styles.caption, { color: colors.foregroundMuted }]}>
          {taskPillPresentation(state.managedTasks, !!state.error).summary}
        </Text>}
      </View>
      <InteractivePressable theme={theme}
        accessibilityRole="button"
        accessibilityLabel="刷新后台任务"
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={() => void refresh()}
        style={({ pressed }) => [
          styles.refresh, compact && styles.refreshCompact,
          pressed && { backgroundColor: colors.surface2 },
          busy && styles.disabled,
        ]}
      >
        {refreshing ? <ActivityIndicator size="small" color={colors.foregroundMuted} />
          : <Icon name="RefreshCw" size={14} color={colors.foregroundMuted} />}
      </InteractivePressable>
    </View>
    {!loading && state?.supported && <View style={[styles.sections, { backgroundColor: colors.surface2 }]}>
      {([{ id: "active", title: "运行中", count }, { id: "recent", title: "最近结束", count: recent.length }] as const).map(item => <InteractivePressable theme={theme} key={item.id}
        accessibilityRole="button" accessibilityLabel={`${item.title}任务`} accessibilityState={{ selected: section === item.id }}
        hoverColor={colors.surface1} onPress={() => setSection(item.id)} style={[styles.section, compact && styles.sectionCompact,
          section === item.id && { backgroundColor: colors.surface1 }]}>
        <Text style={{ fontSize: 12, fontWeight: section === item.id ? "600" : "400", color: section === item.id ? colors.foreground : colors.foregroundMuted }}>
          {item.title} · {item.count}
        </Text>
      </InteractivePressable>)}
    </View>}
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
    </View> : shown.length === 0 && !error ? <View style={styles.empty}>
      <Icon name="Terminal" size={20} color={colors.foregroundMuted} />
      <Text style={[styles.messageTitle, { color: colors.foreground }]}>{section === "active" ? "没有运行中的任务" : "暂无任务记录"}</Text>
      <Text style={[styles.caption, { color: colors.foregroundMuted }]}>{section === "active" ? "已结束任务可在“最近结束”中查看" : "任务结束后，可以在这里重新打开日志"}</Text>
    </View> : <View style={styles.list}>
      {shown.map(task => <ManagedRow key={task.id} task={task} theme={theme} compact={compact}
        stopping={stopping === task.id} onSelect={() => onOpenLogs(task.id)} onStop={() => onStopManaged(task)} />)}
    </View>}
    {section === "recent" && recent.length > 0 && <Text style={[styles.caption, styles.footer, { color: colors.foregroundMuted }]}>
      {recent.length > 20 ? "显示最近 20 条 · " : ""}日志保留 {state?.retentionDays ?? 7} 天
    </Text>}
  </View>;
}
// Paseo 0.15 menu spacing (4/8/12), md radius (6), sm/base typography
// (12/14). Keep an inner gutter in addition to the host's popover/sheet padding.
// Rows must not extend into that gutter on either desktop or mobile.
const styles = StyleSheet.create({
  popover: { width: 336, maxWidth: "100%", paddingHorizontal: 8, paddingTop: 4, paddingBottom: 8, gap: 8 },
  popoverCompact: { width: "100%" },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 28 },
  caption: { fontSize: 12, lineHeight: 18 },
  refresh: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 6 },
  refreshCompact: { width: 40, height: 40 },
  list: { gap: 2 },
  sections: { flexDirection: "row", padding: 3, borderRadius: 6, gap: 3, marginBottom: 4 },
  section: { flex: 1, minHeight: 30, alignItems: "center", justifyContent: "center", borderRadius: 4 },
  sectionCompact: { minHeight: 44 },
  footer: { paddingTop: 8 },
  disabled: { opacity: 0.5 },
  message: { minHeight: 88, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  empty: { paddingVertical: 24, alignItems: "center", gap: 8 },
  messageTitle: { fontSize: 14, lineHeight: 20 },
  error: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  errorText: { flex: 1, fontSize: 12, lineHeight: 18 },
});
