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

/// Errors surfaced by `CardTypesConfig::from_toml`: either bad TOML or a
/// schema-valid TOML whose semantics don't fit the card-types model
/// (wrong scope for a role, `iterate`/`requires` on a non-verse card, …).
#[derive(Debug)]
pub enum CardTypesError {
    Toml(toml::de::Error),
    Invalid { card: String, reason: String },
}

impl std::fmt::Display for CardTypesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CardTypesError::Toml(e) => write!(f, "card_types TOML parse error: {e}"),
            CardTypesError::Invalid { card, reason } => {
                write!(f, "invalid card type `{card}`: {reason}")
            }
        }
    }
}

impl std::error::Error for CardTypesError {}

impl CardTypesConfig {
    pub fn from_toml(toml_str: &str) -> Result<Self, CardTypesError> {
        let config: Self = toml::from_str(toml_str).map_err(CardTypesError::Toml)?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), CardTypesError> {
        for ct in &self.card_types {
            // `iterate` and `requires` only mean something on the verse
            // path — `generate_chapter_club_cards` and
            // `generate_heading_cards` don't honour them. Reject up front
            // rather than silently ignoring.
            if ct.scope != CardScope::Verse && (ct.iterate.is_some() || ct.requires.is_some()) {
                return Err(CardTypesError::Invalid {
                    card: ct.name.clone(),
                    reason: format!(
                        "`iterate` / `requires` are only valid on `scope = \"verse\"` (got {:?})",
                        ct.scope
                    ),
                });
            }
            // Every role in show/hide must be valid AND fit the card's scope.
            for role_str in ct.show.iter().chain(ct.hide.iter()) {
                let role = parse_role(role_str).ok_or_else(|| CardTypesError::Invalid {
                    card: ct.name.clone(),
                    reason: format!("unknown role `{role_str}`"),
                })?;
                let allowed = allowed_scopes(&role);
                if !allowed.contains(&ct.scope) {
                    return Err(CardTypesError::Invalid {
                        card: ct.name.clone(),
                        reason: format!(
                            "role `{role_str}` is not valid in scope `{:?}` (allowed: {:?})",
                            ct.scope, allowed
                        ),
                    });
                }
            }
        }
        Ok(())
    }
}

/// Which `CardScope`s an atom role can be resolved within. Used by
/// `CardTypesConfig::validate` to reject mismatched configurations at
/// parse time so the runtime never silently drops a misconfigured card.
fn allowed_scopes(role: &AtomRole) -> &'static [CardScope] {
    match role {
        AtomRole::Ref
        | AtomRole::Phrases
        | AtomRole::FirstPhrase
        | AtomRole::RemainingPhrases
        | AtomRole::Current
        | AtomRole::PhrasesExceptCurrent
        | AtomRole::Ftv
        | AtomRole::NextHeading
        | AtomRole::PrevHeading
        | AtomRole::ChapterGist
        | AtomRole::ClubRefs => &[CardScope::Verse],
        AtomRole::Heading => &[CardScope::Verse, CardScope::Heading],
        AtomRole::BookRef | AtomRole::ChapterRef | AtomRole::ClubGist => {
            &[CardScope::Verse, CardScope::ChapterClub]
        }
        AtomRole::ChapterClubVerseRefs => &[CardScope::ChapterClub],
        AtomRole::HeadingVerseRefs => &[CardScope::Heading],
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

    #[test]
    fn rejects_iterate_on_non_verse_scope() {
        let toml = r#"
            [[card_types]]
            name = "bad"
            scope = "chapter_club"
            iterate = "phrases"
            show = ["club_gist"]
            hide = ["chapter_club_verse_refs"]
        "#;
        let err = CardTypesConfig::from_toml(toml).unwrap_err();
        match err {
            CardTypesError::Invalid { card, reason } => {
                assert_eq!(card, "bad");
                assert!(reason.contains("`iterate`"), "got: {reason}");
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn rejects_requires_on_non_verse_scope() {
        let toml = r#"
            [[card_types]]
            name = "bad"
            scope = "heading"
            requires = "ftv"
            show = ["heading_verse_refs"]
            hide = ["heading"]
        "#;
        let err = CardTypesConfig::from_toml(toml).unwrap_err();
        assert!(matches!(err, CardTypesError::Invalid { .. }));
    }

    #[test]
    fn rejects_role_outside_its_scope() {
        let toml = r#"
            [[card_types]]
            name = "wrong_role"
            show = ["chapter_club_verse_refs"]
            hide = ["phrases"]
        "#;
        let err = CardTypesConfig::from_toml(toml).unwrap_err();
        match err {
            CardTypesError::Invalid { reason, .. } => {
                assert!(reason.contains("chapter_club_verse_refs"), "got: {reason}");
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[test]
    fn accepts_book_chapter_club_in_verse_scope() {
        let toml = r#"
            [[card_types]]
            name = "verse_to_club"
            show = ["ref"]
            hide = ["club_gist"]
        "#;
        CardTypesConfig::from_toml(toml).expect("club_gist allowed in verse scope");
    }
}
