// Without this a release build on Windows opens a console window behind the
// app. Debug builds keep it: that console is where the webview's Rust-side
// logs land.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    beeline_desktop_lib::run()
}
