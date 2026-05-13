use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::card::{Card, CardState, VerseAtoms};
use crate::element::ClubTier;

/// Per-(year, club) status that the user controls via the material picker.
///
/// The "year" is implicit in the user's engine instance — one engine is
/// built per (user, year). The "club" is the verse's most-specific club
/// tier from `parse_tiers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ClubStatus {
    Active,
    Maintenance,
    Paused,
}

/// Look up the effective status for a verse's most-specific club tier.
/// Verses with no club tag and tiers the user hasn't opted into default to
/// `Paused`.
pub fn status_for_atoms(
    atoms: &VerseAtoms,
    statuses: &HashMap<ClubTier, ClubStatus>,
) -> ClubStatus {
    let Some(tier) = atoms.clubs.first() else {
        return ClubStatus::Paused;
    };
    statuses.get(tier).copied().unwrap_or(ClubStatus::Paused)
}

/// Visible in `/review` iff the card has been introduced (`Active`) and its
/// (year, club) is `Active` or `Maintenance`.
pub fn card_visible_in_review(
    card: &Card,
    atoms: &VerseAtoms,
    statuses: &HashMap<ClubTier, ClubStatus>,
) -> bool {
    if !matches!(card.state, CardState::Active) {
        return false;
    }
    matches!(
        status_for_atoms(atoms, statuses),
        ClubStatus::Active | ClubStatus::Maintenance
    )
}

/// Visible in `/memorize` iff the card is `New` and its (year, club) is
/// `Active`. `Maintenance` and `Paused` don't introduce new cards.
pub fn card_visible_in_memorize(
    card: &Card,
    atoms: &VerseAtoms,
    statuses: &HashMap<ClubTier, ClubStatus>,
) -> bool {
    if !matches!(card.state, CardState::New) {
        return false;
    }
    matches!(status_for_atoms(atoms, statuses), ClubStatus::Active)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::CardKind;
    use crate::types::CardId;

    fn atoms_in(tier: ClubTier) -> VerseAtoms {
        VerseAtoms {
            verse_id: 0,
            phrase_count: 2,
            headings: vec![],
            clubs: vec![tier],
            ftv_word_count: None,
            phrase_zero_word_count: 0,
        }
    }

    fn atoms_no_club() -> VerseAtoms {
        VerseAtoms {
            verse_id: 0,
            phrase_count: 2,
            headings: vec![],
            clubs: vec![],
            ftv_word_count: None,
            phrase_zero_word_count: 0,
        }
    }

    fn card(state: CardState) -> Card {
        Card {
            id: CardId(0),
            kind: CardKind::VerseAtVerseRef,
            verse_id: 0,
            state,
        }
    }

    fn statuses(pairs: &[(ClubTier, ClubStatus)]) -> HashMap<ClubTier, ClubStatus> {
        pairs.iter().copied().collect()
    }

    #[test]
    fn round_trips_through_json() {
        let s = ClubStatus::Maintenance;
        let j = serde_json::to_string(&s).unwrap();
        let back: ClubStatus = serde_json::from_str(&j).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn active_club_surfaces_active_card_in_review_and_new_in_memorize() {
        let st = statuses(&[(ClubTier::Club150, ClubStatus::Active)]);
        let atoms = atoms_in(ClubTier::Club150);
        assert!(card_visible_in_review(
            &card(CardState::Active),
            &atoms,
            &st
        ));
        assert!(card_visible_in_memorize(&card(CardState::New), &atoms, &st));
        // New cards never surface in review; Active cards never in memorize.
        assert!(!card_visible_in_review(&card(CardState::New), &atoms, &st));
        assert!(!card_visible_in_memorize(
            &card(CardState::Active),
            &atoms,
            &st
        ));
    }

    #[test]
    fn maintenance_surfaces_only_in_review() {
        let st = statuses(&[(ClubTier::Club150, ClubStatus::Maintenance)]);
        let atoms = atoms_in(ClubTier::Club150);
        assert!(card_visible_in_review(
            &card(CardState::Active),
            &atoms,
            &st
        ));
        assert!(!card_visible_in_memorize(
            &card(CardState::New),
            &atoms,
            &st
        ));
    }

    #[test]
    fn paused_hides_from_both_queues() {
        let st = statuses(&[(ClubTier::Club150, ClubStatus::Paused)]);
        let atoms = atoms_in(ClubTier::Club150);
        assert!(!card_visible_in_review(
            &card(CardState::Active),
            &atoms,
            &st
        ));
        assert!(!card_visible_in_memorize(
            &card(CardState::New),
            &atoms,
            &st
        ));
    }

    #[test]
    fn absent_status_defaults_to_paused() {
        let st = statuses(&[]);
        let atoms = atoms_in(ClubTier::Club300);
        assert!(!card_visible_in_review(
            &card(CardState::Active),
            &atoms,
            &st
        ));
        assert!(!card_visible_in_memorize(
            &card(CardState::New),
            &atoms,
            &st
        ));
    }

    #[test]
    fn untagged_verse_is_paused_regardless_of_map() {
        let st = statuses(&[
            (ClubTier::Club150, ClubStatus::Active),
            (ClubTier::Club300, ClubStatus::Active),
        ]);
        let atoms = atoms_no_club();
        assert!(!card_visible_in_review(
            &card(CardState::Active),
            &atoms,
            &st
        ));
    }

    #[test]
    fn isolating_one_club_does_not_leak_to_others() {
        let st = statuses(&[(ClubTier::Club150, ClubStatus::Active)]);
        let in_300 = atoms_in(ClubTier::Club300);
        assert!(!card_visible_in_review(
            &card(CardState::Active),
            &in_300,
            &st
        ));
    }
}
