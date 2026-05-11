use serde::{Deserialize, Serialize};

/// Intermediate format for Bible content. Produced by the chunking pipeline
/// (`tools/derive_structure.py`), consumed by the graph builder. Stores
/// only structural metadata — no NKJV verse text. Verse text is fetched
/// at render time from api.bible (cached server-side per the Minimum
/// Acceptable Use Agreement); our annotations layer composes onto it.
#[derive(Debug, Serialize, Deserialize)]
pub struct MaterialData {
    pub year: u32,
    pub books: Vec<String>,
    pub chapters: Vec<ChapterData>,
    pub verses: Vec<VerseData>,
    pub headings: Vec<HeadingData>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChapterData {
    pub book: String,
    pub number: u16,
    pub start_verse: u16,
    pub end_verse: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerseData {
    pub book: String,
    pub chapter: u16,
    pub verse: u16,
    /// Word count per memorization phrase. Length = number of phrases;
    /// sum = the verse's total word count under the locked tokenisation
    /// rule (whitespace-split, punctuation glued to adjacent token).
    pub phrase_word_counts: Vec<u16>,
    /// User-supplied keyword annotations. Each entry tags one verse-level
    /// word index with a markup kind. Empty list = no annotations.
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    /// Number of leading words that form the FTV (First-Two-Verses-style)
    /// prompt. None when the verse has no FTV. derive_structure verifies the
    /// prefix invariant (`≤ phrase_word_counts[0]` and the FTV words match the
    /// start of phrase 0) before emitting; the builder additionally rejects
    /// values exceeding `FTV_MAX_WORDS`.
    #[serde(default)]
    pub ftv_word_count: Option<u16>,
    #[serde(default)]
    pub clubs: Vec<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub word_index: u16,
    pub kind: AnnotationKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationKind {
    Bold,
    Italic,
    BoldItalic,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingData {
    pub book: String,
    pub start_chapter: u16,
    pub start_verse: u16,
    pub end_chapter: u16,
    pub end_verse: u16,
}

impl MaterialData {
    pub fn from_json(json_str: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json_str)
    }

    pub fn verses_with_content(&self) -> impl Iterator<Item = &VerseData> {
        self.verses
            .iter()
            .filter(|v| !v.phrase_word_counts.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_json() {
        let json = r#"{
            "year": 3,
            "books": ["1 Corinthians"],
            "chapters": [{"book": "1 Corinthians", "number": 1, "start_verse": 1, "end_verse": 3}],
            "verses": [
                {
                    "book": "1 Corinthians",
                    "chapter": 1,
                    "verse": 1,
                    "phraseWordCounts": [14, 4],
                    "annotations": [{"wordIndex": 15, "kind": "bold"}],
                    "ftvWordCount": 2,
                    "clubs": [300]
                }
            ],
            "headings": [
                {
                    "book": "1 Corinthians",
                    "startChapter": 1, "startVerse": 1,
                    "endChapter": 1, "endVerse": 4
                }
            ]
        }"#;

        let data = MaterialData::from_json(json).unwrap();
        assert_eq!(data.year, 3);
        assert_eq!(data.verses.len(), 1);
        assert_eq!(data.verses[0].phrase_word_counts, vec![14, 4]);
        assert_eq!(data.verses[0].clubs, vec![300]);
        assert_eq!(data.verses[0].ftv_word_count, Some(2));
        assert_eq!(
            data.verses[0].annotations,
            vec![Annotation {
                word_index: 15,
                kind: AnnotationKind::Bold
            }],
        );
        assert_eq!(data.headings[0].book, "1 Corinthians");
    }
}
