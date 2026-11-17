# sevdesk-mcp: sevdesk mit KI für Claude, ChatGPT & Co.

**[Deutsch](#deutsch)** · **[English](#english)**

[![CI](https://github.com/erwins-enkel/sevdesk-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/erwins-enkel/sevdesk-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Deutsch

**sevdesk-mcp** ist ein kostenloser, quelloffener MCP-Server (Model Context Protocol), der
KI-Assistenten wie Claude, ChatGPT, Codex und OpenCode die komplette sevdesk-API zugänglich macht,
mit nur zwei Tools. Du sagst in normaler Sprache, was du brauchst: ein Angebot schreiben, offene
Rechnungen finden, Umsätze auswerten. Die KI erledigt es in deinem sevdesk-Konto. Der Server läuft
lokal auf deinem Rechner, und nichts Unumkehrbares passiert ohne dein Ja.

> **Beta:** sevdesk-mcp ist in früher Entwicklung (Version 0.x). Probier es zuerst mit einem
> Testkonto oder im [Nur-Lesen-Modus](docs/de/sicherheit.md#nur-lesen-modus) aus.
>
> Nicht von sevdesk entwickelt oder unterstützt.

### Was du damit machen kannst

- „Mach ein Angebot an die Muster GmbH über 3 Tage KI-Workshop à 1.200 € und schick es an Frau
  Beispiel.“ (Der Versand wartet auf dein Ja.)
- „Welche Rechnungen sind seit mehr als 30 Tagen überfällig, und bei wem?“
- „Wie viel Umsatz habe ich dieses Jahr mit jedem Kunden gemacht?“
- „Leg den Kontakt Muster GmbH mit Ansprechpartnerin Erika Beispiel und Adresse an.“
- „Speicher mir das PDF zu Rechnung RE-1042.“
- „Prüf das Angebot AN-1006 auf Tippfehler und interne Notizen.“
- „Mach aus Angebot AN-1007 einen Rechnungsentwurf.“

Alles, was die sevdesk-API kann, kann auch die KI: Kontakte, Angebote, Aufträge, Rechnungen,
Gutschriften, Belege, Artikel, Tags und Exporte.

### So funktioniert's: Code Mode

Viele MCP-Server bieten für jeden API-Endpunkt ein eigenes Tool an; bei den über 150 Operationen
der sevdesk-API füllen allein deren Beschreibungen den Kontext des Modells. sevdesk-mcp hat genau
zwei Tools: `search` durchsucht die eingebettete OpenAPI-Spezifikation von sevdesk und kuratierte
Anleitungen (Angebote, Steuerregeln, Datumsformate, Versand), und `execute` führt kleine
JavaScript-Schnipsel, die das Modell schreibt, in einer lokalen Sandbox gegen die sevdesk-API aus.
Zurück ins Gespräch kommt nur das Ergebnis. Das Muster heißt Code Mode (nach dem Vorbild von
Cloudflare und Anthropic).

|                                 | Ein Tool pro Endpunkt       | sevdesk-mcp (Code Mode)                         |
| ------------------------------- | --------------------------- | ----------------------------------------------- |
| Tools                           | eins pro Endpunkt           | zwei: `search` und `execute`                    |
| API-Abdeckung                   | was als Tool gebaut wurde   | die ganze sevdesk-API (über 150 Operationen)    |
| Tool-Beschreibungen im Kontext  | wachsen mit jedem Tool      | zusammen unter 1.500 Tokens, per Test gesichert |
| Aufgaben mit mehreren Schritten | ein Tool-Aufruf pro Schritt | viele API-Aufrufe in einem Lauf                 |
| API-Antworten                   | landen ganz im Kontext      | nur das Ergebnis, das der Code zurückgibt       |

### Sicherheit und Datenschutz

- **Token im Schlüsselbund:** Dein API-Token liegt im Schlüsselbund des Betriebssystems, nie im
  Klartext in einer Datei, und das Modell sieht ihn nie.
- **Nichts Unumkehrbares ohne dein Ja:** Löschen, Versenden, Festschreiben, Buchen, Stornieren und
  Statusänderungen hält der Server zurück; die KI zeigt dir eine Vorschau mit Nummer, Betrag und
  Empfänger:in. Erst nach deiner Bestätigung geht der Aufruf an sevdesk
  ([mehr](docs/de/sicherheit.md#unumkehrbare-aufrufe)).
- **Nur-Lesen-Modus:** pro Profil oder für alle; dann kann der Server in sevdesk nichts ändern
  ([mehr](docs/de/sicherheit.md#nur-lesen-modus)).
- **Audit-Log:** Jeder Schreibaufruf landet in einem lokalen Protokoll, ohne Kundendaten
  ([mehr](docs/de/sicherheit.md#audit-log)).
- **Lokal, ohne Telemetrie:** Der Server selbst schickt deine Daten nur an sevdesk. PDFs und
  Exporte landen in deinem Download-Ordner, nicht im Chat ([mehr](docs/de/dateien.md)).
- **Datenschutz:** Was `execute` zurückgibt, geht an deinen KI-Anbieter. Frag nach dem, was du
  brauchst, statt nach ganzen Datensätzen ([mehr](docs/de/sicherheit.md#datenschutz)).

### Schnellstart

Du brauchst ein sevdesk-Konto mit dem Buchhaltungssystem 2.0 und dessen API-Token (in sevdesk
unter Erweiterungen → API), [Node.js](https://nodejs.org) ≥ 22 und einen der KI-Clients unten.

```sh
npx @erwins-enkel/sevdesk-mcp setup
```

`setup` fragt nach Profilname und API-Token, legt den Token im Schlüsselbund ab und trägt den
Server in deine installierten KI-Clients ein. Auf die Frage nach dem Nur-Lesen-Modus antwortest du
für den Anfang am besten mit Ja. Danach startest du den Client neu und legst los. Details:
[Einrichtung und Profile](docs/de/einrichtung.md).

### Unterstützte KI-Clients

| Client                          | Einrichtung                                                     |
| ------------------------------- | --------------------------------------------------------------- |
| Claude Desktop                  | automatisch mit `setup`                                         |
| Claude Code                     | automatisch mit `setup`                                         |
| ChatGPT Desktop und Codex CLI   | automatisch mit `setup` (beide teilen sich eine Konfiguration)  |
| OpenCode                        | automatisch mit `setup` (OpenCode 2: Befehl von Hand eintragen) |
| jeder andere MCP-Client (stdio) | `setup` zeigt den Befehl, den du dort einträgst                 |

Mehr dazu unter [MCP-Clients](docs/de/einrichtung.md#mcp-clients).

### Häufige Fragen

#### Ist sevdesk-mcp ein offizielles Produkt von sevdesk?

Nein. sevdesk-mcp ist ein unabhängiges Open-Source-Projekt von
[erwins enkel](https://github.com/erwins-enkel) und wird nicht von sevdesk entwickelt oder
unterstützt. Es nutzt die öffentliche sevdesk-API.

#### Was kostet sevdesk-mcp?

Nichts: sevdesk-mcp steht unter der MIT-Lizenz. Du brauchst ein eigenes sevdesk-Konto und einen
KI-Client; deren Kosten bleiben, wie sie sind.

#### Welche sevdesk-Konten werden unterstützt?

Konten mit dem Buchhaltungssystem 2.0. Konten auf System 1.0 weist `setup` ab.

#### Kann die KI ohne mein Okay Rechnungen versenden oder löschen?

Nein. Jeder unumkehrbare Aufruf wartet auf deine Bestätigung, mit einer Vorschau, was genau
passiert. Im Nur-Lesen-Modus wird er sofort abgelehnt.

#### Welche Daten sieht mein KI-Anbieter?

Alles, was `execute` zurückgibt, wie bei jedem anderen Tool im Chat. Den API-Token sieht er nie,
und PDFs und Exporte bleiben auf deinem Rechner.

#### Kann ich mehrere sevdesk-Konten nutzen?

Ja. Jedes Konto ist ein Profil mit eigenem Token. Bei mehreren rät der Server nie, sondern lässt
sich sagen, welches gemeint ist.

#### Brauche ich Programmierkenntnisse?

Nein. Den Code schreibt die KI; du sagst in normaler Sprache, was du willst. Für die Installation
reicht ein Befehl im Terminal.

#### Ersetzt sevdesk-mcp meine Steuerberatung?

Nein. Der Server prüft nicht, ob etwas steuerlich richtig ist; er führt aus, was du freigibst.

### Dokumentation

- [Einrichtung und Profile](docs/de/einrichtung.md): `setup`, `config`, MCP-Clients, mehrere
  Konten
- [Konfiguration](docs/de/konfiguration.md): `config.json`, Limits, Download-Ordner
- [Sicherheit und Datenschutz](docs/de/sicherheit.md): Bestätigung, Nur-Lesen-Modus, Audit-Log
- [Dateien](docs/de/dateien.md): PDFs und Exporte
- [Beta-Test aus einem lokalen Checkout](docs/de/beta-test.md): neue Stände vor dem nächsten
  Release ausprobieren, Updates
- [Mitmachen](CONTRIBUTING.md) und die [sevdesk-API-Spezifikation](spec/README.md) (beide auf
  Englisch)

### Lizenz

[MIT](LICENSE). Ausgenommen ist die eingebettete sevdesk-API-Spezifikation in `spec/`: © sevdesk,
nicht von der MIT-Lizenz umfasst.

## English

**sevdesk-mcp** is a free, open-source MCP server (Model Context Protocol) that gives AI
assistants such as Claude, ChatGPT, Codex and OpenCode the complete sevdesk API, through just two
tools. You say in plain words what you need: write an offer, find unpaid invoices, analyse
revenue. The AI does it in your sevdesk account. The server runs locally on your computer, and
nothing irreversible happens without your yes.

> **Beta:** sevdesk-mcp is in early development (version 0.x). Try it with a test account or in
> [read-only mode](docs/en/safety.md#read-only-mode) first.
>
> Not developed or endorsed by sevdesk.

### What you can do with it

- "Make an offer to Muster GmbH for a 3-day AI workshop at €1,200 per day and send it to Ms
  Beispiel." (Sending waits for your yes.)
- "Which invoices are more than 30 days overdue, and who owes them?"
- "How much revenue did I make with each customer this year?"
- "Add the contact Muster GmbH with Erika Beispiel as contact person and the address."
- "Save the PDF of invoice RE-1042 for me."
- "Check offer AN-1006 for typos and internal notes."
- "Turn offer AN-1007 into an invoice draft."

Whatever the sevdesk API can do, the AI can do: contacts, offers, orders, invoices, credit notes,
vouchers, products, tags and exports.

### How it works: Code Mode

Many MCP servers offer one tool per API endpoint; with the over 150 operations of the sevdesk API,
their descriptions alone fill the model's context. sevdesk-mcp has exactly two tools: `search`
explores sevdesk's embedded OpenAPI specification and curated guides (offers, tax rules, date
formats, sending), and `execute` runs small JavaScript snippets the model writes in a local
sandbox against the sevdesk API. Only the result goes back into the conversation. The pattern is
called Code Mode (modelled on Cloudflare and Anthropic).

|                              | One tool per endpoint       | sevdesk-mcp (Code Mode)                        |
| ---------------------------- | --------------------------- | ---------------------------------------------- |
| Tools                        | one per endpoint            | two: `search` and `execute`                    |
| API coverage                 | what was built as a tool    | the whole sevdesk API (over 150 operations)    |
| Tool descriptions in context | grow with every tool        | under 1,500 tokens together, guarded by a test |
| Multi-step tasks             | one tool call per step      | many API calls in one run                      |
| API answers                  | land in the context in full | only the result the code returns               |

### Safety and privacy

- **Token in the keychain:** your API token lives in the OS keychain, never in plain text in a
  file, and the model never sees it.
- **Nothing irreversible without your yes:** the server holds deleting, sending, enshrining,
  booking, cancelling and status changes; the AI shows you a preview with number, amount and
  recipient. Only after your confirmation does the call go to sevdesk
  ([more](docs/en/safety.md#irreversible-calls)).
- **Read-only mode:** per profile or for all; then the server cannot change anything in sevdesk
  ([more](docs/en/safety.md#read-only-mode)).
- **Audit log:** every write call goes into a local log, without customer data
  ([more](docs/en/safety.md#audit-log)).
- **Local, no telemetry:** the server itself sends your data to sevdesk only. PDFs and exports
  land in your download folder, not in the chat ([more](docs/en/files.md)).
- **Privacy:** whatever `execute` returns goes to your AI provider. Ask for what you need rather
  than whole records ([more](docs/en/safety.md#privacy)).

### Quick start

You need a sevdesk account on bookkeeping system 2.0 and its API token (in sevdesk under
Erweiterungen → API, i.e. Extensions → API), [Node.js](https://nodejs.org) ≥ 22 and one of the
AI clients below.

```sh
npx @erwins-enkel/sevdesk-mcp setup
```

`setup` asks for a profile name and the API token, stores the token in the OS keychain and
registers the server in your installed AI clients. To start with, answer yes when it asks about
read-only mode. Then restart the client and go. Details: [setup and profiles](docs/en/setup.md).

### Supported AI clients

| Client                        | Setup                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| Claude Desktop                | automatic with `setup`                                       |
| Claude Code                   | automatic with `setup`                                       |
| ChatGPT Desktop and Codex CLI | automatic with `setup` (both share one config)               |
| OpenCode                      | automatic with `setup` (OpenCode 2: add the command by hand) |
| any other MCP client (stdio)  | `setup` prints the command to add there                      |

More under [MCP clients](docs/en/setup.md#mcp-clients).

### Frequently asked questions

#### Is sevdesk-mcp an official sevdesk product?

No. sevdesk-mcp is an independent open-source project by
[erwins enkel](https://github.com/erwins-enkel), not developed or endorsed by sevdesk. It uses
the public sevdesk API.

#### What does sevdesk-mcp cost?

Nothing: sevdesk-mcp is MIT-licensed. You need your own sevdesk account and an AI client; their
costs stay as they are.

#### Which sevdesk accounts are supported?

Accounts on bookkeeping system 2.0. `setup` refuses accounts on system 1.0.

#### Can the AI send or delete invoices without my OK?

No. Every irreversible call waits for your confirmation, with a preview of exactly what will
happen. In read-only mode it is rejected outright.

#### What does my AI provider see?

Whatever `execute` returns, as with any other tool in the chat. It never sees the API token, and
PDFs and exports stay on your computer.

#### Can I use several sevdesk accounts?

Yes. Each account is a profile with its own token. With several, the server never guesses but
asks which one is meant.

#### Do I need to know how to program?

No. The AI writes the code; you say in plain words what you want. Installing takes one command
in a terminal.

#### Does sevdesk-mcp replace my tax advisor?

No. The server does not check whether something is right for tax purposes; it carries out what
you approve.

### Documentation

- [Setup and profiles](docs/en/setup.md): `setup`, `config`, MCP clients, several accounts
- [Configuration](docs/en/configuration.md): `config.json`, limits, download folder
- [Safety and privacy](docs/en/safety.md): confirmation, read-only mode, audit log
- [Files](docs/en/files.md): PDFs and exports
- [Beta testing from a local checkout](docs/en/local-checkout.md): trying changes before the next
  release, updates
- [Contributing](CONTRIBUTING.md) and the [sevdesk API specification](spec/README.md)

### License

[MIT](LICENSE), except the embedded sevdesk API specification in `spec/`: © sevdesk, not covered
by the MIT licence.
