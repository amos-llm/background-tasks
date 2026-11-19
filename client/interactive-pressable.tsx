import type { PluginTheme } from "@getpaseo/plugin";
import { useState, type ComponentProps } from "react";
import { Platform, Pressable } from "react-native";

type Props = ComponentProps<typeof Pressable> & {
  theme: PluginTheme;
  hoverColor?: string;
};

// Native Pressable exposes pressed state, but not web hover/focus in its style
// callback. Track these explicitly so every clickable surface has feedback.
export function InteractivePressable({ theme, hoverColor, disabled, style, onHoverIn, onHoverOut, onFocus, onBlur, ...props }: Props) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return <Pressable accessibilityRole="button" {...props} disabled={disabled}
    onHoverIn={event => { setHovered(true); onHoverIn?.(event); }}
    onHoverOut={event => { setHovered(false); onHoverOut?.(event); }}
    onFocus={event => { setFocused(true); onFocus?.(event); }}
    onBlur={event => { setFocused(false); onBlur?.(event); }}
    style={state => [
      typeof style === "function" ? style(state) : style,
      !disabled && (hovered || state.pressed) && { backgroundColor: hoverColor ?? theme.colors.surface2 },
      !disabled && state.pressed && { opacity: 0.75 },
      Platform.OS === "web" && {
        cursor: disabled ? "auto" : "pointer",
        outlineStyle: "solid", outlineWidth: !disabled && focused ? 2 : 0,
        outlineColor: theme.colors.accent, outlineOffset: 2,
      },
    ]} />;
}
