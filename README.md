# Minecraft Server Manager

Electron-Desktop-App zur Remote-Verwaltung mehrerer Minecraft-Server per SSH.

## ✨ Hauptfunktionen

🔧 Masterserver erstellen
- Organisiere und steuere mehrere Minecraft-Server über eine zentrale Instanz.

🚀 Remote-Server erstellen und starten
- Vollautomatisierte Einrichtung und Verwaltung von Minecraft-Instanzen über SSH auf externen Servern.

📂 Dateizugriff via SSH/FTP
- Vollständiger Zugriff auf Serverdateien direkt über den Manager – ohne manuelle Verbindung über Terminal oder FileZilla.

🔄 Automatische Serververwaltung
- Starten, stoppen, neustarten oder überwachen – alles bequem per Webinterface.

🎮 Einfache Verwaltung einzelner Server
- Behalte jederzeit die Kontrolle über Konfigurationen, Backups und Serverstatus.

## 🛠️ Für wen ist das gedacht?

- Server-Admins, die mehrere Minecraft-Instanzen hosten
- Community-Leiter mit eigener Infrastruktur
- Entwickler, die Server schnell aufsetzen und verwalten wollen

## 🚀 Setup

Voraussetzungen: [Node.js](https://nodejs.org/) (LTS) und npm.

```bash
npm install
npm start
```

Baut ein Windows-Installer-Paket (NSIS) nach `dist/`:

```bash
npm run build
```

## 🧩 Server-Software (Jars)

Die App verwaltet Server-Jars (Paper, Spigot, BungeeCord, …) lokal unter
dem Anwendungsdatenordner (`%APPDATA%/Minecraft Server Manager/jars`).
Beim ersten Start werden eventuell im lokalen `jars/`-Ordner vorhandene
`.jar`-Dateien einmalig dorthin übernommen; darüber hinaus lassen sich
weitere Jars direkt über "Server Software hinzufügen" in der App hochladen.

**Hinweis:** Server-Jars von Drittanbietern (Paper, Spigot, BungeeCord, …)
unterliegen eigenen Lizenzbedingungen. Sie werden bewusst nicht im
Git-Repository versioniert (siehe `.gitignore`) – bitte die jeweiligen
Lizenzen der Projekte prüfen, bevor Jars weitergegeben werden.

## 🔐 Zugangsdaten

Server- und Masterserver-Zugangsdaten (SSH-Passwörter) werden lokal unter
`%APPDATA%/Minecraft Server Manager/data/*.json` gespeichert. Passwörter
werden dabei über Electrons `safeStorage`-API (unter Windows: DPAPI,
an den aktuellen Windows-Benutzer gebunden) verschlüsselt abgelegt.

Diese Dateien enthalten sensible Daten und dürfen **niemals** versioniert
oder geteilt werden.

## 🏗️ Architektur

- `main.js` – App-Bootstrap (Fenster, globale Shortcuts).
- `preload.js` – Context-Bridge-API für den Renderer.
- `lib/store.js` – Persistenz von Server-/Masterserver-Listen inkl.
  Passwortverschlüsselung.
- `lib/ssh-service.js` – SSH/SFTP-Hilfsfunktionen.
- `lib/validate.js` – Eingabevalidierung & sicheres Shell-Quoting.
- `lib/ipc-handlers.js` – IPC-Handler, die Renderer-Aktionen auf die
  obigen Module abbilden.
- `renderer/` – UI (HTML/JS, Tailwind via CDN).

## ⚠️ Sicherheitshinweise

- Remote-Server werden aktuell als `root` unter `/root/<servername>`
  betrieben. Für produktive Umgebungen wird empfohlen, stattdessen einen
  dedizierten, unprivilegierten Systembenutzer zu verwenden.
- SSH-Zugangsdaten werden bei jeder Aktion (Start/Stopp/Log/Befehl) erneut
  über die App an den Zielserver übertragen. Es findet aktuell kein
  Verbindungs-Pooling statt.
