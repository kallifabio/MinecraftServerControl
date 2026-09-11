const { app, ipcMain, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const store = require('./store');
const ssh = require('./ssh-service');
const knownHosts = require('./known-hosts');
const {
    assertValidServerName,
    assertValidPort,
    assertValidRam,
    assertValidJarFileName,
    sanitizeFileName,
    sanitizeRelativePath,
    shQuote
} = require('./validate');

const MAX_BACKUPS_PER_SERVER = 10;
// "cat" auf sehr große Logdateien kann viel Speicher/Zeit kosten - auf die
// letzten N Zeilen begrenzen, analog zu einem klassischen "tail".
const LOG_TAIL_LINES = 1000;

function remoteDirFor(name) {
    return `/root/${name}`;
}

function backupsDirFor(name) {
    return `${remoteDirFor(name)}/backups`;
}

// Löst die Verbindungsdaten eines Servers über seinen referenzierten
// Masterserver auf, statt (wie früher) eine beim Erstellen kopierte Kopie
// von IP/Username/Passwort im Server-Eintrag selbst zu vertrauen. Dadurch
// bleiben Server-Einträge auch nach einer Passwortänderung des Masterservers
// funktionsfähig, und ein manipulierter Renderer kann keine abweichenden
// Zugangsdaten unterschieben.
async function resolveServerConnection(serverEntry) {
    if (serverEntry.masterServerId) {
        const masterServers = await store.loadMasterServers();
        const master = masterServers.find(ms => ms.id === serverEntry.masterServerId);
        if (!master) {
            throw new Error(`Zugehöriger Masterserver für "${serverEntry.name}" wurde nicht gefunden (evtl. gelöscht).`);
        }
        return { host: master.ip, port: master.sshPort, username: master.username, password: master.password };
    }
    // Legacy-Fallback für Server-Einträge aus einer älteren Version, die
    // Zugangsdaten noch direkt gespeichert hatten.
    if (serverEntry.ip && serverEntry.username) {
        return { host: serverEntry.ip, port: serverEntry.sshPort, username: serverEntry.username, password: serverEntry.password };
    }
    throw new Error(`Keine Verbindungsdaten für Server "${serverEntry.name}" gefunden.`);
}

// Liefert eine wiederverwendbare, gepoolte SSH-Verbindung für kurze Aktionen
// (Start/Stopp/Dateiliste/Befehl/…). Nicht für langlebige Streams verwenden.
function connectToServer(serverEntry) {
    return resolveServerConnection(serverEntry).then(cfg => ssh.getPooledConnection(cfg, { dataDir: store.dataDir }));
}

async function getRemoteTotalMemMb(conn) {
    try {
        const output = await ssh.execCommand(conn, 'free -m');
        const match = output.match(/^Mem:\s+(\d+)/m);
        return match ? parseInt(match[1], 10) : null;
    } catch {
        return null;
    }
}

// Parst die Ausgabe von "ls -p -l" in strukturierte Einträge.
function parseLsLongOutput(output) {
    return output
        .split('\n')
        .filter(line => line && !line.startsWith('total'))
        .map(line => {
            const match = line.match(/^([^ ]+) +[^ ]+ +[^ ]+ +[^ ]+ +([0-9]+) +[^ ]+ +[^ ]+ +[^ ]+ +(.+)$/);
            if (!match) return null;
            const [, perms, sizeStr, fileName] = match;
            const isDir = perms.startsWith('d');
            // "ls -p" hängt Verzeichnisnamen ein "/" an - für die Anzeige/Navigation entfernen.
            const name = isDir && fileName.endsWith('/') ? fileName.slice(0, -1) : fileName;
            return { name, sizeBytes: parseInt(sizeStr, 10), isDir };
        })
        .filter(Boolean);
}

function buildServerProperties({ name, serverPort }) {
    return [
        '#Minecraft server properties',
        'accepts-transfers=false',
        'allow-flight=false',
        'allow-nether=true',
        'broadcast-console-to-ops=true',
        'broadcast-rcon-to-ops=true',
        'debug=false',
        'difficulty=easy',
        'enable-command-block=false',
        'enable-jmx-monitoring=false',
        'enable-query=false',
        'enable-rcon=false',
        'enable-status=true',
        'enforce-secure-profile=true',
        'enforce-whitelist=false',
        'entity-broadcast-range-percentage=100',
        'force-gamemode=false',
        'function-permission-level=2',
        'gamemode=survival',
        'generate-structures=true',
        'generator-settings={}',
        'hardcore=false',
        'hide-online-players=false',
        'initial-enabled-packs=vanilla',
        'level-name=world',
        'level-type=minecraft\\:normal',
        'log-ips=true',
        'max-chained-neighbor-updates=1000000',
        'max-players=20',
        'max-tick-time=60000',
        'max-world-size=29999984',
        `motd=A ${name} Minecraft Server`,
        'network-compression-threshold=256',
        'online-mode=true',
        'op-permission-level=4',
        'player-idle-timeout=0',
        'prevent-proxy-connections=false',
        'pvp=true',
        'query.port=25565',
        'rate-limit=0',
        'rcon.port=25575',
        'region-file-compression=deflate',
        'require-resource-pack=false',
        `server-port=${serverPort}`,
        'simulation-distance=10',
        'spawn-animals=true',
        'spawn-monsters=true',
        'spawn-npcs=true',
        'spawn-protection=16',
        'sync-chunk-writes=true',
        'use-native-transport=true',
        'view-distance=10',
        'white-list=false',
        ''
    ].join('\n');
}

function buildStartScript({ remoteDir, ramMb }) {
    return [
        '#!/bin/bash',
        `cd "${remoteDir}"`,
        `java -Xms${ramMb}M -Xmx${ramMb}M -jar server.jar nogui`,
        ''
    ].join('\n');
}

// Patcht nur die server-port-Zeile in einer bestehenden server.properties,
// statt die ganze Datei neu zu schreiben - sonst gingen alle anderen, ggf.
// von Minecraft selbst oder manuell gesetzten Properties verloren.
async function patchServerPort(conn, remoteDir, serverPort) {
    const propsFile = `${remoteDir}/server.properties`;
    const cmd =
        `if grep -q '^server-port=' ${shQuote(propsFile)}; then ` +
        `sed -i 's/^server-port=.*/server-port=${serverPort}/' ${shQuote(propsFile)}; ` +
        `else echo 'server-port=${serverPort}' >> ${shQuote(propsFile)}; fi`;
    await ssh.execCommand(conn, cmd);
}

// Löscht überzählige Backups (älteste zuerst), damit backups/ auf dem
// Zielserver nicht unbegrenzt wächst. Gibt die Namen der gelöschten
// Backups zurück.
async function pruneOldBackups(conn, name) {
    const dir = backupsDirFor(name);
    const list = await ssh.execCommand(conn, `ls -p -l ${shQuote(dir)} 2>/dev/null || true`);
    const backups = parseLsLongOutput(list).filter(e => !e.isDir).map(e => e.name).sort();
    const excess = backups.length - MAX_BACKUPS_PER_SERVER;
    if (excess <= 0) return [];

    const toDelete = backups.slice(0, excess);
    for (const file of toDelete) {
        await ssh.execCommand(conn, `rm -f ${shQuote(`${dir}/${file}`)}`).catch(() => {});
    }
    return toDelete;
}

// event.sender.id -> { conn, stream }, damit ein laufender Log-Stream später
// tatsächlich beendet werden kann (statt des vorherigen No-Op-Handlers).
const activeLogStreams = new Map();

function registerIpcHandlers() {
    ipcMain.handle('listJarFiles', async () => {
        try {
            const files = await fsp.readdir(store.jarsDir);
            const jarFiles = files.filter(f => f.endsWith('.jar'));
            return { success: true, jars: jarFiles };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('upload-server-software', async (event, name, data) => {
        try {
            const safeName = assertValidJarFileName(name);
            const targetPath = path.join(store.jarsDir, safeName);
            await fsp.writeFile(targetPath, data);
            return { success: true };
        } catch (err) {
            console.error('Fehler beim Speichern der Server-Datei:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('create-server', async (event, serverData) => {
        try {
            const name = assertValidServerName(serverData.name);
            const serverPort = assertValidPort(serverData.serverPort, 'Server-Port');
            const ramMb = assertValidRam(serverData.ramMb);
            const jarFileName = assertValidJarFileName(serverData.software);
            const masterServerId = String(serverData.masterServerId || '');

            const masterServers = await store.loadMasterServers();
            const master = masterServers.find(ms => ms.id === masterServerId);
            if (!master) {
                return { success: false, message: 'Bitte einen gültigen Masterserver auswählen.' };
            }

            const existing = store.loadServers();
            if (existing.some(s => s.name === name && s.masterServerId === masterServerId)) {
                return { success: false, message: `Server "${name}" existiert auf diesem Masterserver bereits.` };
            }

            const localJarPath = path.join(store.jarsDir, jarFileName);
            if (!fs.existsSync(localJarPath)) {
                return { success: false, message: `Lokale Datei ${jarFileName} nicht gefunden.` };
            }

            const remoteDir = remoteDirFor(name);
            const remoteJarPath = `${remoteDir}/server.jar`;

            const conn = await ssh.getPooledConnection(
                { host: master.ip, port: master.sshPort, username: master.username, password: master.password },
                { dataDir: store.dataDir }
            );

            const totalMemMb = await getRemoteTotalMemMb(conn);
            if (totalMemMb !== null && ramMb > totalMemMb - 256) {
                return {
                    success: false,
                    message: `Angeforderter RAM (${ramMb} MB) übersteigt den verfügbaren Arbeitsspeicher ` +
                        `des Servers (${totalMemMb} MB gesamt, mind. 256 MB müssen für das Betriebssystem frei bleiben).`
                };
            }

            await ssh.execCommand(conn, `mkdir -p ${shQuote(remoteDir)}`);
            await ssh.uploadFile(conn, localJarPath, remoteJarPath);
            await ssh.writeRemoteFile(conn, 'eula=true\n', `${remoteDir}/eula.txt`);
            await ssh.writeRemoteFile(
                conn,
                buildServerProperties({ name, serverPort }),
                `${remoteDir}/server.properties`
            );
            await ssh.writeRemoteFile(
                conn,
                buildStartScript({ remoteDir, ramMb }),
                `${remoteDir}/start.sh`
            );
            await ssh.execCommand(conn, `chmod +x ${shQuote(`${remoteDir}/start.sh`)}`);
            await ssh.execCommand(
                conn,
                `screen -S ${shQuote(name)} -dm bash ${shQuote(`${remoteDir}/start.sh`)}`
            );

            const servers = store.loadServers();
            servers.push({ name, masterServerId, serverPort, ramMb, software: jarFileName });
            store.saveServers(servers);

            return { success: true, message: `Server "${name}" erfolgreich erstellt.` };
        } catch (err) {
            console.error('Fehler beim Server erstellen:', err);
            return { success: false, message: `Fehler: ${err.message}` };
        }
    });

    ipcMain.handle('update-server', async (event, serverData, changes) => {
        try {
            const name = assertValidServerName(serverData.name);
            const servers = store.loadServers();
            const idx = servers.findIndex(s => s.name === name && s.masterServerId === serverData.masterServerId);
            if (idx === -1) return { success: false, message: `Server "${name}" nicht gefunden.` };

            const serverPort = assertValidPort(changes.serverPort, 'Server-Port');
            const ramMb = assertValidRam(changes.ramMb);
            const remoteDir = remoteDirFor(name);

            const conn = await connectToServer(servers[idx]);

            const totalMemMb = await getRemoteTotalMemMb(conn);
            if (totalMemMb !== null && ramMb > totalMemMb - 256) {
                return {
                    success: false,
                    message: `Angeforderter RAM (${ramMb} MB) übersteigt den verfügbaren Arbeitsspeicher ` +
                        `des Servers (${totalMemMb} MB gesamt, mind. 256 MB müssen für das Betriebssystem frei bleiben).`
                };
            }

            await patchServerPort(conn, remoteDir, serverPort);
            await ssh.writeRemoteFile(conn, buildStartScript({ remoteDir, ramMb }), `${remoteDir}/start.sh`);
            await ssh.execCommand(conn, `chmod +x ${shQuote(`${remoteDir}/start.sh`)}`);

            const running = await ssh.isServerRunning(conn, name);

            servers[idx] = { ...servers[idx], serverPort, ramMb };
            store.saveServers(servers);

            return {
                success: true,
                message: running
                    ? `Server "${name}" aktualisiert. Änderungen wirken erst nach einem Neustart des Servers.`
                    : `Server "${name}" aktualisiert.`
            };
        } catch (err) {
            return { success: false, message: `Fehler: ${err.message}` };
        }
    });

    ipcMain.handle('delete-server', async (event, serverData, options = {}) => {
        try {
            const name = assertValidServerName(serverData.name);
            const servers = store.loadServers();
            const idx = servers.findIndex(s => s.name === name && s.masterServerId === serverData.masterServerId);
            if (idx === -1) {
                return { success: false, message: `Server "${name}" nicht gefunden.` };
            }

            if (options.deleteRemoteFiles) {
                const conn = await connectToServer(servers[idx]);
                await ssh.execCommand(conn, `screen -S ${shQuote(name)} -X quit`).catch(() => {});
                await ssh.execCommand(conn, `rm -rf ${shQuote(remoteDirFor(name))}`);
            }

            servers.splice(idx, 1);
            store.saveServers(servers);
            return { success: true, message: `Server "${name}" gelöscht.` };
        } catch (err) {
            return { success: false, message: `Fehler: ${err.message}` };
        }
    });

    ipcMain.handle('createMasterServer', async (event, masterServerData) => {
        try {
            const name = String(masterServerData.name || '').trim();
            const ip = String(masterServerData.ip || '').trim();
            const sshPort = assertValidPort(masterServerData.sshPort, 'SSH-Port');
            const username = String(masterServerData.username || '').trim();
            const password = String(masterServerData.password || '');

            if (!name || !ip || !username || !password) {
                return { success: false, message: 'Bitte alle Felder ausfüllen.' };
            }

            const masterServers = await store.loadMasterServers();
            if (masterServers.find(ms => ms.name === name)) {
                return { success: false, message: 'Masterserver mit diesem Namen existiert bereits.' };
            }

            masterServers.push({ id: crypto.randomUUID(), name, ip, sshPort, username, password });
            await store.saveMasterServers(masterServers);

            return { success: true, message: `Masterserver "${name}" wurde gespeichert.` };
        } catch (err) {
            console.error('Fehler beim Speichern Masterserver:', err);
            return { success: false, message: `Fehler: ${err.message}` };
        }
    });

    ipcMain.handle('update-master-server', async (event, id, data) => {
        try {
            const masterServers = await store.loadMasterServers();
            const idx = masterServers.findIndex(ms => ms.id === id);
            if (idx === -1) return { success: false, message: 'Masterserver nicht gefunden.' };

            const name = String(data.name || '').trim();
            const ip = String(data.ip || '').trim();
            const sshPort = assertValidPort(data.sshPort, 'SSH-Port');
            const username = String(data.username || '').trim();
            // Leeres Passwortfeld = Passwort unverändert lassen (das
            // Bearbeiten-Formular zeigt das bestehende Passwort nicht an).
            const password = data.password ? String(data.password) : masterServers[idx].password;

            if (!name || !ip || !username || !password) {
                return { success: false, message: 'Bitte alle Felder ausfüllen.' };
            }
            if (masterServers.some((ms, i) => i !== idx && ms.name === name)) {
                return { success: false, message: 'Ein anderer Masterserver mit diesem Namen existiert bereits.' };
            }

            masterServers[idx] = { ...masterServers[idx], name, ip, sshPort, username, password };
            await store.saveMasterServers(masterServers);
            return { success: true, message: `Masterserver "${name}" aktualisiert.` };
        } catch (err) {
            return { success: false, message: `Fehler: ${err.message}` };
        }
    });

    ipcMain.handle('delete-master-server', async (event, id) => {
        try {
            const servers = store.loadServers();
            const dependent = servers.filter(s => s.masterServerId === id);
            if (dependent.length > 0) {
                return {
                    success: false,
                    message: `Masterserver kann nicht gelöscht werden: ${dependent.length} ` +
                        `Server referenzieren ihn noch (${dependent.map(s => s.name).join(', ')}). ` +
                        `Bitte zuerst diese Server löschen.`
                };
            }

            const masterServers = await store.loadMasterServers();
            const idx = masterServers.findIndex(ms => ms.id === id);
            if (idx === -1) return { success: false, message: 'Masterserver nicht gefunden.' };

            masterServers.splice(idx, 1);
            await store.saveMasterServers(masterServers);
            return { success: true, message: 'Masterserver gelöscht.' };
        } catch (err) {
            return { success: false, message: `Fehler: ${err.message}` };
        }
    });

    ipcMain.handle('loadMasterServers', async () => {
        try {
            return { success: true, masterServers: await store.loadMasterServers() };
        } catch (err) {
            console.error('Fehler beim Laden der Masterserver:', err);
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('load-servers', async () => {
        try {
            return store.loadServers();
        } catch (err) {
            console.error('Fehler beim Laden der Serverliste:', err);
            return [];
        }
    });

    ipcMain.handle('get-server-status', async (event, serverData) => {
        try {
            const name = assertValidServerName(serverData.name);
            const conn = await connectToServer(serverData);
            const online = await ssh.isServerRunning(conn, name);
            return { success: true, online };
        } catch (err) {
            return { success: false, online: false, error: err.message };
        }
    });

    ipcMain.handle('forget-host-key', async (event, { ip, sshPort }) => {
        try {
            const removed = knownHosts.forgetHostKey(store.dataDir, ip, sshPort);
            return { success: true, removed };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('start-server', async (event, serverData) => {
        try {
            const name = assertValidServerName(serverData.name);
            const remoteDir = remoteDirFor(name);
            const conn = await connectToServer(serverData);
            await ssh.execCommand(
                conn,
                `screen -S ${shQuote(name)} -dm bash ${shQuote(`${remoteDir}/start.sh`)}`
            );
            return { success: true, message: `Server ${name} gestartet.` };
        } catch (err) {
            return { success: false, message: 'Fehler beim Starten: ' + err.message };
        }
    });

    ipcMain.handle('stop-server', async (event, serverData) => {
        try {
            const name = assertValidServerName(serverData.name);
            const conn = await connectToServer(serverData);
            await ssh.execCommand(conn, `screen -S ${shQuote(name)} -X quit`);
            return { success: true, message: `Server ${name} gestoppt.` };
        } catch (err) {
            return { success: false, message: 'Fehler beim Stoppen: ' + err.message };
        }
    });

    ipcMain.handle('list-server-files', async (event, serverData, folderPath = '') => {
        try {
            const name = assertValidServerName(serverData.name);
            const relPath = sanitizeRelativePath(folderPath);
            const remoteDir = remoteDirFor(name);
            const targetDir = relPath ? `${remoteDir}/${relPath}` : remoteDir;

            const conn = await connectToServer(serverData);
            const list = await ssh.execCommand(conn, `ls -p -l ${shQuote(targetDir)}`);

            return parseLsLongOutput(list).map(entry => ({
                name: entry.name,
                path: relPath ? `${relPath}/${entry.name}` : entry.name,
                type: entry.isDir ? 'directory' : 'file',
                sizeBytes: entry.sizeBytes
            }));
        } catch (err) {
            console.error('Fehler beim Auflisten der Serverdateien:', err.message);
            return [];
        }
    });

    ipcMain.handle('delete-server-file', async (event, serverData, filePath) => {
        try {
            const name = assertValidServerName(serverData.name);
            const relPath = sanitizeRelativePath(filePath);
            if (!relPath) return { success: false, message: 'Kein gültiger Pfad angegeben.' };

            const conn = await connectToServer(serverData);
            await ssh.execCommand(conn, `rm -rf ${shQuote(`${remoteDirFor(name)}/${relPath}`)}`);
            return { success: true };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('rename-server-file', async (event, serverData, filePath, newName) => {
        try {
            const name = assertValidServerName(serverData.name);
            const relPath = sanitizeRelativePath(filePath);
            const safeNewName = sanitizeFileName(newName);
            if (!relPath) return { success: false, message: 'Kein gültiger Pfad angegeben.' };

            const remoteDir = remoteDirFor(name);
            const parentPath = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
            const oldTarget = `${remoteDir}/${relPath}`;
            const newTarget = parentPath ? `${remoteDir}/${parentPath}/${safeNewName}` : `${remoteDir}/${safeNewName}`;

            const conn = await connectToServer(serverData);
            await ssh.execCommand(conn, `mv ${shQuote(oldTarget)} ${shQuote(newTarget)}`);
            return { success: true };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('download-server-file', async (event, serverData, filePath) => {
        try {
            const name = assertValidServerName(serverData.name);
            const relPath = sanitizeRelativePath(filePath);
            if (!relPath) return { success: false, message: 'Kein gültiger Pfad angegeben.' };

            const suggestedName = relPath.split('/').pop();
            const win = BrowserWindow.fromWebContents(event.sender);
            const { canceled, filePath: savePath } = await dialog.showSaveDialog(win, { defaultPath: suggestedName });
            if (canceled || !savePath) return { success: false, canceled: true };

            const conn = await connectToServer(serverData);
            await ssh.downloadFile(conn, `${remoteDirFor(name)}/${relPath}`, savePath, (transferred, total) => {
                event.sender.send('file-transfer-progress', { fileName: suggestedName, transferred, total });
            });
            return { success: true, path: savePath };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('load-latest-log', async (event, serverData) => {
        try {
            const name = assertValidServerName(serverData.name);
            const conn = await connectToServer(serverData);
            const log = await ssh.execCommand(conn, `tail -n ${LOG_TAIL_LINES} ${shQuote(`${remoteDirFor(name)}/logs/latest.log`)}`);
            return { success: true, log: log || 'Keine Logs gefunden.' };
        } catch (err) {
            console.error('Fehler beim Laden der Logs:', err);
            return { success: false, log: `Fehler: ${err.message}` };
        }
    });

    ipcMain.handle('get-latest-log', async (event, serverData) => {
        try {
            const name = assertValidServerName(serverData.name);
            const remoteDir = remoteDirFor(name);
            const conn = await connectToServer(serverData);

            const check = await ssh.execCommand(conn, `pgrep -f ${shQuote(`${remoteDir}/server.jar`)}`).catch(() => '');
            if (!check.trim()) {
                return { success: false, reason: 'offline' };
            }

            const log = await ssh.execCommand(conn, `tail -n ${LOG_TAIL_LINES} ${shQuote(`${remoteDir}/logs/latest.log`)} || echo "__NO_LOG__"`);
            if (log.includes('__NO_LOG__')) {
                return { success: false, reason: 'no_log' };
            }
            return { success: true, log };
        } catch (err) {
            return { success: false, reason: 'error', error: err.message };
        }
    });

    ipcMain.on('stream-log', async (event, serverData) => {
        let name;
        try {
            name = assertValidServerName(serverData.name);
        } catch (err) {
            event.sender.send('log-stream-error', err.message);
            return;
        }

        let connectionConfig;
        try {
            connectionConfig = await resolveServerConnection(serverData);
        } catch (err) {
            event.sender.send('log-stream-error', err.message);
            return;
        }

        const senderId = event.sender.id;
        // Falls für diesen Renderer schon ein Stream läuft, erst sauber beenden.
        stopStreamFor(senderId);
        startLogStream(event.sender, senderId, name, connectionConfig);
    });

    ipcMain.handle('stop-log-stream', async (event) => {
        stopStreamFor(event.sender.id);
        return { success: true };
    });

    ipcMain.handle('sendServerCommand', async (event, serverData, command) => {
        try {
            const name = assertValidServerName(serverData.name);
            const conn = await connectToServer(serverData);

            const running = await ssh.isServerRunning(conn, name);
            if (!running) {
                return { success: false, message: `Server "${name}" ist nicht online.` };
            }

            const sendCmd = `screen -S ${shQuote(name)} -p 0 -X stuff ${shQuote(command + '\n')}`;
            await ssh.execCommand(conn, sendCmd);

            return { success: true, message: `Befehl "${command}" gesendet.` };
        } catch (err) {
            console.error('Fehler beim Senden des Befehls:', err);
            return { success: false, message: `Fehler: ${err.message}` };
        }
    });

    ipcMain.handle('upload-files-to-server', async (event, { server, files }) => {
        try {
            const name = assertValidServerName(server.name);
            const remotePath = remoteDirFor(name);
            const conn = await connectToServer(server);

            let uploadedCount = 0;
            for (const file of files) {
                const safeName = sanitizeFileName(file.name);
                const tempPath = path.join(os.tmpdir(), `msc-upload-${Date.now()}-${safeName}`);
                await fsp.writeFile(tempPath, Buffer.from(file.buffer));
                try {
                    await ssh.uploadFile(conn, tempPath, `${remotePath}/${safeName}`, (transferred, total) => {
                        event.sender.send('file-transfer-progress', { fileName: safeName, transferred, total });
                    });
                } finally {
                    await fsp.unlink(tempPath).catch(() => {});
                }
                uploadedCount++;
            }

            return { success: true, uploaded: uploadedCount };
        } catch (err) {
            console.error('Upload-Fehler:', err);
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('create-backup', async (event, serverData) => {
        try {
            const name = assertValidServerName(serverData.name);
            const remoteDir = remoteDirFor(name);
            const backupsDir = backupsDirFor(name);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupFile = `backup-${timestamp}.tar.gz`;

            const conn = await connectToServer(serverData);
            await ssh.execCommand(conn, `mkdir -p ${shQuote(backupsDir)}`);
            await ssh.execCommand(
                conn,
                `tar -czf ${shQuote(`${backupsDir}/${backupFile}`)} --exclude=backups -C ${shQuote(remoteDir)} .`
            );

            const pruned = await pruneOldBackups(conn, name).catch(() => []);
            const message = pruned.length > 0
                ? `Backup "${backupFile}" erstellt. ${pruned.length} älteres Backup/Backups automatisch gelöscht (Limit: ${MAX_BACKUPS_PER_SERVER}).`
                : `Backup "${backupFile}" erstellt.`;

            return { success: true, file: backupFile, message };
        } catch (err) {
            return { success: false, message: `Fehler beim Backup: ${err.message}` };
        }
    });

    ipcMain.handle('list-backups', async (event, serverData) => {
        try {
            const name = assertValidServerName(serverData.name);
            const conn = await connectToServer(serverData);
            const list = await ssh.execCommand(conn, `ls -p -l ${shQuote(backupsDirFor(name))} 2>/dev/null || true`);
            const backups = parseLsLongOutput(list).filter(e => !e.isDir);
            return { success: true, backups };
        } catch (err) {
            return { success: false, message: err.message, backups: [] };
        }
    });

    ipcMain.handle('download-backup', async (event, serverData, fileName) => {
        try {
            const name = assertValidServerName(serverData.name);
            const safeName = sanitizeFileName(fileName);

            const win = BrowserWindow.fromWebContents(event.sender);
            const { canceled, filePath: savePath } = await dialog.showSaveDialog(win, { defaultPath: safeName });
            if (canceled || !savePath) return { success: false, canceled: true };

            const conn = await connectToServer(serverData);
            await ssh.downloadFile(conn, `${backupsDirFor(name)}/${safeName}`, savePath, (transferred, total) => {
                event.sender.send('file-transfer-progress', { fileName: safeName, transferred, total });
            });
            return { success: true, path: savePath };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('delete-backup', async (event, serverData, fileName) => {
        try {
            const name = assertValidServerName(serverData.name);
            const safeName = sanitizeFileName(fileName);
            const conn = await connectToServer(serverData);
            await ssh.execCommand(conn, `rm -f ${shQuote(`${backupsDirFor(name)}/${safeName}`)}`);
            return { success: true };
        } catch (err) {
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('reload-window', async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.reload();
    });

    ipcMain.handle('app-version', () => app.getVersion());
}

function startLogStream(sender, senderId, name, connectionConfig) {
    const conn = new ssh.Client();
    const remoteLogPath = `${remoteDirFor(name)}/logs/latest.log`;
    let hostKeyMismatch = false;

    conn.on('ready', () => {
        conn.exec(`tail -n 50 -f ${shQuote(remoteLogPath)}`, (err, stream) => {
            if (err) {
                sender.send('log-stream-error', `Fehler beim Starten von tail: ${err.message}`);
                conn.end();
                activeLogStreams.delete(senderId);
                return;
            }

            activeLogStreams.set(senderId, { conn, stream });

            stream.on('data', chunk => sender.send('log-stream-data', chunk.toString()));
            stream.stderr.on('data', chunk => sender.send('log-stream-error', chunk.toString()));
            stream.on('close', () => {
                sender.send('log-stream-end');
                conn.end();
                activeLogStreams.delete(senderId);
            });
        });
    });

    conn.on('error', (err) => {
        const message = hostKeyMismatch
            ? ssh.hostKeyChangedError(connectionConfig.host, connectionConfig.port).message
            : `SSH-Verbindungsfehler: ${err.message}`;
        sender.send('log-stream-error', message);
        activeLogStreams.delete(senderId);
    });

    conn.connect(ssh.buildConnectOptions(connectionConfig, {
        dataDir: store.dataDir,
        onMismatch: () => { hostKeyMismatch = true; }
    }));
}

function stopStreamFor(senderId) {
    const entry = activeLogStreams.get(senderId);
    if (!entry) return;
    try {
        entry.stream.close();
    } catch {
        // ignore
    }
    try {
        entry.conn.end();
    } catch {
        // ignore
    }
    activeLogStreams.delete(senderId);
}

module.exports = { registerIpcHandlers };
