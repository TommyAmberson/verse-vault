//! Smoke tests for the WASM boundary. The `verse-vault-wasm` crate is built
//! as both `cdylib` and `rlib`, so we can drive its public API from a plain
//! Rust integration test without spinning up `wasm-pack`.

use verse_vault_wasm::WasmEngine;

const MATERIAL_JSON: &str = r#"{
    "year": 3,
    "books": ["John"],
    "chapters": [{"book": "John", "number": 3, "start_verse": 16, "end_verse": 16}],
    "verses": [
        {
            "book": "John", "chapter": 3, "verse": 16,
            "text": "For God so loved the world that he gave",
            "phrases": ["For God", "so loved", "the world", "that he gave"],
            "ftv": "For God",
            "clubs": []
        }
    ],
    "headings": []
}"#;

#[test]
fn constructor_loads_material_without_panic() {
    let _engine =
        WasmEngine::new(MATERIAL_JSON, "", 0.9, 86400 * 365).expect("constructor should succeed");
}

#[test]
fn constructor_accepts_empty_persisted_states() {
    let _engine = WasmEngine::new(MATERIAL_JSON, "[]", 0.9, 86400 * 365).unwrap();
}
