# Dateien: PDFs und Exporte

**Deutsch** · [English](../en/files.md) · [Übersicht](../../README.md#deutsch)

PDFs und Exporte gehen nie durch den Kontext des Assistenten: Der Server speichert sie im
Download-Ordner des Profils und gibt nur den Pfad zurück. Dieser Ordner ist
`~/Downloads/sevdesk/<profil>/`, außer das Profil setzt [`downloadDir`](konfiguration.md); das
Profil von `SEVDESK_API_TOKEN` heißt wie `SEVDESK_PROFILE` (Standard `env`).

- `sevdesk.savePdf(type, id)` speichert das PDF eines Auftrags (Angebots), einer Rechnung oder
  einer Gutschrift als `<Dokumentnummer>.pdf`, ohne Nummer als `<Type>-<id>.pdf`, und ersetzt eine
  ältere Kopie mit demselben Namen. Es bittet sevdesk immer, das Dokument nicht als versendet zu
  markieren (`preventSendBy=true`). sevdesk behält das zuletzt gerenderte PDF, deshalb rendert
  `savePdf` einen Entwurf zuerst neu (`POST /{Type}/{id}/render` mit `forceReload`, steht in
  `writes` und im [Audit-Log](sicherheit.md#audit-log)): Sein PDF zeigt den Entwurf immer so, wie
  er jetzt ist. Das kostet 3 Aufrufe. Jedes andere Dokument bekommt das PDF, das sevdesk
  gespeichert hat, also das versendete, in 2 Aufrufen. Es gibt Pfad und Dateiname zurück, dazu
  vom PDF `bytes`, `sha256`, `pdfCreated` (sein `/CreationDate`) und `documentUpdated` (das
  `update` des Dokuments), beides in UTC.
- Ein `getPdf` eines Auftrags, einer Rechnung oder einer Gutschrift über `sevdesk.request` (mit
  `preventSendBy=true`) wird als neue Datei gespeichert, benannt nach dem Pfad, z. B.
  `Order-7-getPdf.pdf`, egal ob sevdesk JSON antwortet oder, mit `download=true`, das PDF selbst.
  Es liest zuerst das Dokument (2 Aufrufe) und gibt dieselben Felder zurück. Änderungen über die
  API aktualisieren das von sevdesk gespeicherte PDF nicht, und dieser Aufruf liefert genau dieses
  gespeicherte PDF; nur `savePdf` rendert einen Entwurf neu.
- Ist das PDF eines Entwurfs älter als dessen letzte Änderung, ergänzt das Ergebnis `stale: true`
  und einen Hinweis, und die `notes` im Ergebnis von `execute` nennen die Datei. Gespeichert wird
  sie trotzdem. Dokumente, die keine Entwürfe sind, werden nie markiert: Eine Statusänderung wie
  das Versenden verschiebt `update` ebenfalls.
- Jede andere Antwort, die kein JSON ist, etwa ein CSV-Export, wird als neue Datei gespeichert,
  benannt nach dem Anfragepfad, z. B. `Export-datevCSV.csv`. Eine vorhandene Datei bleibt; die neue
  bekommt `-2`, `-3`, … angehängt.
