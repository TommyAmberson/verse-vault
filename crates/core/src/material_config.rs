use serde::{Deserialize, Serialize};

/// Per-year toggles controlling which card kinds the builder emits.
///
/// Five card kinds are always emitted regardless of config — `PhraseFill`,
/// `Recitation`, `VerseAtVerseRef`, `VerseInChapter`, `VerseInBook`. They
/// are the core memorisation mechanic and have no meaningful "off" state.
///
/// `VerseInClub` is also always emitted; whether it surfaces to a given
/// user is decided downstream by per-(year, club) `ClubStatus`, not at
/// build time.
///
/// `Default` is everything-on. Callers that don't care about per-user
/// filtering (the simulation, regression tests) can pass
/// `&MaterialConfig::default()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterialConfig {
    pub headings: bool,
    pub ftv: bool,
    pub citation: bool,
}

impl Default for MaterialConfig {
    fn default() -> Self {
        Self {
            headings: true,
            ftv: true,
            citation: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_everything_on() {
        let c = MaterialConfig::default();
        assert!(c.headings);
        assert!(c.ftv);
        assert!(c.citation);
    }

    #[test]
    fn round_trips_through_json() {
        let c = MaterialConfig {
            headings: false,
            ftv: true,
            citation: false,
        };
        let j = serde_json::to_string(&c).unwrap();
        let back: MaterialConfig = serde_json::from_str(&j).unwrap();
        assert_eq!(c, back);
    }
}
