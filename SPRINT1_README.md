# GLE Backend — Sprint 1 integriert

Stand: 01.08.2026

Dieses Paket wurde auf Basis von `GLE_Backend_Aktuell.zip` erstellt.
Die vorhandene Studio-Logik (Stripe, Limits, BYOK, Beta-Lock, 7-Zeilen-Social-Validator und bestehende Textregeln) wurde beibehalten.

## Neu

- `src/gateway/` als gemeinsames Multi-Engine-Gateway
- OpenAI Provider
- DeepSeek Provider
- interne GLE-Aliasse: `gle-fast`, `gle-balanced`, `gle-precision`, `gle-judge`
- einheitliche Gateway-Fehlerklassen
- GLE Request-ID pro Generierungsauftrag
- Provider-/Token-/Kostenprotokoll nach `DATA_DIR/gle-provider-usage.jsonl`
- Prompt- und Output-SHA-256 im Protokoll; rohe Prompts werden dort nicht gespeichert
- `/api/generate` läuft jetzt über das Gateway
- BYOK bleibt OpenAI-kompatibel
- `/api/test` läuft ebenfalls über das Gateway
- `/api/health` zeigt Gateway-Konfiguration
- OpenRouter bleibt bewusst nur als späterer Platzhalter

## Verhalten nach dem Einbau

Ohne neue ENV-Variablen bleibt das bestehende Studio standardmäßig auf OpenAI:

- PRO -> `gle-balanced` -> OpenAI
- Boost -> `gle-precision` -> OpenAI
- FREE Server -> `gle-balanced` -> OpenAI
- BYOK -> OpenAI mit dem bisherigen BYOK-Modell

DeepSeek ist damit technisch vorbereitet, aber noch nicht automatisch für das Studio aktiviert.

## Gefundener Altfehler behoben

Im aktuellen `server.js` befand sich ein doppelter Beta-Checkout-Guard auf Top-Level, der bei deaktiviertem Stripe-Checkout `res` verwendete, obwohl dort kein Request/Response-Kontext existiert. Dieser fehlerhafte Doppelblock wurde entfernt. Die korrekte Checkout-Prüfung innerhalb von `/api/create-checkout-session` bleibt bestehen.

## Tests

Ausgeführt und bestanden:

- `node --check server.js`
- Gateway Smoke-Test
- Server-Load Smoke-Test
- `npm test`

## Neue ENV-Variablen

Siehe `.env.gateway.example`.

Für den ersten Einbau müssen noch keine DeepSeek-Variablen gesetzt werden.

Wenn DeepSeek später aktiviert wird, mindestens:

```env
DEEPSEEK_API_KEY=...
DEEPSEEK_API_BASE=https://api.deepseek.com
```

und z. B. eine Alias-Zuordnung:

```env
GLE_FAST_PROVIDER=deepseek
GLE_FAST_MODEL=deepseek-v4-flash
```

## Git-Hinweis

Lokal entsteht nach echten Requests:

`data/gle-provider-usage.jsonl`

Diese Datei sollte nicht committed werden. Ergänze später in `.gitignore`:

```gitignore
data/gle-provider-usage.jsonl
```
