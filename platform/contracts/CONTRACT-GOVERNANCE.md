# Contract Governance

Ziel: stabile API- und Protobuf-Vertraege fuer Desktop, Browser, Gateway und interne Services.

## Versionierung

- OpenAPI und Proto werden semantisch versioniert.
- Breaking Changes nur mit Major-Update.
- Additive Felder/Endpunkte sind Minor-Updates.
- Dokumentations- und Beispielanpassungen sind Patch-Updates.

## Kompatibilitaetsregeln

- Keine Feld-Entfernung in Proto-Nachrichten ohne Major.
- Keine Reuse geloeschter Proto-Field-Nummern.
- OpenAPI-Responsefelder werden nicht stillschweigend umbenannt.
- Deprecated Endpunkte muessen mindestens einen Release-Zyklus bestehen bleiben.

## Review-Prozess

- Jede Contract-Aenderung braucht:
  - Changelog-Eintrag
  - Beispielrequest/-response
  - Konsumenten-Impact-Notiz (Desktop, Web, Worker)
- Pflichtreview durch mindestens eine Person aus:
  - Backend
  - Frontend/Desktop

## Testanforderungen

- OpenAPI muss syntaktisch valide sein.
- Proto-Compile muss in CI laufen (wenn grpc feature aktiv).
- Mindestens ein Integrationspfad muss den geaenderten Contract verwenden.

## Artefakte

- Externer Contract: platform/contracts/openapi.yaml
- Interne gRPC Contracts:
  - src-tauri/proto/analysis/v1/analysis.proto
  - src-tauri/proto/projects/v1/projects.proto
  - src-tauri/proto/jobs/v1/jobs.proto
