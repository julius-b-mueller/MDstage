//! Export of the script as PDF (typeset with Typst) and DOCX.

use docx_rs::{AlignmentType, BreakType, Docx, PageMargin, Paragraph, Run, RunFonts};
use mdstage_core::export::{Book, CueBox, Item};
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::layout::PagedDocument;
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, World};

/// A Typst string literal.
fn lit(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Split dialogue into plain text and inline stage directions `*(…)*`.
fn stage_spans(line: &str) -> Vec<(bool, &str)> {
    let mut spans = Vec::new();
    let mut rest = line;
    while let Some(open) = rest.find("*(") {
        let Some(close) = rest[open..].find(")*") else { break };
        if open > 0 {
            spans.push((false, &rest[..open]));
        }
        spans.push((true, &rest[open + 1..open + close + 1]));
        rest = &rest[open + close + 2..];
    }
    if !rest.is_empty() {
        spans.push((false, rest));
    }
    spans
}

/// The book as Typst markup. Text only ever appears inside string literals, so nothing
/// in a script can be read as markup.
pub fn typst_source(book: &Book, date: &str) -> String {
    let mut out = String::new();
    out.push_str("#set page(paper: \"a4\", margin: 2.5cm)\n");
    out.push_str("#set text(font: \"Libertinus Serif\", size: 11pt, lang: \"de\")\n");
    out.push_str("#set par(leading: 0.6em)\n");
    out.push_str("#show heading.where(level: 1): it => { pagebreak(weak: true); v(4mm); text(18pt, it.body); v(2mm) }\n");
    out.push_str("#show heading.where(level: 2): it => { v(3mm); text(14pt, it.body); v(1mm) }\n");
    out.push_str("#show heading.where(level: 3): it => { v(2mm); text(12pt, it.body) }\n");
    out.push_str(&format!(
        "#align(center)[#v(6cm) #text(26pt, weight: \"bold\", {}) #v(8mm) #text(12pt, fill: luma(68), {})]\n",
        lit(&book.title),
        lit(&format!("Regiebuch — {date}"))
    ));
    out.push_str("#pagebreak()\n#outline(title: \"Inhaltsverzeichnis\", depth: 3)\n");
    out.push_str("#set page(numbering: \"1\", number-align: right)\n#counter(page).update(1)\n");
    for item in &book.items {
        match item {
            Item::Heading { level, text } => out.push_str(&format!("#heading(level: {level}, {})\n", lit(text))),
            Item::Stage(text) => out.push_str(&format!("#pad(left: 1cm, text(style: \"italic\", fill: luma(102), size: 10pt, {}))\n", lit(text))),
            Item::Text(text) => out.push_str(&format!("#par(text({}))\n", lit(text))),
            Item::Role { names, dialogue } => {
                out.push_str("#block(below: 0.9em)[");
                for (i, (name, colour)) in names.iter().enumerate() {
                    if i > 0 {
                        out.push_str("#h(0.5em)");
                    }
                    let fill = if colour.is_empty() { String::new() } else { format!(", fill: rgb({})", lit(colour)) };
                    out.push_str(&format!("#text(weight: \"bold\"{fill}, {})", lit(name)));
                }
                for (n, line) in dialogue.lines().enumerate() {
                    out.push_str(if n == 0 { "#h(1em)" } else { "#linebreak()" });
                    for (stage, text) in stage_spans(line) {
                        if stage {
                            out.push_str(&format!("#text(style: \"italic\", fill: luma(102), {})", lit(text)));
                        } else {
                            out.push_str(&format!("#text({})", lit(text)));
                        }
                    }
                }
                out.push_str("]\n");
            }
            Item::Cue(CueBox { number, title, trigger, rows }) => {
                out.push_str("#block(width: 100%, stroke: 0.5pt + luma(136), inset: 6pt, breakable: false)[#set text(size: 10pt)\n");
                out.push_str(&format!(
                    "#grid(columns: (1fr, auto), text(weight: \"bold\", {}), text(fill: luma(102), {}))\n",
                    lit(&format!("Cue {number}  {title}")),
                    lit(trigger)
                ));
                // The header grid is a block of its own, so only later rows need a line break.
                for (n, (label, value)) in rows.iter().enumerate() {
                    let lead = if n == 0 { "#v(-4pt)" } else { "#linebreak()" };
                    out.push_str(&format!("{lead}#text(weight: \"bold\", fill: luma(102), {})#text({})\n", lit(&format!("{label}: ")), lit(value)));
                }
                out.push_str("]\n");
            }
        }
    }
    out
}

/// The one-file world Typst compiles: the generated source and the bundled fonts.
struct BookWorld {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    source: Source,
}

impl World for BookWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.source.id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.source.id() { Ok(self.source.clone()) } else { Err(FileError::AccessDenied) }
    }

    fn file(&self, _: FileId) -> FileResult<Bytes> {
        Err(FileError::AccessDenied)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }

    fn today(&self, _: Option<i64>) -> Option<Datetime> {
        None
    }
}

/// Typeset the book as a PDF: title page, table of contents, page numbers.
pub fn pdf(book: &Book, date: &str) -> Result<Vec<u8>, String> {
    let fonts: Vec<Font> = typst_assets::fonts().flat_map(|data| Font::iter(Bytes::new(data))).collect();
    let world = BookWorld {
        library: LazyHash::new(Library::default()),
        book: LazyHash::new(FontBook::from_fonts(&fonts)),
        fonts,
        source: Source::new(FileId::new(None, VirtualPath::new("book.typ")), typst_source(book, date)),
    };
    let describe = |errors: &[typst::diag::SourceDiagnostic]| errors.iter().map(|e| e.message.to_string()).collect::<Vec<_>>().join("; ");
    let document: PagedDocument = typst::compile(&world).output.map_err(|e| describe(&e))?;
    typst_pdf::pdf(&document, &typst_pdf::PdfOptions::default()).map_err(|e| describe(&e))
}

const SERIF: &str = "Times New Roman";

fn run(text: &str) -> Run {
    Run::new().add_text(text).fonts(RunFonts::new().ascii(SERIF).hi_ansi(SERIF)).size(22)
}

/// The book as a Word document with the same structure as the PDF.
pub fn docx(book: &Book, date: &str) -> Result<Vec<u8>, String> {
    let grey = "666666";
    let mut doc = Docx::new().page_margin(PageMargin::new().top(1417).bottom(1417).left(1417).right(1417));
    doc = doc
        .add_paragraph(Paragraph::new().align(AlignmentType::Center).add_run(run("").add_break(BreakType::TextWrapping)))
        .add_paragraph(Paragraph::new().align(AlignmentType::Center).add_run(run(&book.title).bold().size(52)))
        .add_paragraph(Paragraph::new().align(AlignmentType::Center).add_run(run(&format!("Regiebuch — {date}")).size(24).color("444444")))
        .add_paragraph(Paragraph::new().add_run(Run::new().add_break(BreakType::Page)))
        .add_paragraph(Paragraph::new().add_run(run("Inhaltsverzeichnis").bold().size(28)));
    // A plain list of the headings: a generated table-of-contents field would need Word
    // to update it before it shows anything.
    for item in &book.items {
        if let Item::Heading { level, text } = item {
            let indent = "    ".repeat((*level as usize).saturating_sub(1));
            let mut entry = run(&format!("{indent}{text}")).size(if *level == 1 { 24 } else { 22 });
            if *level == 1 {
                entry = entry.bold();
            }
            doc = doc.add_paragraph(Paragraph::new().add_run(entry));
        }
    }
    doc = doc.add_paragraph(Paragraph::new().add_run(Run::new().add_break(BreakType::Page)));

    for item in &book.items {
        doc = match item {
            Item::Heading { level, text } => {
                let size = match level {
                    1 => 36,
                    2 => 28,
                    _ => 24,
                };
                doc.add_paragraph(Paragraph::new().style(&format!("Heading{level}")).add_run(run(text).bold().size(size)))
            }
            Item::Stage(text) => doc.add_paragraph(Paragraph::new().indent(Some(567), None, None, None).add_run(run(text).italic().color(grey).size(20))),
            Item::Text(text) => doc.add_paragraph(Paragraph::new().add_run(run(text))),
            Item::Role { names, dialogue } => {
                let mut paragraph = Paragraph::new();
                for (i, (name, colour)) in names.iter().enumerate() {
                    if i > 0 {
                        paragraph = paragraph.add_run(run("  "));
                    }
                    let mut name_run = run(name).bold();
                    if let Some(hex) = colour.strip_prefix('#') {
                        name_run = name_run.color(hex);
                    }
                    paragraph = paragraph.add_run(name_run);
                }
                for (n, line) in dialogue.lines().enumerate() {
                    paragraph = paragraph.add_run(if n == 0 { run("    ") } else { Run::new().add_break(BreakType::TextWrapping) });
                    for (stage, text) in stage_spans(line) {
                        paragraph = paragraph.add_run(if stage { run(text).italic().color(grey) } else { run(text) });
                    }
                }
                doc.add_paragraph(paragraph)
            }
            Item::Cue(CueBox { number, title, trigger, rows }) => {
                let mut paragraph = Paragraph::new().indent(Some(170), None, None, None);
                paragraph = paragraph.add_run(run(&format!("▌ Cue {number}  {title}")).bold().size(20)).add_run(run(&format!("    {trigger}")).color(grey).size(20));
                for (label, value) in rows {
                    paragraph = paragraph
                        .add_run(Run::new().add_break(BreakType::TextWrapping))
                        .add_run(run(&format!("▌ {label}: ")).bold().color(grey).size(20))
                        .add_run(run(value).size(20));
                }
                doc.add_paragraph(paragraph)
            }
        };
    }
    let mut bytes = Vec::new();
    doc.build().pack(std::io::Cursor::new(&mut bytes)).map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdstage_core::Script;
    use mdstage_core::export::Options;
    use mdstage_core::mic::Cast;

    fn book() -> Book {
        let script = Script::parse(
            "```yaml\nconfig:\n    roles:\n        Anna: {color: blue}\n```\n\n# Ein \"Titel\" mit #Raute und $Dollar\n\n## Szene [1]\n\n*Licht* aus.\n\n```yaml\nmic: Anna\nmusic: a.wav\nnote: \"Zeile\\\\mit Backslash\"\ntrigger_note: {ch: 1, note: 1}\n```\n\n**Anna**\nHallo *(leise)* du.\nZweite @Zeile.\n",
        );
        let cast = Cast::from_script(&script, false);
        script.book(&cast, Options { cues: true, colours: true, grouped_mics: true }, &[])
    }

    #[test]
    fn splits_inline_stage_directions() {
        assert_eq!(stage_spans("Hallo *(leise)* du."), [(false, "Hallo "), (true, "(leise)"), (false, " du.")]);
        assert_eq!(stage_spans("*(ab)*"), [(true, "(ab)")]);
        assert_eq!(stage_spans("kein *( Ende"), [(false, "kein *( Ende")]);
    }

    #[test]
    fn script_text_only_appears_in_string_literals() {
        let source = typst_source(&book(), "10.10.2026");
        assert!(source.contains(r#"#heading(level: 1, "Ein \"Titel\" mit #Raute und $Dollar")"#), "{source}");
        assert!(source.contains(r#""Zeile\\mit Backslash""#));
        assert!(source.contains(r##"fill: rgb("#61afef"), "Anna")"##));
        assert!(source.contains(r#"#text(style: "italic", fill: luma(102), "(leise)")"#));
    }

    #[test]
    fn produces_a_pdf() {
        let bytes = pdf(&book(), "10.10.2026").unwrap();
        assert!(bytes.starts_with(b"%PDF-"), "not a PDF");
        assert!(bytes.len() > 5_000);
    }

    #[test]
    fn produces_a_docx() {
        let bytes = docx(&book(), "10.10.2026").unwrap();
        assert!(bytes.starts_with(b"PK"), "a .docx is a zip archive");
        assert!(bytes.len() > 2_000);
    }
}
