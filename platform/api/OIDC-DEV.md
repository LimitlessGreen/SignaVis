# OIDC Dev Runbook (Gateway)

Diese API nutzt OIDC-Tokenpruefung fuer alle /api/v1 Endpunkte.

## Environment

Relevante Variablen:
- OIDC_ISSUER (z. B. http://localhost:8080/realms/signavis)
- OIDC_AUDIENCE (z. B. signavis-api)
- AUTH_MODE (disabled | optional | required)

Default:
- AUTH_MODE = required

## Verhalten

- /health bleibt ohne Auth erreichbar.
- /api/v1/* verlangt Bearer-Token (bei mode=required).
- /api/v1/auth/me gibt geparsten Auth-Kontext zurueck.

## Lokaler Test mit Keycloak (Direct Grant)

Beispieltoken holen:

curl -s -X POST "http://localhost:8080/realms/signavis/protocol/openid-connect/token" \
  -H "content-type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=signavis-desktop" \
  -d "username=admin" \
  -d "password=admin"

Token verwenden:

curl -H "Authorization: Bearer <ACCESS_TOKEN>" http://localhost:8788/api/v1/auth/me

## Fehlerfaelle

- missing_token: kein Bearer-Token uebergeben
- invalid_token: Token nicht pruefbar oder abgelaufen
