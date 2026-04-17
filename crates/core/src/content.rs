use serde::{Deserialize, Serialize};

/// Intermediate format for Bible content. Produced by the chunking pipeline,
/// consumed by the graph builder. This is the bridge between raw content
/// and the memory graph.
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

#[derive(Debug, Serialize, Deserialize)]
pub struct VerseData {
    pub book: String,
    pub chapter: u16,
    pub verse: u16,
    pub text: String,
    pub phrases: Vec<String>,
    #[serde(default)]
    pub ftv: String,
    #[serde(default)]
    pub clubs: Vec<u16>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HeadingData {
    pub text: String,
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

    pub fn verses_with_text(&self) -> impl Iterator<Item = &VerseData> {
        self.verses.iter().filter(|v| !v.text.is_empty())
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
                    "text": "Paul, called to be an apostle",
                    "phrases": ["Paul, called to be an apostle"],
                    "clubs": [300]
                }
            ],
            "headings": [
                {
                    "text": "Greeting",
                    "book": "1 Corinthians",
                    "start_chapter": 1, "start_verse": 1,
                    "end_chapter": 1, "end_verse": 4
                }
            ]
        }"#;

        let data = MaterialData::from_json(json).unwrap();
        assert_eq!(data.year, 3);
        assert_eq!(data.verses.len(), 1);
        assert_eq!(data.verses[0].phrases.len(), 1);
        assert_eq!(data.verses[0].clubs, vec![300]);
        assert_eq!(data.headings[0].text, "Greeting");
    }
}
