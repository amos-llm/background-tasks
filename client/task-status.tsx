import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { ManagedTask } from "../shared/managed";
import { elapsedTime, stateLabels, taskTone } from "./task-presentation";

export function TaskStatus({ task, theme }: { task: ManagedTask; theme: PluginTheme }) {
  const color = theme.colors[taskTone(task.state)];
  return <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 6, rowGap: 2 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ fontSize: 12, lineHeight: 18, fontWeight: "600", color }}>{stateLabels[task.state]}</Text>
    </View>
    <Text style={{ fontSize: 12, lineHeight: 18, color: theme.colors.foregroundMuted }}>
      · {elapsedTime(task)}{task.exitCode !== null ? ` · 退出码 ${task.exitCode}` : ""}
    </Text>
  </View>;
}
