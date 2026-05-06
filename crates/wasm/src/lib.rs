//! Phase 4 stub. The legacy WASM API exposed graph + edge state types that have
//! been deleted; the new HSRS-aligned API (TestStateEntry, TestUpdateWire, etc.)
//! lands in Phase 7. For now this module exports a single no-op constructor so
//! the crate still builds.

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct WasmEngine {
    _placeholder: u8,
}

#[wasm_bindgen]
impl WasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmEngine {
        WasmEngine { _placeholder: 0 }
    }
}

impl Default for WasmEngine {
    fn default() -> Self {
        Self::new()
    }
}
