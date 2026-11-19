import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";

import type { ManagedTask } from "../shared/managed";
import { stateLabels, taskTitle, taskTone } from "./task-presentation";

export const completionNoticeSchema = z.object({ taskIds: z.array(z.string().uuid()).max(8).default([]) });

export function CompletionNotice({ taskIds, tasks, theme, loading, error, compact, onOpen, onRetry }: {
  taskIds: string[]; tasks: ManagedTask[]; theme: PluginTheme; loading: boolean; error?: string | null;
  compact: boolean; onOpen(taskId: string): void; onRetry(): void;
}) {
  const colors = theme.colors;
  return <View style={{ gap: 6, paddingVertical: 8, width: "100%", maxWidth: 480, alignSelf: "flex-start" }}>
    {taskIds.length === 0 && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>后台任务已结束</Text>}
    {taskIds.map(id => {
      const task = tasks.find(task => task.id === id);
      const color = task ? colors[taskTone(task.state)] : colors.foregroundMuted;
      const failed = task && taskTone(task.state) === "statusDanger";
      return <Pressable key={id} accessibilityRole="button" disabled={!task}
        accessibilityLabel={task ? `查看日志 ${taskTitle(task)}` : "任务结果不可用"}
        onPress={() => onOpen(id)} style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10,
          paddingVertical: 9, minHeight: compact ? 48 : 44, borderRadius: 6,
          borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.surface2 : colors.surface1,
        })}>
        <Icon name={failed ? "CircleAlert" : task?.state === "completed" ? "CheckCircle" : "CircleHelp"} size={16} color={color} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>
            {task ? taskTitle(task) : "后台任务"}
          </Text>
          <Text style={{ color, fontSize: 12, lineHeight: 18 }}>
            {task ? `${stateLabels[task.state]}${task.exitCode !== null ? ` · 退出码 ${task.exitCode}` : ""}`
              : loading ? "正在获取结果…" : error ? "暂时无法获取结果" : "记录已删除或超过保留期限"}
          </Text>
        </View>
        {task && <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />}
      </Pressable>;
    })}
    {error && <Pressable accessibilityRole="button" accessibilityLabel="重试获取任务结果" onPress={onRetry}
      style={{ minHeight: compact ? 44 : 32, justifyContent: "center" }}>
      <Text style={{ color: colors.accent, fontSize: 12 }}>重试获取任务结果</Text>
    </Pressable>}
  </View>;
}
