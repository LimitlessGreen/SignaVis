//! Serializable import profile (stored per project, sent over IPC, shared between users).

use crate::{FieldMapping, FieldRole, ImportProfile, pattern::{PatternError, PatternSet}};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MappingSpec {
    pub field: String,
    /// site | device | start | date | time | ignore | meta:<key>
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub lookup: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSpec {
    pub name: String,
    pub patterns: Vec<String>,
    #[serde(default)]
    pub mappings: Vec<MappingSpec>,
    #[serde(default)]
    pub utc_offset_min: i32,
    #[serde(default)]
    pub tz: Option<String>,
    /// Extra folder-name regexes treated as derived data (in addition to the defaults).
    #[serde(default)]
    pub derived_dirs: Vec<String>,
}

pub fn parse_role(role: &str) -> Result<FieldRole, PatternError> {
    Ok(match role {
        "site" => FieldRole::Site,
        "device" => FieldRole::Device,
        "start" => FieldRole::Start,
        "date" => FieldRole::StartDate,
        "time" => FieldRole::StartTime,
        "ignore" => FieldRole::Ignore,
        r if r.starts_with("meta:") && r.len() > 5 => FieldRole::Meta(r[5..].to_string()),
        r => return Err(PatternError(format!("unknown role '{r}'"))),
    })
}

impl ProfileSpec {
    pub fn build(&self) -> Result<ImportProfile, PatternError> {
        let refs: Vec<&str> = self.patterns.iter().map(|s| s.as_str()).collect();
        let mappings = self.mappings.iter().map(|m| Ok(FieldMapping {
            field: m.field.clone(),
            role: parse_role(&m.role)?,
            format: m.format.clone(),
            lookup: m.lookup.clone(),
        })).collect::<Result<_, PatternError>>()?;
        Ok(ImportProfile {
            name: self.name.clone(),
            patterns: PatternSet::parse(&refs)?,
            mappings,
            utc_offset_min: self.utc_offset_min,
            tz: self.tz.clone(),
        })
    }

    pub fn scan_options(&self) -> Result<crate::scan::ScanOptions, PatternError> {
        let mut o = crate::scan::ScanOptions::default();
        for d in &self.derived_dirs {
            o.derived_dirs.push(regex::Regex::new(&format!("(?i)^(?:{d})$")).map_err(|e| PatternError(e.to_string()))?);
        }
        Ok(o)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip_and_build() {
        let json = r#"{"name":"am","patterns":["{site}/{t:%Y%m%d_%H%M%S}.WAV"],
            "mappings":[{"field":"site","role":"site","format":"Site {}"},{"field":"t","role":"start"}],
            "utcOffsetMin":60}"#;
        let spec: ProfileSpec = serde_json::from_str(json).unwrap();
        let p = spec.build().unwrap();
        assert_eq!(p.mappings[0].role, FieldRole::Site);
        let back: ProfileSpec = serde_json::from_str(&serde_json::to_string(&spec).unwrap()).unwrap();
        assert_eq!(back, spec);
        assert!(ProfileSpec { mappings: role_bad(), ..Default::default() }.build().is_err());
    }

    fn role_bad() -> Vec<MappingSpec> { vec![MappingSpec { field: "x".into(), role: "nope".into(), ..Default::default() }] }
}
