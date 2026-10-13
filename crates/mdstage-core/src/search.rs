//! Search over the script that forgives: punctuation and case do not count, words may
//! be left out or stand in another order, and a word is known again by its beginning
//! ("geh" finds "gehen"). The hits come best first.

/// The words of a text: lower case, without punctuation.
pub fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// How much two words are the same word: 1 for the same, somewhat less if one is the
/// beginning of the other (three letters at least), else 0.
fn alike(a: &str, b: &str) -> f64 {
    let (short, long) = if a.chars().count() <= b.chars().count() { (a, b) } else { (b, a) };
    if short == long {
        1.0
    } else if short.chars().count() >= 3 && long.starts_with(short) {
        0.8
    } else {
        0.0
    }
}

/// The texts that `query` finds, as indices into `texts`, best first. Among hits that
/// are equally good the one that comes first from `from` on is first, and those before
/// `from` come after the end of the script.
///
/// A text that has the query in it word for word is best. Otherwise it counts how many
/// of the query's words a text has, each word weighing more the rarer it is in the
/// script (so "nach" says little and "Hause" a lot); half of that weight makes a hit.
pub fn rank(texts: &[String], query: &str, from: usize) -> Vec<usize> {
    let phrase = query.trim().to_lowercase();
    let wanted = words(query);
    if phrase.is_empty() {
        return Vec::new();
    }
    let bags: Vec<Vec<String>> = texts.iter().map(|text| words(text)).collect();
    // For every word of the query, how well each text has it.
    let found: Vec<Vec<f64>> = wanted.iter().map(|word| bags.iter().map(|bag| bag.iter().map(|w| alike(word, w)).fold(0.0, f64::max)).collect()).collect();
    let count = texts.len().max(1) as f64;
    let weights: Vec<f64> = found.iter().map(|in_texts| (1.0 + count / in_texts.iter().filter(|q| **q > 0.0).count().max(1) as f64).ln()).collect();
    let total: f64 = weights.iter().sum();

    let mut hits: Vec<(i64, usize, usize)> = Vec::new();
    for (index, text) in texts.iter().enumerate() {
        let covered = if total > 0.0 { found.iter().zip(&weights).map(|(in_texts, weight)| in_texts[index] * weight).sum::<f64>() / total } else { 0.0 };
        let word_for_word = text.to_lowercase().contains(&phrase);
        if !word_for_word && covered < 0.5 {
            continue;
        }
        let score = covered + if word_for_word { 1.0 } else { 0.0 };
        // (In steps of a hundredth, so that hits as good as each other keep their order.)
        let distance = (index + texts.len() - from.min(texts.len())) % texts.len();
        hits.push((-(score * 100.0).round() as i64, distance, index));
    }
    hits.sort();
    hits.into_iter().map(|(_, _, index)| index).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts() -> Vec<String> {
        ["Hallo, mein Schatz!", "Geh nach Hause.", "Wir fahren nach Berlin.", "Du bist nicht allein.", "Hallo Welt", "Nach dem Essen sollst du ruhen."].iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn forgives_punctuation_case_and_missing_words() {
        let texts = texts();
        assert_eq!(rank(&texts, "hallo mein schatz", 0), [0]);
        assert_eq!(rank(&texts, "hallo schatz", 0)[0], 0);
        assert_eq!(rank(&texts, "Du sollst nach Hause gehen", 0)[0], 1);
        // A word is known by its beginning, in either direction.
        assert_eq!(rank(&texts, "berl", 0), [2]);
        assert_eq!(rank(&texts, "hauses", 0), [1]);
        assert_eq!(rank(&texts, "xyz", 0), Vec::<usize>::new());
        assert_eq!(rank(&texts, "   ", 0), Vec::<usize>::new());
    }

    #[test]
    fn the_best_hit_is_first_and_equal_ones_follow_the_script_from_the_place() {
        let texts = texts();
        // Word for word beats words scattered about.
        assert_eq!(rank(&texts, "nach hause", 0)[0], 1);
        // Equally good hits: from the place on, then round to the start.
        assert_eq!(rank(&texts, "hallo", 0), [0, 4]);
        assert_eq!(rank(&texts, "hallo", 1), [4, 0]);
        assert_eq!(rank(&texts, "nach", 2), [2, 5, 1]);
        // Part of a word still finds it, as plain search does.
        assert_eq!(rank(&texts, "erli", 0), [2]);
    }
}
