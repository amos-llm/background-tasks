// The plugin's host UI is supplied by Paseo. The browser smoke test substitutes
// only icons and clipboard; the task components and RN Web are real.
import React from "react";
import { ScrollView as NativeScrollView, Text } from "react-native";

export const ScrollView = NativeScrollView;
export const Icon = ({ name, ...props }) => <Text {...props}>{name === "ArrowLeft" ? "←" : "⌄"}</Text>;
export const copyText = async (text) => { window.uiTest.copied = text; };
