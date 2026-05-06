use crate::element::{ClubTier, ElementId};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct VerseElements {
    pub phrases: Vec<u16>,
    pub headings: Vec<u16>,
    pub clubs: Vec<ClubTier>,
}

#[derive(Debug, Clone, Default)]
pub struct VerseIndex {
    verses: HashMap<u32, VerseElements>,
}

impl VerseIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_verse(&mut self, verse_id: u32, e: VerseElements) {
        self.verses.insert(verse_id, e);
    }

    pub fn phrases_of(&self, verse_id: u32) -> Vec<ElementId> {
        self.verses
            .get(&verse_id)
            .map(|e| {
                e.phrases
                    .iter()
                    .map(|&p| ElementId::Phrase {
                        verse_id,
                        position: p,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn bindings_of(&self, verse_id: u32) -> Vec<ElementId> {
        let mut v = vec![
            ElementId::VerseRefPosition { verse_id },
            ElementId::VerseChapterBinding { verse_id },
            ElementId::VerseBookBinding { verse_id },
        ];
        if let Some(e) = self.verses.get(&verse_id) {
            for &h in &e.headings {
                v.push(ElementId::VerseHeadingBinding {
                    verse_id,
                    heading_idx: h,
                });
            }
            for &c in &e.clubs {
                v.push(ElementId::VerseClubBinding { verse_id, tier: c });
            }
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verse_index_phrases_and_bindings() {
        let mut idx = VerseIndex::new();
        idx.add_verse(
            7,
            VerseElements {
                phrases: vec![0, 1, 2],
                headings: vec![],
                clubs: vec![],
            },
        );
        assert_eq!(idx.phrases_of(7).len(), 3);
        assert_eq!(idx.bindings_of(7).len(), 3);
    }

    #[test]
    fn verse_index_includes_heading_and_club_bindings() {
        let mut idx = VerseIndex::new();
        idx.add_verse(
            7,
            VerseElements {
                phrases: vec![0],
                headings: vec![0],
                clubs: vec![ClubTier::First],
            },
        );
        let bindings = idx.bindings_of(7);
        assert_eq!(bindings.len(), 5);
        assert!(
            bindings
                .iter()
                .any(|e| matches!(e, ElementId::VerseHeadingBinding { .. }))
        );
        assert!(
            bindings
                .iter()
                .any(|e| matches!(e, ElementId::VerseClubBinding { .. }))
        );
    }
}
