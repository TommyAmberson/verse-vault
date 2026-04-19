# verse-vault-wasm

WebAssembly bindings for the verse-vault core engine. Exposes
`ReviewEngine` and `Session` to JavaScript so they can run in Node.js
(server-side) and in the browser (offline mode).

## Build

```
wasm-pack build crates/wasm --target nodejs --out-dir pkg
```

For the browser:

```
wasm-pack build crates/wasm --target web --out-dir pkg
```

## Usage

```js
import { WasmEngine } from './pkg/verse_vault_wasm.js';

// graph/cards/states are JSON strings; see docs/wasm-api.md for shape.
const engine = new WasmEngine(graphJson, cardsJson, edgeStatesJson, cardStatesJson, 0.9);

engine.start_session(BigInt(Date.now() / 1000 | 0), newVersesJson, '');

while (!engine.session_is_done()) {
  const card = JSON.parse(engine.session_next());
  const grades = /* user input */ [];
  const outcome = JSON.parse(engine.session_review(JSON.stringify(grades), nowSecs));
}

const edgeStates = JSON.parse(engine.export_edge_states());
const cardStates = JSON.parse(engine.export_card_states());
```

## Smoke test

```
wasm-pack build crates/wasm --target nodejs --out-dir pkg
node crates/wasm/test-smoke.js
```

## See also

- `docs/wasm-api.md` — JSON shapes for data crossing the boundary
- `docs/architecture.md` — where this fits in the overall system
