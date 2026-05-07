// Tauri requires a separate binary entry point.
// All logic lives in lib.rs so it is unit-testable.
fn main() {
    audio_workbench_lib::run();
}
