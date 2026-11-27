// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().skip(1).any(|a| a == "--mcp") {
        return signavis_lite_lib::run_mcp_stdio();
    }
    signavis_lite_lib::run();
}
