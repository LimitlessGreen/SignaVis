# ADR 001: Primäre Datenbank

Status: accepted

Entscheidung:
- Für die Plattform wird PostgreSQL als primärer Persistenz-Layer verwendet.

Begründung:
- Transaktionale Konsistenz für Multi-User-Workflows.
- Gute JSONB-Unterstützung für flexible Metadaten.
- Reife Migrations- und Betriebstools.

Konsequenzen:
- Lokale JSON-Projekte bleiben nur Kompatibilitätspfad.
- Schema-Migrationen sind verpflichtender Teil von Deployments.
