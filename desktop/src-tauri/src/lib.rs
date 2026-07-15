use std::path::PathBuf;
use std::process::Command;

/// Locate the `stasis` binary. A GUI app launched from Finder does NOT inherit
/// the shell PATH, so we try PATH first, then the common install locations.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![run_stasis])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
