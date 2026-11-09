# PRD: sevdesk-mcp (Code Mode)

**Stand:** 2026-11-09 · Entwurf v0.2 (ergänzt um die Produktentscheidungen aus `docs/decisions/0002-product-decisions.md`, im Text als „0002 Nr. …“ zitiert) · Autor: Kai Osthoff (erwins enkel / manu·fare), erarbeitet mit Claude
**Repo:** `github.com/erwins-enkel/sevdesk-mcp` (public, MIT)
**npm:** `@erwins-enkel/sevdesk-mcp`

---

## 1. Worum es geht

Ein lokaler, quelloffener MCP-Server, der **die komplette sevDesk-API** für KI-Assistenten nutzbar macht – mit nur **zwei Tools** statt rund 150. Statt einem Tool pro Endpunkt schreibt das Modell kleine JavaScript-Schnipsel, die der Server in einer lokalen Sandbox gegen die sevDesk-API ausführt („Code Mode“, nach dem Muster von Cloudflare und Anthropic). Zurück kommt nur das Ergebnis.

**Warum:** Es gibt bereits ~10 sevDesk-MCPs auf GitHub (z. B. `nikolausm/mcp-sevdesk`, `joosthel/sevdesk-mcp`), alle nach dem Muster „ein Tool pro Endpunkt“. Das füllt den Kontext des Modells mit zehntausenden Tokens Tool-Beschreibungen. Keiner nutzt Code Mode. Das ist unser Alleinstellungsmerkmal: **„Die ganze sevDesk-API in zwei Tools.“**

**Nebenziele:** Material für ein YouTube-Video (manu·fare / erwins enkel) und Aufhänger für den KI-Kundendialog mit Systemhäusern.

## 2. Zielgruppe

- **Primär:** Kai, lokal, ein sevDesk-Konto (manu·fare).
- **Sekundär:** jede:r sevDesk-Nutzer:in, die/der den Server aus dem öffentlichen Repo installiert – daher von Anfang an **mehrmandantenfähig** und mit einfacher Einrichtung.

## 3. Unterstützte Clients

Alle per **stdio**, ein Server-Binary für alle:

| Client | Einbindung | Priorität |
|---|---|---|
| Claude Desktop | `.mcpb`-Paket (Doppelklick, Token-Feld) oder `claude_desktop_config.json` | **v1** |
| ChatGPT Desktop | Settings → MCP servers → Add server → STDIO (teilt `~/.codex/config.toml`) | **v1** |
| Claude Code | `claude mcp add` | v1 (mitgetestet) |
| Codex CLI | `codex mcp add` / `~/.codex/config.toml` | v1 (gleiche Config wie ChatGPT Desktop) |
| OpenCode | `opencode.json` → `mcp` | v1.x |
| PyAgent / sonstige | generischer stdio-Eintrag, Token per Umgebungsvariable | v1.x |

## 4. Anwendungsfälle

**Priorität A – Angebot an einen Kunden:**
> „Mach ein Angebot an die Firma X über 3 Tage KI-Workshop à 1.200 € und schick es an Herrn Y.“

1. Kontakt suchen (Name, Kundennummer, E-Mail); falls nicht vorhanden, Firma + Ansprechpartner + Adresse + E-Mail anlegen.
2. Angebot (sevDesk `Order`, `orderType: "AN"`) als Entwurf mit Positionen anlegen, Steuerregel nach System-Update 2.0.
3. PDF abrufen und lokal ablegen, Vorschau zeigen.
4. Versand: **Standard per sevDesk-Mail** (`sendViaEmail`, Absender/Vorlage aus sevDesk); alternativ **nur PDF** (Kai verschickt selbst, z. B. Outlook oder Post über das manu·fare-Portal). Wahl pro Angebot. Versand ist bestätigungspflichtig (siehe 6). Beim Weg „nur PDF“ bleibt der Status des Angebots unverändert; „als versendet markieren“ (`sendBy`) ist ein eigener, bestätigungspflichtiger Schritt, den das Modell anbietet (0002 Nr. 7).

**Weitere (alles, was die API kann), z. B.:**
- Auswerten: offene Rechnungen, Umsatz je Kunde/Zeitraum, überfällige Posten.
- Rechnungen: aus Angebot erzeugen, anlegen, PDF, versenden, festschreiben, stornieren.
- Belege: Eingangsbeleg anlegen (inkl. Datei-Upload), buchen, Bankumsätze zuordnen.
- Stammdaten: Kontakte, Artikel, Tags; Exporte (z. B. DATEV; die Datei landet im Ablageverzeichnis, siehe 5.1).

## 5. Architektur

### 5.1 Tools (v1: reiner Code Mode)

**`search`** – Eingabe: `code` (JS). Der Code läuft gegen ein `spec`-Objekt (sevDesk-OpenAPI, `$ref`s aufgelöst) und ein `guides`-Objekt (kuratierte Hinweise, siehe 5.4). Die Spezifikation selbst gelangt nie in den Kontext, nur das, was der Code zurückgibt.

```js
// Beispiel
return Object.entries(spec.paths)
  .filter(([p]) => p.startsWith('/Order'))
  .map(([p, ops]) => ({ path: p, methods: Object.keys(ops) }));
```

**`execute`** – Eingaben: `code` (JS), `account` (Profilname; Pflicht, sobald mehrere Profile erreichbar sind, siehe 7), optional `confirm` (Bestätigungstoken, siehe 6; mit `confirm` entfällt `code`). Im Sandbox-Scope steht ein authentifizierter Client bereit:

```js
const c = await sevdesk.request('GET', '/Contact', { query: { name: 'Schlecht', depth: 1 } });
const id = c.objects[0].id;
const order = await sevdesk.request('POST', '/Order/Factory/saveOrder', { body: { /* … */ } });
const file = await sevdesk.savePdf('Order', order.order.id); // legt PDF lokal ab, gibt Pfad zurück
return { orderId: order.order.id, pdf: file };
```

Hilfsfunktionen im Scope (bewusst wenige):
- `sevdesk.request(method, path, { query, body })` – einziger Weg nach außen. Nimmt nur Pfade relativ zur konfigurierten Basis-URL an (die HTTPS sein muss), damit der Token nie an einen anderen Host geht. Liefert die API kein JSON (PDF, ZIP, CSV-Export), schreibt der Host die Datei ins Ablageverzeichnis und gibt `{ path, contentType, bytes }` zurück (0002 Nr. 15).
- `sevdesk.paginate(path, query)` – sammelt `limit`/`offset`-Seiten.
- `sevdesk.savePdf(type, id)` – holt `/…/{id}/getPdf` immer mit `preventSendBy=true` (sonst kann sevDesk das Dokument als versendet markieren; in P4 gegen die API prüfen), schreibt in das Ablageverzeichnis des Profils (Standard `~/Downloads/sevdesk/<profil>/`, pro Profil einstellbar), gibt Pfad + Dateiname zurück. Dateiname = sevDesk-Nummer (z. B. `AN-1042.pdf`), sonst `<Typ>-<id>.pdf`; eine gleichnamige Datei wird überschrieben (neueste Fassung). Binärdaten gehen nie in den Kontext (0002 Nr. 7, 14).
- `sevdesk.upload(path)` – lädt eine lokale Datei aus einem freigegebenen Ordner als Beleg-Anhang hoch (v1.x). Es gibt keinen Standardordner: Upload ist aus, bis ein Ordner konfiguriert ist; Pfade außerhalb, auch über Symlinks, werden abgelehnt (0002 Nr. 17).
- `console.log` – wird mit dem Ergebnis zurückgegeben.

Beide Tools tragen MCP-Annotations (`search`: readOnly; `execute`: destructive), damit Clients passend nachfragen. Ist der globale Read-only-Schalter an oder das festgelegte Profil read-only, trägt `execute` `readOnlyHint` (0002 Nr. 3). Beim Verbindungsaufbau schickt der Server kurze MCP-`instructions`: erst `search`, dann `execute`; Unumkehrbares braucht `confirm` (0002 Nr. 28). Gesamtumfang der Tool-Beschreibungen inkl. `instructions`: **Ziel < 1.500 Tokens**.

**Ergebnisform (0002 Nr. 11):** Jedes `execute`-Ergebnis enthält den Rückgabewert, die `console.log`-Ausgaben und eine Liste aller tatsächlich ausgeführten Schreibaufrufe (Methode, Pfad, Status, Objekt-ID) – auch wenn der Code danach scheitert, damit kein angelegter Entwurf unbemerkt bleibt. Dazu kommen ggf. die Bestätigungsanfrage (siehe 6) und der Update-Hinweis (siehe 5.6). Gibt der Code `undefined` zurück, steht dort ausdrücklich „no return value“ statt eines stillen leeren Erfolgs. Fehler kommen als `isError: true` mit `{ kind, message, status?, method?, path?, sevdeskMessage?, hint? }`; bei 401 mit dem Hinweis, `setup` neu laufen zu lassen, bei 403 mit der sevDesk-Meldung.

### 5.2 v2: kuratierte Tools

Für zuverlässige Nutzung auch mit kleineren/lokalen Modellen, intern auf demselben Client aufgebaut:

- **`find_contact`** – Suche nach Name/Kundennummer/E-Mail, liefert kompakte Treffer inkl. Adresse und Ansprechpartner.
- **`create_offer`** – Kontakt (ID oder Daten zum Anlegen), Positionen (Text, Menge, Einheit, Preis, Steuersatz), Kopf-/Fußtext, `delivery: "email" | "pdf"` (Standard `email`). Legt Entwurf an, liefert PDF + Vorschau; Versand erst mit `confirm`.
- **`get_document_pdf`** – PDF zu Angebot, Rechnung, Gutschrift oder Beleg lokal ablegen.

### 5.3 Sandbox

- **QuickJS als WebAssembly** (`quickjs-emscripten`) im Node-Prozess. Kein Cloudflare-Konto, kein Worker, keine Cloud.
- Kein Dateisystem, keine Umgebungsvariablen, kein `fetch`/Netz – nur die oben genannten Host-Funktionen. Der API-Token verlässt den Host-Prozess nie.
- Limits (konfigurierbar, global in der Konfigurationsdatei, nicht pro Profil): 30 s Laufzeit, 64 MB Speicher, max. 50 API-Aufrufe pro `execute`, Ergebnis max. ~20 KB (darüber gekürzt mit Hinweis, gezielter zu filtern).
- Fehler aus der API (Status, sevDesk-Fehlermeldung, Pfad) werden strukturiert an das Modell zurückgegeben, damit es sich selbst korrigieren kann. Im Code wirft ein API-Fehler einen abfangbaren Fehler; ein nicht abgefangener beendet den Lauf mit der Fehlerform aus 5.1.
- Automatisches Retry mit Backoff: `GET` bei 429/5xx, alle Methoden nur bei 429. Nie bei 5xx auf `POST`/`PUT`/`DELETE` (Gefahr der Doppelanlage) und nie für bestätigte Aufrufe (0002 Nr. 10).

### 5.4 OpenAPI-Spezifikation und Hinweise

- Die sevDesk-OpenAPI-Datei wird **zur Build-Zeit eingebettet** (Versionsstand im README), mit Skript `bun run update-spec` zum Aktualisieren. Sie wird mit Quellenangabe eingebettet und im README als „© sevDesk, nicht von der MIT-Lizenz umfasst“ gekennzeichnet. Vor dem ersten npm-Release werden die Bedingungen von sevDesk geprüft; ist die Weitergabe nicht erlaubt, lädt der Server die Spezifikation beim ersten Start von sevDesk und cacht sie (0002 Nr. 23).
- Eine Patch-Datei korrigiert bekannte Fehler der offiziellen Spezifikation.
- **`guides`**: kurze, kuratierte Rezepte, die `search` mit durchsucht, z. B. „Angebot anlegen (saveOrder, Pflichtfelder, orderType AN)“, „Steuerregeln nach Update 2.0 (`taxRule`)“, „Rechnung aus Angebot“, „Beleg mit Datei“, „Paginierung“. Sie machen den Unterschied zwischen „Modell rät“ und „Modell trifft beim ersten Versuch“.
- **Nur sevDesk-System 2.0:** Der Server unterstützt ausschließlich Konten mit Buchhaltungssystem 2.0 (Steuerregeln über `taxRule`). Geprüft wird per `/Tools/bookkeepingSystemVersion` im Setup und beim ersten `execute` pro Profil (für die Sitzung gecacht, nicht beim Serverstart, damit der Start schnell bleibt und kein Netz braucht); ein 1.0-Konto bekommt eine klare Fehlermeldung statt halb funktionierender Aufrufe (0002 Nr. 12). Guides und Beispiele kennen nur die 2.0-Logik.

### 5.5 Technik

TypeScript, Node ≥ 22 (Node 20 ist seit 2026-04 end-of-life, siehe `docs/decisions/0001-foundation.md`), offizielles MCP-SDK v2 (`@modelcontextprotocol/server`), Start per `npx -y @erwins-enkel/sevdesk-mcp`. Keine Datenbank, kein Server-Zustand außer Profilen; Bestätigungstoken leben nur im Speicher.

- **Plattformen:** macOS, Windows und Linux (Claude Desktop gibt es nur für macOS und Windows). Die CI bekommt macOS- und Windows-Läufe, sobald Schlüsselbund- und Pfad-Code landet (0002 Nr. 20).
- **Lokale Dateien:** in den Standardverzeichnissen des Betriebssystems (XDG unter Linux). Im Config-Verzeichnis liegt die Konfigurationsdatei (Profile ohne Token, Limits, Pfade, Audit-Schalter), im Daten-/State-Verzeichnis das Audit-Log und der Cache des Update-Checks (0002 Nr. 13).

### 5.6 Nie veralten: Versions- und Änderungs-Check

- **Täglicher GitHub-Action-Lauf** im Repo: lädt die aktuelle sevDesk-OpenAPI-Datei, vergleicht sie mit der eingebetteten und liest die sevDesk-API-News (tech.sevdesk.com/api_news). Bei Änderungen öffnet er automatisch einen PR mit der neuen Spezifikation und einem Diff-Bericht (neue/entfernte Endpunkte, neue Schreibpfade, die in der Bestätigungs-Tabelle noch fehlen). Eine neue API-Version (z. B. `/api/v2`) oder Breaking Changes erzeugen zusätzlich ein Issue. Ändert sich das Format der News-Seite, schlägt der Lauf sichtbar fehl, statt still nichts zu melden.
- **Laufzeit-Check:** Der Server prüft beim Start (höchstens einmal pro Tag, gecacht), ob die Live-Spezifikation von der eingebetteten abweicht und ob es eine neuere npm-Version gibt, und meldet das als Hinweis im Ergebnis von `search`/`execute` („Neue sevDesk-API-Version erkannt – bitte `npx @erwins-enkel/sevdesk-mcp@latest` nutzen“). Der Hinweis erscheint einmal pro Sitzung, nicht in jedem Ergebnis. Die Abfrage der npm-Registry ist ein anonymer Abruf öffentlicher Paketdaten ohne Nutzerdaten; abschaltbar per `SEVDESK_MCP_NO_UPDATE_CHECK=1`. Schlägt der Check fehl, bleibt das still (nur stderr) (0002 Nr. 21).
- **Basis-URL und API-Version sind konfigurierbar** (Standard aktuell `https://my.sevdesk.de/api/v1`, nur HTTPS), damit ein Wechsel ohne Code-Umbau möglich ist.
- Release-Prozess: Spec-Update-PR → Tests (inkl. Klassifizierungs-Test) → Patch-Release auf npm (per Tag, siehe 9).

## 6. Sicherheit: Bestätigung für Unumkehrbares

**Grundregel:** Lesen und Entwürfe anlegen geht direkt. Alles Unumkehrbare braucht eine ausdrückliche Bestätigung.

**Bestätigungspflichtig** (Klassifizierung im Code als Tabelle, per Test abgesichert):
- jedes `DELETE`
- Versand: `…/sendViaEmail`, `…/sendBy` (Status „versendet“)
- Festschreiben/Buchen: `…/enshrine`, `…/bookAmount`, Storno (`…/cancelInvoice`), Statusänderungen auf Rechnungen. Eine Statusänderung erkennt der Server an einem `status`-Feld im Body von `PUT`/`POST` auf Invoice, Order, CreditNote oder Voucher (0002 Nr. 6).
- Rücksetzen (`resetToOpen`, `resetToDraft`)
- Exporte, die Dateien an Dritte übergeben (falls vorhanden; welche das sind, klärt die Klassifizierung anhand der Spezifikation)
- `…/getPdf` ohne `preventSendBy=true`, weil es den Versandstatus setzen kann (0002 Nr. 7)
- jeder Schreibpfad, den die Tabelle nicht kennt (fail closed, 0002 Nr. 6)

**Ablauf (zweistufig, 0002 Nr. 5):**
1. `execute` ohne `confirm`: Bestätigungspflichtige Aufrufe werden **nicht** ausgeführt, sondern **zurückgehalten**: Sie liefern den Platzhalter `{ held: true }`, und der Lauf geht weiter (Entwürfe davor und danach werden normal angelegt). Das Ergebnis enthält eine **Vorschau** aller zurückgehaltenen Aufrufe und ein **Bestätigungstoken**, das an genau diese Operationen (Profil, Methode, Pfad, Body-Hash) gebunden ist. Die Vorschau ist Englisch und strukturiert – Beträge als Zahl mit Währungscode, Daten nach ISO 8601, Empfänger, Betreff, Dokumentnummer, Profil und Firmenname, z. B. `Offer AN-1042 to max@firma.de, subject …, 3600.00 EUR net, profile manufare (manu·fare)`; das Modell formuliert sie für den Menschen in dessen Sprache (0002 Nr. 9).
2. Das Modell zeigt die Vorschau, holt das Ja des Menschen ein und ruft `execute` mit `confirm: "<token>"` (ohne `code`) erneut auf. Der Server führt genau die gespeicherten Aufrufe in Reihenfolge aus, **ohne den Code erneut auszuführen** (sonst entstünden Entwürfe doppelt und der Body-Hash passte nicht mehr). Beim ersten Fehler bricht er ab und meldet das Ergebnis pro Aufruf. Das Token gilt einmal und 10 Minuten, liegt nur im Speicher (nach einem Serverneustart: neu anfragen); ein unbekanntes, abgelaufenes oder fremdes Token wird abgelehnt.
3. Unterstützt der Client **MCP-Elicitation**, fragt der Server den Menschen im Bestätigungslauf zusätzlich direkt (stärker als die Zusage des Modells); Ablehnung oder Zeitüberschreitung bricht ab. Der Text ist für Menschen und daher lokalisiert (de/en). **Kommt in v1.x**, weil die Client-Unterstützung heute uneinheitlich ist; v1 verlässt sich auf das Token (0002 Nr. 8).

**Weitere Schalter:**
- `SEVDESK_READONLY=true` – nur `GET`, alles andere wird abgelehnt.
- Profilweise Einstellung `readonly: true`.
- Beide Schalter wirken als ODER; keiner hebt den anderen auf (0002 Nr. 3).
- Lokales Audit-Log aller schreibenden Aufrufe, Standard an, abschaltbar per `audit: false` in der Konfiguration. Eine JSONL-Datei pro Monat im Daten-/State-Verzeichnis, keine automatische Löschung. Inhalt: Zeit, Profil, Methode, Pfad, Query, Status, sevDesk-Objekt-ID, Body-Hash und Ausgang (`executed`, `held`, `confirmed`, `rejected`) – keine Request-Bodies (keine Kundendaten) und nie der Token (0002 Nr. 16).

## 7. Einrichtung und Mandanten

**Setup-Assistent:** `npx @erwins-enkel/sevdesk-mcp setup`
1. Fragt API-Token und Profilnamen (z. B. `manufare`; erlaubt sind `a–z`, `0–9` und `-`, 1 bis 32 Zeichen), prüft den Token sofort und zeigt Firmenname + Systemversion. Ein 1.0-Konto wird abgelehnt und nicht gespeichert. Fragt, ob das Profil read-only sein soll (Standard: nein).
2. Speichert den Token im **Schlüsselbund des Betriebssystems** (macOS Keychain, Windows Credential Manager, Linux Secret Service). Keine Klartextdatei. Gibt es keinen Schlüsselbund (headless Linux, WSL, Docker), bricht `setup` ab und erklärt, warum: Ein Token in einer Klartextdatei kann jeder Prozess und jedes Backup lesen, und er gibt vollen Zugriff auf die Buchhaltung. Für solche Umgebungen verweist es auf `SEVDESK_API_TOKEN` (0002 Nr. 4).
3. Erkennt installierte Clients (Claude Desktop, Claude Code, ChatGPT/Codex, OpenCode) und trägt den Server auf Wunsch ein – ohne Token, nur mit Profilnamen. Vor dem Schreiben legt es eine Sicherungskopie der Client-Konfiguration an, fragt pro Client nach und überschreibt einen bestehenden Eintrag nie stillschweigend. Der Eintrag heißt `sevdesk` (bzw. `sevdesk-<profil>`, wenn es mehrere gibt) und startet `npx -y @erwins-enkel/sevdesk-mcp --profile <name>` (0002 Nr. 18).
4. `setup --add` für weitere Profile, `setup --list`, `setup --remove` (löscht Profil und Token und bietet an, die Client-Einträge zu entfernen, die das Profil nutzen).
5. Ohne Terminal (kein TTY) bricht `setup` mit einem Hinweis auf `SEVDESK_API_TOKEN` ab; nicht-interaktive Flags gibt es nicht. Die Ausgabe ist reiner Text: Status nie nur über Farbe, `NO_COLOR` wird beachtet, keine reinen Spinner (0002 Nr. 19).

**Mandanten (0002 Nr. 1):** beliebig viele Profile. Der Server rät den Mandanten nie, und es gibt kein Standardprofil:
- `--profile manufare` legt einen Server-Eintrag auf ein Profil fest; `execute` lehnt jedes andere `account` ab, damit das Modell nicht selbst den Mandanten wechselt.
- Ohne Festlegung und mit genau einem Profil gilt dieses.
- Sind mehrere Profile erreichbar, ist `account` Pflicht. Ein Aufruf ohne `account` scheitert mit `account_required` und listet die Profilnamen mit ihren sevDesk-Firmennamen; ist der Mandant aus dem Gespräch nicht eindeutig, fragt das Modell den Menschen. Das Feld `account` führt die erreichbaren Profilnamen als Auswahl (Enum), mit den Firmennamen in der Beschreibung.
- Ohne jedes Profil startet der Server trotzdem: `search` funktioniert (liest nur die Spezifikation), `execute` antwortet mit einem Setup-Hinweis (0002 Nr. 12).

**Fallback:** `SEVDESK_API_TOKEN` (+ optional `SEVDESK_PROFILE`) für PyAgent, Docker, CI. Ist `SEVDESK_API_TOKEN` gesetzt, läuft der Server mit genau diesem einen Profil und liest den Schlüsselbund nicht; `SEVDESK_PROFILE` benennt dann nur dieses Profil (Audit-Log, PDF-Unterordner), Standardname `env` (0002 Nr. 2).
**Claude Desktop:** `.mcpb`-Paket mit Token-Feld (sensibel gespeichert).

## 8. Tests

- **Unit-Tests:** Sandbox-Grenzen, Bestätigungs-Klassifizierung (jeder Pfad der Spezifikation muss eingeordnet sein; neuer unklassifizierter Schreibpfad = Test rot), Token-Bindung.
- **Mock-Tests:** simulierte sevDesk-API aus der OpenAPI-Spezifikation.
- **E2E gegen das echte manu·fare-Konto** (von Kai freigegeben), nur Kontakte und Angebote, **keine Rechnungen** (Nummernlücken):
  - Läuft nur lokal und manuell (`bun run test:e2e`, Token aus `SEVDESK_E2E_TOKEN`), nie in der CI, weil das Repo öffentlich ist (0002 Nr. 29).
  - Jedes Testobjekt trägt Testkontakt „MCP Test GmbH“, Tag `mcp-test` und eine Lauf-ID im Kopftext. Testkontakt und Tag sind dauerhaft: einmal angelegt, nie gelöscht.
  - Aufräumen löscht **nur**, was im selben Lauf angelegt wurde **und** markiert ist **und** noch Entwurf ist. Fehlt eine Bedingung: Abbruch, nichts wird gelöscht.
  - Kein Versand an echte Empfänger; Mailversand nur an eine Kai-eigene Testadresse aus `SEVDESK_E2E_MAIL_TO`, die nie im Repo steht. Fehlt sie, wird der Mail-Test übersprungen. Ein per Mail versendetes Testangebot ist kein Entwurf mehr und bleibt nach der Regel oben stehen; der Lauf listet es am Ende zum manuellen Löschen auf.
- **Client-Smoke-Tests:** Priorität-A-Ablauf manuell in Claude Desktop und ChatGPT Desktop.

## 9. Roadmap

| Version | Inhalt |
|---|---|
| **v1** | `search` + `execute`, QuickJS-Sandbox, nur System 2.0, täglicher Spec-/Versions-Check, Bestätigungslogik, Setup-Assistent + Schlüsselbund, Profile, eingebettete Spezifikation + Hinweise, Tests, README, Veröffentlichung auf GitHub + npm, `.mcpb`, Eintrag in der offiziellen MCP Registry (`server.json`) |
| v1.x | Datei-Upload für Belege, OpenCode/PyAgent-Anleitungen, Elicitation |
| **v2** | `find_contact`, `get_document_pdf`, `create_offer` |
| später | evtl. Remote-Variante (HTTP) für ChatGPT Web / Teams; Video-Begleitmaterial |

**Veröffentlichung (0002 Nr. 24, 25):** npm-Version 0.1.0, sobald Priorität A durchgängig läuft; 1.0.0, wenn die v1-Zeile komplett ist, ab dann auch in der MCP Registry. Ein Tag von Kai löst eine GitHub Action aus, die per npm Trusted Publishing (OIDC, Provenance) veröffentlicht und das `.mcpb` an das GitHub-Release hängt. Ein gemergtes Spec-Update erscheint als Patch-Release.

## 10. Erfolgskriterien

- Priorität A (Kontakt finden/anlegen → Angebot → PDF → Mailversand mit Bestätigung) klappt in Claude Desktop und ChatGPT Desktop in **einem Gespräch, ohne manuelle Nacharbeit in sevDesk**.
- Tool-Beschreibungen < 1.500 Tokens.
- Kein unbestätigter Versand, keine unbestätigte Löschung – durch Tests belegt.
- Installation inkl. Token in **unter 3 Minuten** für neue Nutzer:innen.

## 11. Abgrenzung

- Kein Ersatz für Steuerberatung; der Server prüft keine steuerliche Richtigkeit.
- Keine offizielle sevDesk-Integration (Hinweis im README: „nicht von sevDesk entwickelt oder unterstützt“).
- Kein Webhosting, kein Versand von **Nutzerdaten** an Dritte außer an sevDesk selbst. Einzige weitere Verbindung ist der Update-Check (anonymer Abruf öffentlicher Paketdaten von npm, abschaltbar, siehe 5.6) (0002 Nr. 21).
- Keine Telemetrie, keine Absturzberichte. Das README sagt deutlich: Was `execute` zurückgibt, geht an den KI-Anbieter hinter dem Client; Ergebnisse daher gezielt filtern (0002 Nr. 22).

## 12. Offene Punkte

- npm-Organisation `erwins-enkel` auf npmjs.com anlegen (Kai, vor Veröffentlichung). – Bleibt ein manueller Schritt von Kai vor dem ersten Release.
- ~~Kai-eigene Testadresse für Mail-E2E festlegen.~~ – Geklärt: kommt aus `SEVDESK_E2E_MAIL_TO`, steht nie im Repo (0002 Nr. 29).
- Prüfen, welche Endpunkte in der offiziellen OpenAPI-Datei fehlen oder falsch beschrieben sind. – Aufgabe im Backlog (Patch-Datei, siehe 5.4), zusammen mit der Lizenzprüfung (0002 Nr. 23).
- ~~Ablageverzeichnis für PDFs bestätigen (Standard `~/Downloads/sevdesk/`).~~ – Bestätigt: `~/Downloads/sevdesk/<profil>/`, pro Profil einstellbar (0002 Nr. 14).

## 13. Texte und Sprache

- Texte für das Modell (Tool-Namen, Beschreibungen, Guides, Fehler, Vorschau) sind Englisch und knapp (Dialog-Entscheidung 3 unten; `docs/decisions/0001-foundation.md`).
- Texte für Menschen (CLI, Setup, Elicitation) gibt es auf Deutsch und Englisch. Deutsch: duzen, knapp, sachlich, geschlechtergerecht mit Doppelpunkt; Englisch ebenso knapp. Der umsetzende Agent pflegt beide Kataloge, Kai prüft das Deutsch im Review (0002 Nr. 27).
- README auf Englisch mit einem kurzen deutschen Abschnitt „Schnellstart“ (Installation und Sicherheit) (0002 Nr. 26).

## Entscheidungen aus dem Dialog (2026-11-09)

1. Umfang: alles, was die API kann; Priorität A = ausgehendes Angebot.
2. Bestätigungsmuster für Unumkehrbares, Read-only-Schalter.
3. v1 reiner Code Mode, v2 drei kuratierte Tools; alle Begriffe Englisch.
4. Kein Cloudflare Worker – nur das Prinzip, lokale QuickJS-Sandbox.
5. Open Source unter `erwins-enkel/sevdesk-mcp`, npm `@erwins-enkel/sevdesk-mcp`, MIT.
6. Mehrmandantenfähig; Token beim Setup abfragen, im Schlüsselbund speichern.
7. E2E-Tests im echten Konto mit abgesichertem Löschen; keine Rechnungen.
8. Angebotsversand: beides möglich, Standard sevDesk-Mail.
9. Nur sevDesk-System 2.0; täglicher automatischer Check auf neue API-Version/Spec-Änderungen (GitHub Action + Laufzeit-Hinweis).

## Entscheidungen aus dem Gap-Sweep (2026-11-09)

Die 29 Produktentscheidungen aus dem Abgleich PRD ↔ Gerüst (Phase P3, ohne Design-Export) stehen mit Frage, Antwort und Quelle in `docs/decisions/0002-product-decisions.md` und sind oben in die Abschnitte eingearbeitet. Die wichtigsten:

1. Bei mehreren Profilen ist `account` Pflicht; der Server rät den Mandanten nie, ein Standardprofil gibt es nicht.
2. Unumkehrbare Aufrufe werden zurückgehalten; die Bestätigung führt genau die gespeicherten Aufrufe aus, ohne den Code erneut auszuführen.
3. Unbekannte Schreibpfade und `getPdf` ohne `preventSendBy=true` sind bestätigungspflichtig (fail closed).
4. Elicitation kommt in v1.x; v1 verlässt sich auf das Bestätigungstoken.
5. Kein Klartext-Token, keine Telemetrie; Nutzerdaten gehen nur an sevDesk.
