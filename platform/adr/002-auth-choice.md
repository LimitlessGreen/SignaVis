# ADR 002: Authentifizierung/Autorisierung

Status: accepted

Entscheidung:
- OIDC-kompatibler Identity Provider (Keycloak in Testumgebung).
- Rollenmodell: platform_admin, project_manager, annotator, reviewer.

Begründung:
- Standardisierte Token- und Session-Mechanik.
- Saubere Trennung von Identität und Business-Logik.

Konsequenzen:
- API muss JWT-Claims gegen Team-/Projekt-Scope prüfen.
- Frontend benötigt Login/Refresh-Flow.
