// The plugin's host UI is supplied by Paseo. The browser smoke test substitutes
// only icons, clipboard and the modal shell; the task components and RN Web are real.
import React from "react";
import { createPortal } from "react-dom";
import { ScrollView as NativeScrollView, Text } from "react-native";

export const ScrollView = NativeScrollView;
export const Icon = ({ name, ...props }) => <Text {...props}>{name === "ArrowLeft" ? "←" : "⌄"}</Text>;
export const copyText = async (text) => { window.uiTest.copied = text; };
export const Modal = Object.assign(({ title, open, onOpenChange, children }) => open ? createPortal(
  <div role="dialog" style={{ position: "fixed", inset: 0, background: "#0008", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
    <div style={{ width: "min(360px,calc(100vw - 32px))", background: "#171c26", padding: 20, borderRadius: 12, color: "#e7e9ef" }}>
      <h3>{title}</h3>{children}<button onClick={() => onOpenChange(false)}>关闭</button>
    </div>
  </div>, document.body) : null, {
  Content: ({ children }) => <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>,
});
