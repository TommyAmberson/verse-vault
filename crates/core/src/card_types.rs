use serde::Deserialize;

/// Card type definitions loaded from TOML. Decoupled from the graph —
/// card types reference atom roles, not graph internals.
#[derive(Debug, Deserialize)]
pub struct CardTypesConfig {
    pub card_types: Vec<CardTypeDef>,
}

#[derive(Debug, Deserialize)]
pub struct CardTypeDef {
    pub name: String,
    pub show: Vec<String>,
    pub hide: Vec<String>,
    #[serde(default)]
    pub iterate: Option<String>,
    #[serde(default)]
    pub requires: Option<String>,
}

impl CardTypesConfig {
    pub fn from_toml(toml_str: &str) -> Result<Self, toml::de::Error> {
        toml::from_str(toml_str)
    }
}

/// Atom roles — the interface between card definitions and the graph.
/// The graph builder resolves these to actual NodeIds.
#[derive(Debug, Clone, PartialEq)]
pub enum AtomRole {
    Ref,
    Phrases,
    FirstPhrase,
    RemainingPhrases,
    /// The current phrase in an iterate loop
    Current(usize),
    /// All phrases except the current
    PhrasesExceptCurrent(usize),
    Ftv,
    Heading,
    NextHeading,
    PrevHeading,
    ChapterGist,
    ClubRefs,
}

pub fn parse_role(s: &str) -> Option<AtomRole> {
    match s {
        "ref" => Some(AtomRole::Ref),
        "phrases" => Some(AtomRole::Phrases),
        "first_phrase" => Some(AtomRole::FirstPhrase),
        "remaining_phrases" => Some(AtomRole::RemainingPhrases),
        "ftv" => Some(AtomRole::Ftv),
        "heading" => Some(AtomRole::Heading),
        "next_heading" => Some(AtomRole::NextHeading),
        "prev_heading" => Some(AtomRole::PrevHeading),
        "chapter_gist" => Some(AtomRole::ChapterGist),
        "club_refs" => Some(AtomRole::ClubRefs),
        "$" => Some(AtomRole::Current(0)),
        _ if s.starts_with("phrases - $") => Some(AtomRole::PhrasesExceptCurrent(0)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_card_types_toml() {
        let toml_str = include_str!("../card_types.toml");
        let config = CardTypesConfig::from_toml(toml_str).unwrap();
        assert!(config.card_types.len() >= 6);

        let full = config
            .card_types
            .iter()
            .find(|c| c.name == "full_recitation")
            .unwrap();
        assert_eq!(full.show, vec!["ref"]);
        assert_eq!(full.hide, vec!["phrases"]);
        assert!(full.iterate.is_none());

        let fill = config
            .card_types
            .iter()
            .find(|c| c.name == "fill_in_blank")
            .unwrap();
        assert_eq!(fill.iterate.as_deref(), Some("phrases"));
        assert_eq!(fill.show, vec!["ref", "phrases - $"]);
        assert_eq!(fill.hide, vec!["$"]);

        let ftv = config
            .card_types
            .iter()
            .find(|c| c.name == "finish_this_verse")
            .unwrap();
        assert_eq!(ftv.requires.as_deref(), Some("ftv"));
    }

    #[test]
    fn parse_atom_roles() {
        assert_eq!(parse_role("ref"), Some(AtomRole::Ref));
        assert_eq!(parse_role("phrases"), Some(AtomRole::Phrases));
        assert_eq!(parse_role("ftv"), Some(AtomRole::Ftv));
        assert_eq!(parse_role("$"), Some(AtomRole::Current(0)));
        assert!(parse_role("phrases - $").is_some());
        assert!(parse_role("unknown").is_none());
    }
}
