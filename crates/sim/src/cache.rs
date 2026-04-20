//! On-disk cache for built BuildResult, keyed by hash of inputs.
//!
//! Building the graph for a Bible book takes seconds; this cache makes
//! repeat sim runs near-instant.

use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::PathBuf;

use verse_vault_core::builder::BuildResult;

const CACHE_DIR: &str = "data/.sim-cache";

/// Bump when builder logic changes in a way that produces different output
/// from identical inputs. Forces all caches to invalidate.
const BUILDER_VERSION: u32 = 1;

/// Compute a cache key from the inputs that determine the build output.
pub fn cache_key(data_json: &str, card_types_toml: &str, chapter_filter: Option<u16>) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    BUILDER_VERSION.hash(&mut hasher);
    data_json.hash(&mut hasher);
    card_types_toml.hash(&mut hasher);
    chapter_filter.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn cache_path(key: &str) -> PathBuf {
    PathBuf::from(CACHE_DIR).join(format!("{key}.json"))
}

/// Try to load a cached BuildResult. Returns None if missing or unreadable.
/// Returns Err only for unexpected I/O issues worth surfacing.
pub fn load(key: &str) -> io::Result<Option<BuildResult>> {
    let path = cache_path(key);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path)?;
    match serde_json::from_slice::<BuildResult>(&bytes) {
        Ok(result) => Ok(Some(result)),
        Err(_) => {
            // Stale or corrupt cache; just rebuild
            let _ = fs::remove_file(&path);
            Ok(None)
        }
    }
}

pub fn save(key: &str, result: &BuildResult) -> io::Result<()> {
    fs::create_dir_all(CACHE_DIR)?;
    let path = cache_path(key);
    let bytes = serde_json::to_vec(result)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    fs::write(&path, bytes)
}
