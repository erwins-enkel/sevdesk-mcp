# Sicherheit und Datenschutz

**Deutsch** · [English](../en/safety.md) · [Übersicht](../../README.md#deutsch)

## Unumkehrbare Aufrufe

Lesen sowie Entwürfe anlegen oder ändern läuft direkt. Alles, was sich nicht rückgängig machen
lässt (löschen, versenden, festschreiben, buchen, stornieren, zurücksetzen, den Status eines
Dokuments ändern, `getPdf` ohne `preventSendBy=true` und jeder Schreibpfad, den die
sevdesk-Spezifikation nicht kennt), wird zurückgehalten statt gesendet:

1. Der Aufruf im Code ergibt `{ held: true }` und der Code läuft weiter; Entwürfe davor und danach
   entstehen wie gewohnt.
2. Klappt der Lauf, enthält sein Ergebnis `confirmation`: einen Token und eine Vorschau jedes
   zurückgehaltenen Aufrufs (genaue Methode, Pfad, Query und Body; bei Angebot, Rechnung,
   Gutschrift oder Beleg Art, Nummer, Datum, Netto- und Bruttobetrag mit Währung und
   Empfänger:in; der Mail-Betreff; das Profil und seine Firma). Der Assistent zeigt dir die
   Vorschau.
3. Erst nach deinem Ja ruft er `execute` mit `confirm` auf, gesetzt auf den Token, ohne Code. Der
   Server sendet dann genau die zurückgehaltenen Aufrufe, in der Reihenfolge, jeden einmal und
   ohne Wiederholung. Er hört beim ersten Aufruf auf, den sevdesk nicht annimmt, und meldet jeden
   Aufruf als `sent`, `failed` oder `not_sent`. Ein Aufruf, den sevdesk angenommen hat (2xx), ist
   `sent`, auch wenn sich seine Antwort nicht lesen lässt.

Ein Token gilt einmal, 10 Minuten lang, für das Profil, das die Aufrufe zurückgehalten hat, und
nur bis zum Neustart des Servers. Scheitert der Lauf, verfallen seine zurückgehaltenen Aufrufe und
es gibt keinen Token. Zurückgehaltene Aufrufe und das Lesen der betroffenen Dokumente für die
Vorschau zählen zu [`limits.callsPerRun`](konfiguration.md). Das Profil von `SEVDESK_API_TOKEN`
hat keine Firma in der Konfigurationsdatei; seine Vorschau nennt deshalb nur das Profil.

## Nur-Lesen-Modus

Im Nur-Lesen-Modus kann `execute` in sevdesk nichts ändern. Er ist für einen Aufruf an, wenn einer
der beiden Schalter an ist; keiner kann den anderen ausschalten:

- `SEVDESK_READONLY` in der Umgebung des MCP-Servers schaltet ihn für jedes Profil ein. Jeder Wert
  außer leer, `false` oder `0` (Groß-/Kleinschreibung egal) gilt als an.
- `"readonly": true` in einem Profil der [Konfigurationsdatei](konfiguration.md) schaltet ihn für
  dieses Profil ein, auch mit `SEVDESK_READONLY=false`. Das Profil von `SEVDESK_API_TOKEN` hat
  diesen Schalter nicht; für es gilt nur `SEVDESK_READONLY`.

Im Nur-Lesen-Modus scheitert jeder Aufruf, der kein GET ist, und jeder Aufruf, der zur Bestätigung
zurückgehalten würde (auch ein GET wie `getPdf` ohne `preventSendBy=true`), mit einem
`read_only`-Fehler. So ein Aufruf wird sofort abgelehnt, nie zurückgehalten, also bringt ihn kein
Bestätigungstoken durch, und auch `execute` mit `confirm` wird abgelehnt. Lesen und
`sevdesk.savePdf` funktionieren weiter (`savePdf` setzt immer `preventSendBy=true`). Das Rendern,
das `savePdf` für einen Entwurf sendet, ist der eine Schreibaufruf, den der Nur-Lesen-Modus
durchlässt: Es ändert keinen Status, hält das PDF aktuell und steht in `writes` und im Audit-Log.
Dasselbe Rendern über `sevdesk.request` wird abgelehnt. Ist `SEVDESK_READONLY` an oder ist der
Server mit `--profile` auf ein Nur-Lesen-Profil festgelegt, trägt `execute` die MCP-Annotation
`readOnlyHint`. Der Server liest beide Schalter beim Start; starte ihn nach einer Änderung also
neu.

## Audit-Log

Jeder Schreibaufruf, den `execute` bearbeitet, hinterlässt eine Zeile in einem lokalen Audit-Log,
damit du siehst, was der Server ändern wollte. Es ist eine JSON-Lines-Datei pro Monat (UTC), z. B.
`2026-11.jsonl`, im Ordner `audit` des Daten-/State-Ordners:

| Betriebssystem | Audit-Ordner                                                                   |
| -------------- | ------------------------------------------------------------------------------ |
| Linux          | `$XDG_STATE_HOME/sevdesk-mcp/audit/` (Standard `~/.local/state/sevdesk-mcp/…`) |
| macOS          | `~/Library/Application Support/sevdesk-mcp/audit/`                             |
| Windows        | `%LOCALAPPDATA%\sevdesk-mcp\audit\` (meist `C:\Users\<du>\AppData\Local\…`)    |

Eine Zeile enthält `time` (ISO 8601, UTC), `profile`, `method`, `path`, `query` (falls vorhanden),
`status` (der HTTP-Status von sevdesk, falls es geantwortet hat), `objectId` (falls die Antwort
eine nennt), `bodyHash` (der SHA-256 des JSON-Body, falls vorhanden) und `outcome`:

- `executed`: ein Entwurf oder ein anderer umkehrbarer Schreibaufruf, direkt gesendet.
- `held`: ein unumkehrbarer Aufruf, für deine Bestätigung zurückgehalten und nicht gesendet. Ein
  gescheiterter Lauf verwirft ihn; er wird dann nie gesendet.
- `confirmed`: ein zurückgehaltener Aufruf, nach deiner Bestätigung gesendet; `status` zeigt, ob
  sevdesk ihn angenommen hat.
- `rejected`: ein Aufruf, den der Nur-Lesen-Modus abgelehnt hat, oder ein unumkehrbarer Lesezugriff,
  den `sevdesk.paginate` abgelehnt hat; nicht gesendet.

Lesezugriffe bekommen keine Zeile. Das Log enthält nie einen Request-Body (keine Kundendaten) und
nie den Token. Der Server löscht oder rotiert es nie; alte Monate entfernst du selbst. Mehrere
MCP-Clients mit je eigenem Server können gleichzeitig hineinschreiben, ohne Zeilen zu zerreißen,
solange der Ordner auf einer lokalen Platte liegt (nicht auf einer Netzwerkfreigabe). Lässt sich
das Log nicht schreiben, scheitert der Aufruf mit einem `audit_error` und der Lauf hört auf, statt
ohne Protokoll weiterzumachen: Ein Schreibaufruf wird nicht gesendet, ein unumkehrbarer Aufruf
nicht zurückgehalten, und eine Bestätigung sendet nichts und behält ihren Token. Scheitert das
Schreiben erst, nachdem sevdesk geantwortet hat (z. B. bei voller Platte), sagt der Fehler, dass
der Aufruf gesendet wurde. Zum Ausschalten setzt du `"audit": false` in der Konfigurationsdatei
und startest den Server neu.

## Datenschutz

Der Server läuft auf deinem Rechner und spricht nur mit sevdesk. Er sendet keine Telemetrie und
keine Absturzberichte. Aus einem lokalen Checkout führen das Tool `version` und
`sevdesk-mcp config` zusätzlich ein `git fetch` des Upstreams aus; dabei gehen keine Nutzerdaten
raus ([Beta-Test](beta-test.md)).

Der API-Token bleibt auf deinem Rechner: Er kommt aus dem Schlüsselbund oder aus
`SEVDESK_API_TOKEN` und wird jeder Anfrage außerhalb der Sandbox hinzugefügt; weder der Code, den
das Modell schreibt, noch das Modell selbst sieht ihn je.

Was `execute` zurückgibt, geht an den KI-Anbieter hinter deinem MCP-Client, wie alles andere im
Gespräch: das Ergebnis, die Konsolenausgabe und die Liste der Schreibaufrufe. Frag deshalb nach
dem, was du brauchst, etwa nach Summen statt nach jeder einzelnen Rechnung, statt nach ganzen
Datensätzen. PDFs und Exporte landen auf der Platte, zurück geht nur ihr Pfad
([Dateien](dateien.md)).
