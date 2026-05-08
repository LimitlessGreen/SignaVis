// Tauri requires a separate binary entry point.
// All logic lives in lib.rs so it is unit-testable.
fn main() {
    signavis_lib::run();
}
