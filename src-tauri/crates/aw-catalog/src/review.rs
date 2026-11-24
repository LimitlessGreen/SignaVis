//! Review state per recording (Annotate space): never opened (NULL), "open", "done".

use rusqlite::params;

use crate::{now_ms, Catalog, Result};

/// Set the review state of recordings. `state` None resets to new. With `only_new`, recordings
/// that already have a state keep it (opening a recording marks it "open", never undoes "done").
/// Returns how many changed.
pub fn set_review(cat: &mut Catalog, ids: &[i64], state: Option<&str>, only_new: bool) -> Result<usize> {
    if let Some(s) = state {
        if s != "open" && s != "done" { return Err(format!("unknown review state {s}").into()); }
    }
    let tx = cat.conn.transaction()?;
    let mut n = 0;
    {
        let sql = if only_new {
            "UPDATE recording SET review = ?2, review_ms = ?3 WHERE id = ?1 AND review IS NULL"
        } else {
            "UPDATE recording SET review = ?2, review_ms = ?3 WHERE id = ?1 AND review IS NOT ?2"
        };
        let mut st = tx.prepare(sql)?;
        let at = state.map(|_| now_ms());
        for &id in ids { n += st.execute(params![id, state, at])?; }
    }
    tx.commit()?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::{facets, ids, Filter};

    fn cat_with(n: usize) -> Catalog {
        let cat = Catalog::open_in_memory().unwrap();
        for i in 0..n {
            cat.conn.execute("INSERT INTO recording(uid, source, start_ms) VALUES (?1, 'url', ?2)", params![format!("u{i}"), 1_678_000_000_000i64 + i as i64 * 60_000]).unwrap();
        }
        cat
    }

    fn by(cat: &Catalog, s: &str) -> Vec<i64> {
        ids(cat, &Filter { review: Some(s.into()), ..Default::default() }).unwrap()
    }

    #[test]
    fn open_never_undoes_done_and_filters_follow() {
        let mut cat = cat_with(4);
        let all = ids(&cat, &Filter::default()).unwrap();
        assert_eq!(set_review(&mut cat, &all[..2], Some("done"), false).unwrap(), 2);
        // Opening marks only new ones.
        assert_eq!(set_review(&mut cat, &all[..3], Some("open"), true).unwrap(), 1);
        assert_eq!(by(&cat, "done"), all[..2].to_vec());
        assert_eq!(by(&cat, "open"), vec![all[2]]);
        assert_eq!(by(&cat, "new"), vec![all[3]]);
        assert_eq!(by(&cat, "todo"), all[2..].to_vec());
        let f = facets(&cat, &Filter::default()).unwrap();
        assert_eq!((f.review_open, f.review_done), (1, 2));
        // Reset to new; unknown states are refused.
        assert_eq!(set_review(&mut cat, &all[..1], None, false).unwrap(), 1);
        assert_eq!(by(&cat, "new").len(), 2);
        assert!(set_review(&mut cat, &all, Some("maybe"), false).is_err());
        assert!(ids(&cat, &Filter { review: Some("maybe".into()), ..Default::default() }).is_err());
    }
}
