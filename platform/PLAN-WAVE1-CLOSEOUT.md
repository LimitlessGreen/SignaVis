# Platform Plan Closeout (Wave 1)

Stand: 2026-05-09

## Ergebnis

Wave 1 ist fuer den aktuellen Scope abgeschlossen.

Umgesetzt wurden insbesondere:
- Desktop/IPC-Basis inkl. lokalem Job-Runner-Scaffold
- API-Baseline mit OIDC, RBAC-Scope-Pruefungen und Actor-Identity-Enforcement
- OpenAPI-Erweiterungen fuer 401/403-Fehlerfaelle und Rollenanforderungen
- RBAC-/AuthZ-Testharness (Unit + Route-Flow + Identity-Faelle)
- Vertical-Slice-Integrationstest lokal und Flakiness-Hardening

## Verifikation

Reproduzierbar erfolgreich ausgefuehrt:
- `npm run platform:test:rbac`
- `npm run platform:test:authz`
- `npm run platform:test:vertical-slice:local` (mehrfach hintereinander)
- `DATABASE_URL=postgresql://aw_platform:aw_platform@127.0.0.1:5432/aw_platform npm run migrate`
- `DATABASE_URL=postgresql://aw_platform:aw_platform@127.0.0.1:5432/aw_platform npm run migrate:status`

DB-Runtime-Nachweis (WSL/Arch, lokal):
- PostgreSQL 18.3 installiert und lokal gestartet
- Migrationen `0001_schema_v1.sql` und `0002_seed_v1.sql` erfolgreich angewendet
- `schema_migrations` enthaelt beide IDs inkl. Timestamp

## Offene Next-Wave-Themen

Diese Punkte bleiben explizit fuer die naechste Welle:
- M2-Restpunkte (Admin UI, 2-User-E2E, erweiterte Multiuser-Produktreife)
- M3+ Ausbau (Queue/Scheduler-Robustheit, Compute Nodes/GPU, Similarity/Clustering)

## Referenzen

- Externer Arbeitsplan: `../plans/platform-implementation-backlog.md` (workspace-weit, ausserhalb dieses Git-Repos)
- Vertrag: `platform/contracts/openapi.yaml`
- Governance: `platform/contracts/CONTRACT-GOVERNANCE.md`
