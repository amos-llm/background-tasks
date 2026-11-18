import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { z } from "zod";

export const completionNoticeSchema = z.object({});

export function CompletionNotice({ theme }: PluginTimelineItemProps<z.infer<typeof completionNoticeSchema>>) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 }}>
    <Icon name="CheckCircle" size={16} color={theme.colors.foregroundMuted} />
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>后台任务已完成</Text>
  </View>;
}
