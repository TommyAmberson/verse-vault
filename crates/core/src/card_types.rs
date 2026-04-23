use serde::Deserialize;

/// Card type definitions loaded from TOML. Decoupled from the graph —
/// card types reference atom roles, not graph internals.
#[derive(Debug, Deserialize)]
pub struct CardTypesConfig {
    pub card_types: Vec<CardTypeDef>,
}

/// Which iteration axis a card definition runs over.
///
/// `Verse` is the default: one card per `VerseAtoms`. Listing-style cards
/// that operate at a coarser granularity use a different scope and iterate
/// over matching context bundles (e.g. `ChapterClubAtoms`).
#[derive(Debug, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CardScope {
    #[default]
    Verse,
    ChapterClub,
    Heading,
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
    #[serde(default)]
    pub scope: CardScope,
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
    // --- Verse-scope roles ---
    /// Shorthand that expands to the full `[book_ref, chapter_ref, verse_ref]`
    /// triple in the verse scope (see card-coupling design in docs/graph.md).
    Ref,
    Phrases,
    FirstPhrase,
    RemainingPhrases,
    /// The current phrase in an iterate loop
    Current,
    /// All phrases except the current
    PhrasesExceptCurrent,
    Ftv,
    Heading,
    NextHeading,
    PrevHeading,
    ChapterGist,
    ClubRefs,

    // --- Chapter-club scope roles ---
    /// The `ClubGist` atom for the card's tier.
    ClubGist,
    /// The `BookRef` atom only (no triple coupling).
    BookRef,
    /// The `ChapterRef` atom only (no triple coupling).
    ChapterRef,
    /// Every `VerseRef` atom for verses in the card's (chapter, tier).
    ChapterClubVerseRefs,
    /// Every `VerseRef` atom for verses in the card's heading range.
    HeadingVerseRefs,
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
        "club_gist" => Some(AtomRole::ClubGist),
        "book_ref" => Some(AtomRole::BookRef),
        "chapter_ref" => Some(AtomRole::ChapterRef),
        "chapter_club_verse_refs" => Some(AtomRole::ChapterClubVerseRefs),
        "heading_verse_refs" => Some(AtomRole::HeadingVerseRefs),
        "$" => Some(AtomRole::Current),
        _ if s.starts_with("phrases - $") => Some(AtomRole::PhrasesExceptCurrent),
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
        assert_eq!(parse_role("$"), Some(AtomRole::Current));
        assert!(parse_role("phrases - $").is_some());
        assert!(parse_role("unknown").is_none());

        // Chapter-club + heading scope roles
        assert_eq!(parse_role("club_gist"), Some(AtomRole::ClubGist));
        assert_eq!(parse_role("book_ref"), Some(AtomRole::BookRef));
        assert_eq!(parse_role("chapter_ref"), Some(AtomRole::ChapterRef));
        assert_eq!(
            parse_role("chapter_club_verse_refs"),
            Some(AtomRole::ChapterClubVerseRefs)
        );
        assert_eq!(
            parse_role("heading_verse_refs"),
            Some(AtomRole::HeadingVerseRefs)
        );
    }

    #[test]
    fn card_scope_defaults_to_verse() {
        let toml = r#"
            [[card_types]]
            name = "full_recitation"
            show = ["ref"]
            hide = ["phrases"]

            [[card_types]]
            name = "club_chapter_listing"
            scope = "chapter_club"
            show = ["club_gist", "book_ref", "chapter_ref"]
            hide = ["chapter_club_verse_refs"]

            [[card_types]]
            name = "verses_to_heading"
            scope = "heading"
            show = ["heading_verse_refs"]
            hide = ["heading"]
        "#;
        let config = CardTypesConfig::from_toml(toml).unwrap();
        assert_eq!(config.card_types[0].scope, CardScope::Verse);
        assert_eq!(config.card_types[1].scope, CardScope::ChapterClub);
        assert_eq!(config.card_types[2].scope, CardScope::Heading);
    }
}
