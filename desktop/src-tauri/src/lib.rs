use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

/// How often the background loop runs a shadow check. The CLI's own detectors
/// decide what (if anything) is worth a notification — we just drive the tick.
const TICK_SECS: u64 = 120;

/// Locate the `stasis` binary. A GUI app launched from Finder does NOT inherit
/// the shell PATH, so we try the common install locations first.
fn resolve_bin() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        PathBuf::from(format!("{home}/.local/bin/stasis")),
        PathBuf::from("/opt/homebrew/bin/stasis"),
        PathBuf::from("/usr/local/bin/stasis"),
    ];
    for c in candidates {
        if c.exists() {
            return c.to_string_lossy().to_string();
        }
    }
    "stasis".to_string() // fall back to PATH resolution
}

/// Run a read-only `stasis <command> --json` and return its stdout. The command
/// is whitelisted so the UI can never invoke a state-changing subcommand.
#[tauri::command]
fn run_stasis(command: String) -> Result<String, String> {
    const ALLOWED: [&str; 5] = ["score", "sprint", "focus", "quota", "usage"];
    if !ALLOWED.contains(&command.as_str()) {
        return Err(format!("command not allowed: {command}"));
    }
    let out = Command::new(resolve_bin())
        .arg(&command)
        .arg("--json")
        .output()
        .map_err(|e| format!("failed to run stasis: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// A project name we're willing to hand to the CLI. Rejects anything that could
/// be read as a flag, and anything outside plain directory-name characters.
/// (We never touch a shell — args are passed directly — so this is about
/// argument confusion, not injection.)
fn safe_project(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// State-changing commands, kept separate from the read-only `run_stasis` and
/// whitelisted the same way: the UI can switch, snooze and unsnooze — nothing else.
#[tauri::command]
fn stasis_action(action: String, project: String) -> Result<String, String> {
    const ALLOWED: [&str; 3] = ["switch", "snooze", "unsnooze"];
    if !ALLOWED.contains(&action.as_str()) {
        return Err(format!("action not allowed: {action}"));
    }
    if !safe_project(&project) {
        return Err(format!("invalid project name: {project}"));
    }
    let out = Command::new(resolve_bin())
        .arg(&action)
        .arg(&project)
        .output()
        .map_err(|e| format!("failed to run stasis: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn stasis_json(command: &str) -> Option<serde_json::Value> {
    let out = Command::new(resolve_bin())
        .arg(command)
        .arg("--json")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

/// The short status shown as text in the menu bar itself — readable without
/// hovering. Gate dot + how on-target you are, e.g. "● n8n 0%".
fn tray_title() -> String {
    let dot = match stasis_json("quota")
        .and_then(|q| q.as_array()?.first()?.get("gate")?.as_str().map(String::from))
        .as_deref()
    {
        Some("green") => "●",
        Some("yellow") => "◐",
        Some("red") => "○",
        _ => "·",
    };
    if let Some(f) = stasis_json("focus") {
        if let Some(a) = f.get("active").filter(|a| !a.is_null()) {
            let proj = a.pointer("/focus/project").and_then(|p| p.as_str()).unwrap_or("");
            return match a.get("fidelity").and_then(|v| v.as_f64()) {
                Some(v) => format!("{dot} {proj} {:.0}%", v * 100.0),
                None => format!("{dot} {proj}"),
            };
        }
    }
    format!("{dot} stasis")
}

/// The at-a-glance line shown when hovering the menu-bar icon: quota gate and
/// how faithful you're being to the commitment.
fn tray_tooltip() -> String {
    let mut parts = vec!["stasis".to_string()];
    if let Some(q) = stasis_json("quota") {
        if let Some(first) = q.as_array().and_then(|a| a.first()) {
            let gate = first.get("gate").and_then(|g| g.as_str()).unwrap_or("?");
            match first.pointer("/rolling5h/pct").and_then(|p| p.as_f64()) {
                Some(p) => parts.push(format!("quota {gate} · 5h {:.0}%", p * 100.0)),
                None => parts.push(format!("quota {gate}")),
            }
        }
    }
    if let Some(f) = stasis_json("focus") {
        if let Some(a) = f.get("active").filter(|a| !a.is_null()) {
            let proj = a
                .pointer("/focus/project")
                .and_then(|p| p.as_str())
                .unwrap_or("focus");
            match a.get("fidelity").and_then(|v| v.as_f64()) {
                Some(v) => parts.push(format!("{proj} {:.0}% on target", v * 100.0)),
                None => parts.push(format!("{proj} (not traced)")),
            }
        } else {
            parts.push("no commitment".to_string());
        }
    }
    parts.join(" · ")
}

/// Drive the CLI's shadow check on an interval and refresh the tray tooltip.
/// The CLI owns detection AND urgent notifications (scatter / quota / overdue),
/// so we never duplicate that logic — and you should not also run
/// `stasis watch --daemon`, or you'd get notified twice.
fn spawn_shadow_loop(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let _ = Command::new(resolve_bin())
            .arg("watch")
            .arg("--once")
            .output();
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_tooltip(Some(tray_tooltip()));
            let _ = tray.set_title(Some(tray_title()));
        }
        std::thread::sleep(Duration::from_secs(TICK_SECS));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![run_stasis, stasis_action])
        .setup(|app| {
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let show = MenuItem::with_id(app, "show", "Open dashboard", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start at login",
                true,
                autostart_on,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit stasis", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show, &PredefinedMenuItem::separator(app)?, &autostart, &quit],
            )?;

            // A dedicated 22pt white-on-transparent glyph, NOT the app icon: macOS
            // menu-bar icons are template images (alpha-only), and handing it the
            // full-colour app icon is the common thread in reports of a tray that
            // builds fine and never appears.
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
                .expect("tray icon failed to decode");
            let tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(true)
                .menu(&menu)
                // Text in the menu bar, not just an icon: the whole point of a
                // resident anti-scatter tool is reading your state at a glance,
                // without hovering or clicking.
                .title("stasis")
                .tooltip("stasis")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "autostart" => {
                        let m = app.autolaunch();
                        if m.is_enabled().unwrap_or(false) {
                            let _ = m.disable();
                        } else {
                            let _ = m.enable();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            // The builder has no `visible` option and there's an open macOS bug
            // (tauri-apps/tauri#13770) where the icon silently never appears —
            // ask for visibility explicitly rather than trusting the default.
            let _ = tray.set_visible(true);

            spawn_shadow_loop(app.handle().clone());
            Ok(())
        })
        // Closing the window keeps stasis resident in the menu bar — quitting is
        // an explicit choice from the tray menu.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
