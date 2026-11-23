// ═══════════════════════════════════════════════════════════════════════
// guano.rs — Ort aus dem GUANO-Block einer WAV-Datei (fuer die Karte)
//
// Laeuft die RIFF-Chunks per Seek ab (der `guan`-Chunk steht oft hinter den
// Audiodaten), liest nur diesen Chunk und gibt `Loc Position` und `Site Name`
// zurueck. Ausgewertet wird im Frontend (contextFromGuano).
// ═══════════════════════════════════════════════════════════════════════

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// GUANO-Bloecke sind klein; groessere Chunks werden nicht gelesen.
const MAX_GUANO: u32 = 64 * 1024;

#[derive(Serialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GuanoPlace {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
}

/// `Loc Position` / `Site Name` einer WAV-Datei; None ohne GUANO-Ort.
pub fn read_place(path: &Path) -> Option<GuanoPlace> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext != "wav" && ext != "wave" {
        return None;
    }
    let text = read_guano(&mut std::fs::File::open(path).ok()?)?;
    let place = parse_place(&text);
    (place.position.is_some() || place.site.is_some()).then_some(place)
}

fn read_guano<R: Read + Seek>(f: &mut R) -> Option<String> {
    let mut head = [0u8; 12];
    f.read_exact(&mut head).ok()?;
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12u64;
    loop {
        let mut ch = [0u8; 8];
        f.seek(SeekFrom::Start(pos)).ok()?;
        f.read_exact(&mut ch).ok()?;
        let size = u32::from_le_bytes([ch[4], ch[5], ch[6], ch[7]]);
        if &ch[0..4] == b"guan" {
            if size > MAX_GUANO {
                return None;
            }
            let mut buf = vec![0u8; size as usize];
            f.read_exact(&mut buf).ok()?;
            return Some(String::from_utf8_lossy(&buf).into_owned());
        }
        // Chunks sind auf gerade Laengen aufgefuellt.
        pos += 8 + size as u64 + (size as u64 & 1);
    }
}

fn parse_place(text: &str) -> GuanoPlace {
    let mut out = GuanoPlace::default();
    for line in text.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        match k.trim() {
            "Loc Position" => out.position = Some(v.to_string()),
            "Site Name" => out.site = Some(v.to_string()),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn wav(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut body = b"WAVE".to_vec();
        for (id, data) in chunks {
            body.extend_from_slice(*id);
            body.extend_from_slice(&(data.len() as u32).to_le_bytes());
            body.extend_from_slice(data);
            if data.len() % 2 == 1 {
                body.push(0);
            }
        }
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend(body);
        out
    }

    #[test]
    fn finds_guano_after_odd_sized_data() {
        let g = b"GUANO|Version: 1.0\nLoc Position: 19.43 -155.25\nSite Name: Kilauea\nMake: Wildlife Acoustics\n".to_vec();
        let bytes = wav(&[(b"fmt ", vec![0; 16]), (b"data", vec![1; 1001]), (b"guan", g)]);
        let text = read_guano(&mut Cursor::new(bytes)).unwrap();
        assert_eq!(
            parse_place(&text),
            GuanoPlace { position: Some("19.43 -155.25".into()), site: Some("Kilauea".into()) }
        );
    }

    #[test]
    fn no_guano_or_not_wav() {
        assert_eq!(read_guano(&mut Cursor::new(wav(&[(b"data", vec![0; 10])]))), None);
        assert_eq!(read_guano(&mut Cursor::new(b"fLaC....".to_vec())), None);
        assert_eq!(parse_place("Make: X\nSite Name:  \n"), GuanoPlace::default());
    }
}
