# Platform DB

Dieses Modul enthaelt schema-basierte SQL-Migrationen fuer die Plattformdatenbank.

## Struktur

- migrations/0001_schema_v1.sql
- migrations/0002_seed_v1.sql
- scripts/migrate.mjs

## Verwendung

Voraussetzungen:
- PostgreSQL erreichbar
- DATABASE_URL gesetzt

Status anzeigen:

npm run migrate:status

Migrationen anwenden:

npm run migrate

## Hinweise

- Migrationen sind strikt aufsteigend nummeriert.
- Jede Migration wird in schema_migrations protokolliert.
- Bestehende Initialisierungs-SQLs unter db/init bleiben fuer Docker-Bootstrap erhalten.
