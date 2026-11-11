import { RGBA, SyntaxStyle, type CliRenderer } from "@opentui/core";
import type { Appearance } from "../appearance.js";
export const c = {
  // Keep the terminal's default background instead of painting an opaque canvas.
  bg: RGBA.defaultBackground() as RGBA | string,
  panel: "transparent",
  input: "#242424",
  overlay: "#1e1e1e",
  raised: "#303030",
  border: "#3a3a3a",
  text: "#e6e6e6",
  muted: "#a0a0a0",
  faint: "#808080",
  accent: "#8bb6ff",
  green: "#8bd5b1",
  amber: "#eac084",
  red: "#ed9a9f",
  purple: "#baa7ed",
};
const palettes = {
  neutral: {
    canvas: "#121212",
    panel: "#191919",
    input: "#242424",
    overlay: "#1e1e1e",
    raised: "#303030",
    border: "#3a3a3a",
    accent: "#8bb6ff",
  },
  blue: {
    canvas: "#0b1017",
    panel: "#131c28",
    input: "#1b2839",
    overlay: "#172233",
    raised: "#22334a",
    border: "#33465e",
    accent: "#8bb6ff",
  },
  forest: {
    canvas: "#0d1512",
    panel: "#15221b",
    input: "#21352b",
    overlay: "#192b22",
    raised: "#2b4437",
    border: "#3a5546",
    accent: "#91d5ab",
  },
  plum: {
    canvas: "#17111b",
    panel: "#231b2a",
    input: "#32263d",
    overlay: "#2a2033",
    raised: "#42314e",
    border: "#574264",
    accent: "#c4a0ee",
  },
};
export function applyTheme(appearance: Appearance) {
  const p = palettes[appearance.theme];
  Object.assign(c, p, {
    bg:
      appearance.background === "transparent"
        ? RGBA.defaultBackground()
        : p.canvas,
    panel: appearance.background === "transparent" ? "transparent" : p.panel,
  });
}
export const makeSyntax = (owner: CliRenderer) =>
  SyntaxStyle.fromStyles(
    {
      default: { fg: c.text },
      keyword: { fg: c.purple },
      string: { fg: c.green },
      number: { fg: c.amber },
      comment: { fg: c.faint },
      function: { fg: c.accent },
      "markup.heading": { fg: c.accent, bold: true },
      "markup.strong": { fg: c.text, bold: true },
      "markup.raw": { fg: c.green },
      "markup.link": { fg: c.accent },
    },
    owner.nativeScene,
  );
export const clean = (s: string) =>
  s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
export const money = (n: number) => `$${n.toFixed(n < 0.01 ? 5 : 3)}`;
export const duration = (at: number) => {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
export const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
