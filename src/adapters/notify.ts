import { execFileSync } from "node:child_process";

/**
 * Fire a macOS notification via osascript.
 * Silently no-ops on non-macOS (or when osascript is unavailable).
 */
export function notify(title: string, subtitle: string, message: string): void {
  try {
    execFileSync("osascript", [
      "-e",
      `display notification "${escape(message)}" with title "${escape(title)}" subtitle "${escape(subtitle)}" sound name "default"`,
    ], { timeout: 5000, stdio: "ignore" });
  } catch {
    // not on macOS or osascript unavailable — silent
  }
}

function escape(s: string): string {
  return s.replace(/[\\"]/g, "\\$&");
}
