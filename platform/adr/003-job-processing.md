# ADR 003: Hintergrundjobs

Status: accepted

Entscheidung:
- Import- und Analysejobs laufen asynchron über eine Queue (Redis-basiert im Testsetup).

Begründung:
- Lange Jobs blockieren keine User-Requests.
- Stabilere Wiederholbarkeit und Fehlerbehandlung.

Konsequenzen:
- API erzeugt Job-Events; Worker verarbeitet sie.
- UI zeigt Jobstatus und Fortschritt (queued/running/partial/failed/done).
