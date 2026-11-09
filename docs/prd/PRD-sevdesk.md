# PRD: sevdesk-mcp (Code Mode)

**Stand:** 2026-11-09 · Entwurf v0.1 · Autor: Kai Osthoff (erwins enkel / manu·fare), erarbeitet mit Claude
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
4. Versand: **Standard per sevDesk-Mail** (`sendViaEmail`, Absender/Vorlage aus sevDesk); alternativ **nur PDF** (Kai verschickt selbst, z. B. Outlook oder Post über das manu·fare-Portal). Wahl pro Angebot. Versand ist bestätigungspflichtig (siehe 6).

**Weitere (alles, was die API kann), z. B.:**
- Auswerten: offene Rechnungen, Umsatz je Kunde/Zeitraum, überfällige Posten.
- Rechnungen: aus Angebot erzeugen, anlegen, PDF, versenden, festschreiben, stornieren.
- Belege: Eingangsbeleg anlegen (inkl. Datei-Upload), buchen, Bankumsätze zuordnen.
- Stammdaten: Kontakte, Artikel, Tags; Exporte (z. B. DATEV).

## 5. Architektur

### 5.1 Tools (v1: reiner Code Mode)

**`search`** – Eingabe: `code` (JS). Der Code läuft gegen ein `spec`-Objekt (sevDesk-OpenAPI, `$ref`s aufgelöst) und ein `guides`-Objekt (kuratierte Hinweise, siehe 5.4). Die Spezifikation selbst gelangt nie in den Kontext, nur das, was der Code zurückgibt.

```js
// Beispiel
return Object.entries(spec.paths)
  .filter(([p]) => p.startsWith('/Order'))
  .map(([p, ops]) => ({ path: p, methods: Object.keys(ops) }));
```

**`execute`** – Eingaben: `code` (JS), optional `account` (Profilname), optional `confirm` (Bestätigungstoken, siehe 6). Im Sandbox-Scope steht ein authentifizierter Client bereit:

```js
const c = await sevdesk.request('GET', '/Contact', { query: { name: 'Schlecht', depth: 1 } });
const id = c.objects[0].id;
const order = await sevdesk.request('POST', '/Order/Factory/saveOrder', { body: { /* … */ } });
const file = await sevdesk.savePdf('Order', order.order.id); // legt PDF lokal ab, gibt Pfad zurück
return { orderId: order.order.id, pdf: file };
```

Hilfsfunktionen im Scope (bewusst wenige):
- `sevdesk.request(method, path, { query, body })` – einziger Weg nach außen.
- `sevdesk.paginate(path, query)` – sammelt `limit`/`offset`-Seiten.
- `sevdesk.savePdf(type, id)` – holt `/…/{id}/getPdf`, schreibt in das konfigurierte Ablageverzeichnis (Standard `~/Downloads/sevdesk/`), gibt Pfad + Dateiname zurück. Binärdaten gehen nie in den Kontext.
- `sevdesk.upload(path)` – lädt eine lokale Datei aus einem freigegebenen Ordner als Beleg-Anhang hoch (v1.x).
- `console.log` – wird mit dem Ergebnis zurückgegeben.

Beide Tools tragen MCP-Annotations (`search`: readOnly; `execute`: destructive), damit Clients passend nachfragen. Gesamtumfang der Tool-Beschreibungen: **Ziel < 1.500 Tokens**.

### 5.2 v2: kuratierte Tools

Für zuverlässige Nutzung auch mit kleineren/lokalen Modellen, intern auf demselben Client aufgebaut:

- **`find_contact`** – Suche nach Name/Kundennummer/E-Mail, liefert kompakte Treffer inkl. Adresse und Ansprechpartner.
- **`create_offer`** – Kontakt (ID oder Daten zum Anlegen), Positionen (Text, Menge, Einheit, Preis, Steuersatz), Kopf-/Fußtext, `delivery: "email" | "pdf"` (Standard `email`). Legt Entwurf an, liefert PDF + Vorschau; Versand erst mit `confirm`.
- **`get_document_pdf`** – PDF zu Angebot, Rechnung, Gutschrift oder Beleg lokal ablegen.

### 5.3 Sandbox

- **QuickJS als WebAssembly** (`quickjs-emscripten`) im Node-Prozess. Kein Cloudflare-Konto, kein Worker, keine Cloud.
- Kein Dateisystem, keine Umgebungsvariablen, kein `fetch`/Netz – nur die oben genannten Host-Funktionen. Der API-Token verlässt den Host-Prozess nie.
- Limits (konfigurierbar): 30 s Laufzeit, 64 MB Speicher, max. 50 API-Aufrufe pro `execute`, Ergebnis max. ~20 KB (darüber gekürzt mit Hinweis, gezielter zu filtern).
- Fehler aus der API (Status, sevDesk-Fehlermeldung, Pfad) werden strukturiert an das Modell zurückgegeben, damit es sich selbst korrigieren kann.
- Automatisches Retry mit Backoff bei 429/5xx.

### 5.4 OpenAPI-Spezifikation und Hinweise

- Die sevDesk-OpenAPI-Datei wird **zur Build-Zeit eingebettet** (Versionsstand im README), mit Skript `npm run update-spec` zum Aktualisieren.
- Eine Patch-Datei korrigiert bekannte Fehler der offiziellen Spezifikation.
- **`guides`**: kurze, kuratierte Rezepte, die `search` mit durchsucht, z. B. „Angebot anlegen (saveOrder, Pflichtfelder, orderType AN)“, „Steuerregeln nach Update 2.0 (`taxRule`)“, „Rechnung aus Angebot“, „Beleg mit Datei“, „Paginierung“. Sie machen den Unterschied zwischen „Modell rät“ und „Modell trifft beim ersten Versuch“.
- **Nur sevDesk-System 2.0:** Der Server unterstützt ausschließlich Konten mit Buchhaltungssystem 2.0 (Steuerregeln über `taxRule`). Beim Start und im Setup wird per `/Tools/bookkeepingSystemVersion` geprüft; ein 1.0-Konto bekommt eine klare Fehlermeldung statt halb funktionierender Aufrufe. Guides und Beispiele kennen nur die 2.0-Logik.

### 5.6 Nie veralten: Versions- und Änderungs-Check

- **Täglicher GitHub-Action-Lauf** im Repo: lädt die aktuelle sevDesk-OpenAPI-Datei, vergleicht sie mit der eingebetteten und liest die sevDesk-API-News (tech.sevdesk.com/api_news). Bei Änderungen öffnet er automatisch einen PR mit der neuen Spezifikation und einem Diff-Bericht (neue/entfernte Endpunkte, neue Schreibpfade, die in der Bestätigungs-Tabelle noch fehlen). Eine neue API-Version (z. B. `/api/v2`) oder Breaking Changes erzeugen zusätzlich ein Issue.
- **Laufzeit-Check:** Der Server prüft beim Start (höchstens einmal pro Tag, gecacht), ob die Live-Spezifikation von der eingebetteten abweicht und ob es eine neuere npm-Version gibt, und meldet das als Hinweis im Ergebnis von `search`/`execute` („Neue sevDesk-API-Version erkannt – bitte `npx @erwins-enkel/sevdesk-mcp@latest` nutzen“).
- **Basis-URL und API-Version sind konfigurierbar** (Standard aktuell `https://my.sevdesk.de/api/v1`), damit ein Wechsel ohne Code-Umbau möglich ist.
- Release-Prozess: Spec-Update-PR → Tests (inkl. Klassifizierungs-Test) → Patch-Release auf npm.

### 5.5 Technik

TypeScript, Node ≥ 20, offizielles `@modelcontextprotocol/sdk`, Start per `npx -y @erwins-enkel/sevdesk-mcp`. Keine Datenbank, kein Server-Zustand außer Profilen.

## 6. Sicherheit: Bestätigung für Unumkehrbares

**Grundregel:** Lesen und Entwürfe anlegen geht direkt. Alles Unumkehrbare braucht eine ausdrückliche Bestätigung.

**Bestätigungspflichtig** (Klassifizierung im Code als Tabelle, per Test abgesichert):
- jedes `DELETE`
- Versand: `…/sendViaEmail`, `…/sendBy` (Status „versendet“)
- Festschreiben/Buchen: `…/enshrine`, `…/bookAmount`, Storno (`…/cancelInvoice`), Statusänderungen auf Rechnungen
- Rücksetzen (`resetToOpen`, `resetToDraft`)
- Exporte, die Dateien an Dritte übergeben (falls vorhanden)

**Ablauf (zweistufig):**
1. `execute` ohne `confirm`: Bestätigungspflichtige Aufrufe werden **nicht** ausgeführt. Der Lauf endet mit einer **Vorschau** (z. B. „Angebot AN-1042 an max@firma.de, Betreff …, 3.600,00 € netto“) und einem **Bestätigungstoken**, das an genau diese Operationen (Methode, Pfad, Body-Hash) gebunden ist.
2. Das Modell zeigt die Vorschau, holt das Ja des Menschen ein und ruft `execute` mit `confirm: "<token>"` erneut auf. Weicht die Operation ab, wird abgelehnt.
3. Unterstützt der Client **MCP-Elicitation**, fragt der Server den Menschen zusätzlich direkt (stärker als die Zusage des Modells).

**Weitere Schalter:**
- `SEVDESK_READONLY=true` – nur `GET`, alles andere wird abgelehnt.
- Profilweise Einstellung `readonly: true`.
- Lokales Audit-Log (JSONL, ohne Token) aller schreibenden Aufrufe, Standard an.

## 7. Einrichtung und Mandanten

**Setup-Assistent:** `npx @erwins-enkel/sevdesk-mcp setup`
1. Fragt API-Token und Profilnamen (z. B. `manufare`), prüft den Token sofort und zeigt Firmenname + Systemversion.
2. Speichert den Token im **Schlüsselbund des Betriebssystems** (macOS Keychain, Windows Credential Manager, Linux Secret Service). Keine Klartextdatei.
3. Erkennt installierte Clients (Claude Desktop, Claude Code, ChatGPT/Codex, OpenCode) und trägt den Server auf Wunsch ein – ohne Token, nur mit Profilnamen.
4. `setup --add` für weitere Profile, `setup --list`, `setup --remove`.

**Mandanten:** beliebig viele Profile; `execute` wählt per `account`, sonst gilt das Standardprofil. Alternativ ein Server-Eintrag pro Profil (`--profile manufare`).
**Fallback:** `SEVDESK_API_TOKEN` (+ optional `SEVDESK_PROFILE`) für PyAgent, Docker, CI.
**Claude Desktop:** `.mcpb`-Paket mit Token-Feld (sensibel gespeichert).

## 8. Tests

- **Unit-Tests:** Sandbox-Grenzen, Bestätigungs-Klassifizierung (jeder Pfad der Spezifikation muss eingeordnet sein; neuer unklassifizierter Schreibpfad = Test rot), Token-Bindung.
- **Mock-Tests:** simulierte sevDesk-API aus der OpenAPI-Spezifikation.
- **E2E gegen das echte manu·fare-Konto** (von Kai freigegeben), nur Kontakte und Angebote, **keine Rechnungen** (Nummernlücken):
  - Jedes Testobjekt trägt Testkontakt „MCP Test GmbH“, Tag `mcp-test` und eine Lauf-ID im Kopftext.
  - Aufräumen löscht **nur**, was im selben Lauf angelegt wurde **und** markiert ist **und** noch Entwurf ist. Fehlt eine Bedingung: Abbruch, nichts wird gelöscht.
  - Kein Versand an echte Empfänger; Mailversand nur an eine Kai-eigene Testadresse.
- **Client-Smoke-Tests:** Priorität-A-Ablauf manuell in Claude Desktop und ChatGPT Desktop.

## 9. Roadmap

| Version | Inhalt |
|---|---|
| **v1** | `search` + `execute`, QuickJS-Sandbox, nur System 2.0, täglicher Spec-/Versions-Check, Bestätigungslogik, Setup-Assistent + Schlüsselbund, Profile, eingebettete Spezifikation + Hinweise, Tests, README, Veröffentlichung auf GitHub + npm, `.mcpb` |
| v1.x | Datei-Upload für Belege, OpenCode/PyAgent-Anleitungen, Elicitation |
| **v2** | `find_contact`, `get_document_pdf`, `create_offer` |
| später | evtl. Remote-Variante (HTTP) für ChatGPT Web / Teams; Video-Begleitmaterial |

## 10. Erfolgskriterien

- Priorität A (Kontakt finden/anlegen → Angebot → PDF → Mailversand mit Bestätigung) klappt in Claude Desktop und ChatGPT Desktop in **einem Gespräch, ohne manuelle Nacharbeit in sevDesk**.
- Tool-Beschreibungen < 1.500 Tokens.
- Kein unbestätigter Versand, keine unbestätigte Löschung – durch Tests belegt.
- Installation inkl. Token in **unter 3 Minuten** für neue Nutzer:innen.

## 11. Abgrenzung

- Kein Ersatz für Steuerberatung; der Server prüft keine steuerliche Richtigkeit.
- Keine offizielle sevDesk-Integration (Hinweis im README: „nicht von sevDesk entwickelt oder unterstützt“).
- Kein Webhosting, kein Datenversand an Dritte außer an sevDesk selbst.

## 12. Offene Punkte

- npm-Organisation `erwins-enkel` auf npmjs.com anlegen (Kai, vor Veröffentlichung).
- Kai-eigene Testadresse für Mail-E2E festlegen.
- Prüfen, welche Endpunkte in der offiziellen OpenAPI-Datei fehlen oder falsch beschrieben sind.
- Ablageverzeichnis für PDFs bestätigen (Standard `~/Downloads/sevdesk/`).

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
