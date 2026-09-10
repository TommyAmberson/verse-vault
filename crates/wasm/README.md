# verse-vault-wasm

WebAssembly bindings for the verse-vault core engine. Exposes a single `WasmEngine` class to
JavaScript so the same compiled algorithm runs in Node.js (the API) and in the browser (the Vue fat
client and the Tauri desktop shell).

## Build

```
wasm-pack build crates/wasm --target nodejs --out-dir pkg
```

For the browser — note this is the `bundler` target into a **separate** output directory, so it
doesn't clobber the nodejs build:

```
bash tools/build-wasm-web.sh   # wasm-pack build --target bundler --out-dir pkg-web
```

## Usage

```js
import { WasmEngine } from './pkg/verse_vault_wasm.js';

const nowSecs = BigInt(Math.floor(Date.now() / 1000));

// Every argument is a JSON string; see docs/wasm-api.md for the shapes.
const engine = new WasmEngine(
  materialJson,        // MaterialData
  materialConfigJson,  // MaterialConfig; '' for defaults
  scheduleJson,        // season schedule; '' when the material has none
  persistedStatesJson, // '' or '[]' for fresh state
  nowSecs,
);

// Pick the next due card, render it, replay the grade.
const cardId = engine.next_review_card(nowSecs);
if (cardId !== undefined) {
  const render = JSON.parse(engine.get_card_render(cardId));
  const outcome = JSON.parse(engine.replay_event(cardId, grade, nowSecs));
}

// Persist the updated per-test memory states.
const testStates = JSON.parse(engine.export_test_states());
```

## Smoke test

```
wasm-pack build crates/wasm --target nodejs --out-dir pkg
node crates/wasm/test-smoke.js
```

## See also

* `docs/wasm-api.md` — JSON shapes for data crossing the boundary
* `docs/architecture.md` — where this fits in the overall system
