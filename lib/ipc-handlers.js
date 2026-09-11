const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

const store = require('./store');
const ssh = require('./ssh-service');
const {
    assertValidServerName,
    assertValidPort,
    assertValidRam,
    assertValidJarFileName,
    sanitizeFileName,
    sanitizeRelativePath,
    shQuote
} = require('./validate');

function remoteDirFor(name) {
    return `/root/${name}`;
}

function sshConfigFrom(serverData) {
    return {
        host: serverData.ip,
        port: serverData.sshPort,
        username: serverData.username,
        password: serverData.password
    };
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
        let conn;
        try {
            const { ip, username, password } = serverData;
            const name = assertValidServerName(serverData.name);
            const sshPort = assertValidPort(serverData.sshPort, 'SSH-Port');
            const serverPort = assertValidPort(serverData.serverPort, 'Server-Port');
            const ramMb = assertValidRam(serverData.ramMb);
            const jarFileName = assertValidJarFileName(serverData.software);

            const existing = store.loadServers();
            if (existing.some(s => s.name === name)) {
                return { success: false, message: `Server "${name}" existiert bereits.` };
            }

            const localJarPath = path.join(store.jarsDir, jarFileName);
            if (!fs.existsSync(localJarPath)) {
                return { success: false, message: `Lokale Datei ${jarFileName} nicht gefunden.` };
            }

            const remoteDir = remoteDirFor(name);
            const remoteJarPath = `${remoteDir}/server.jar`;

            conn = await ssh.connectSSH({ host: ip, port: sshPort, username, password });

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

            conn.end();
            conn = undefined;

            const servers = store.loadServers();
            servers.push({ ...serverData, name, sshPort, serverPort, ramMb, software: jarFileName });
            store.saveServers(servers);

            return { success: true, message: `Server "${name}" erfolgreich erstellt.` };
        } catch (err) {
            console.error('Fehler beim Server erstellen:', err);
            return { success: false, message: `Fehler: ${err.message}` };
        } finally {
            if (conn) conn.end();
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

            masterServers.push({ name, ip, sshPort, username, password });
            await store.saveMasterServers(masterServers);

            return { success: true, message: `Masterserver "${name}" wurde gespeichert.` };
        } catch (err) {
            console.error('Fehler beim Speichern Masterserver:', err);
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

    ipcMain.handle('start-server', async (event, serverData) => {
        let conn;
        try {
            const name = assertValidServerName(serverData.name);
            const remoteDir = remoteDirFor(name);
            conn = await ssh.connectSSH(sshConfigFrom(serverData));
            await ssh.execCommand(
                conn,
                `screen -S ${shQuote(name)} -dm bash ${shQuote(`${remoteDir}/start.sh`)}`
            );
            return { success: true, message: `Server ${name} gestartet.` };
        } catch (err) {
            return { success: false, message: 'Fehler beim Starten: ' + err.message };
        } finally {
            if (conn) conn.end();
        }
    });

    ipcMain.handle('stop-server', async (event, serverData) => {
        let conn;
        try {
            const name = assertValidServerName(serverData.name);
            conn = await ssh.connectSSH(sshConfigFrom(serverData));
            await ssh.execCommand(conn, `screen -S ${shQuote(name)} -X quit`);
            return { success: true, message: `Server ${name} gestoppt.` };
        } catch (err) {
            return { success: false, message: 'Fehler beim Stoppen: ' + err.message };
        } finally {
            if (conn) conn.end();
        }
    });

    ipcMain.handle('list-server-files', async (event, serverData, folderPath = '') => {
        let conn;
        try {
            const name = assertValidServerName(serverData.name);
            const relPath = sanitizeRelativePath(folderPath);
            const remoteDir = remoteDirFor(name);
            const targetDir = relPath ? `${remoteDir}/${relPath}` : remoteDir;

            conn = await ssh.connectSSH(sshConfigFrom(serverData));
            const list = await ssh.execCommand(conn, `ls -p -l ${shQuote(targetDir)}`);

            return list
                .split('\n')
                .filter(line => line && !line.startsWith('total'))
                .map(line => {
                    const match = line.match(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +(.+)$/);
                    if (!match) return null;
                    const fileName = match[1];
                    const isDir = line.startsWith('d');
                    return {
                        name: fileName,
                        path: relPath ? `${relPath}/${fileName}` : fileName,
                        type: isDir ? 'directory' : 'file'
                    };
                })
                .filter(Boolean);
        } catch (err) {
            console.error('Fehler beim Auflisten der Serverdateien:', err.message);
            return [];
        } finally {
            if (conn) conn.end();
        }
    });

    ipcMain.handle('load-latest-log', async (event, serverData) => {
        let conn;
        try {
            const name = assertValidServerName(serverData.name);
            conn = await ssh.connectSSH(sshConfigFrom(serverData));
            const log = await ssh.execCommand(conn, `cat ${shQuote(`${remoteDirFor(name)}/logs/latest.log`)}`);
            return { success: true, log: log || 'Keine Logs gefunden.' };
        } catch (err) {
            console.error('Fehler beim Laden der Logs:', err);
            return { success: false, log: `Fehler: ${err.message}` };
        } finally {
            if (conn) conn.end();
        }
    });

    ipcMain.handle('get-latest-log', async (event, serverData) => {
        let conn;
        try {
            const name = assertValidServerName(serverData.name);
            const remoteDir = remoteDirFor(name);
            conn = await ssh.connectSSH(sshConfigFrom(serverData));

            const check = await ssh.execCommand(conn, `pgrep -f ${shQuote(`${remoteDir}/server.jar`)}`).catch(() => '');
            if (!check.trim()) {
                return { success: false, reason: 'offline' };
            }

            const log = await ssh.execCommand(conn, `cat ${shQuote(`${remoteDir}/logs/latest.log`)} || echo "__NO_LOG__"`);
            if (log.includes('__NO_LOG__')) {
                return { success: false, reason: 'no_log' };
            }
            return { success: true, log };
        } catch (err) {
            return { success: false, reason: 'error', error: err.message };
        } finally {
            if (conn) conn.end();
        }
    });

    ipcMain.on('stream-log', (event, serverData) => {
        let name;
        try {
            name = assertValidServerName(serverData.name);
        } catch (err) {
            event.sender.send('log-stream-error', err.message);
            return;
        }

        const senderId = event.sender.id;
        // Falls für diesen Renderer schon ein Stream läuft, erst sauber beenden.
        stopStreamFor(senderId);
        startLogStream(event.sender, senderId, name, serverData);
    });

    ipcMain.handle('stop-log-stream', async (event) => {
        stopStreamFor(event.sender.id);
        return { success: true };
    });

    ipcMain.handle('sendServerCommand', async (event, serverData, command) => {
        let conn;
        try {
            const name = assertValidServerName(serverData.name);
            conn = await ssh.connectSSH(sshConfigFrom(serverData));

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
        } finally {
            if (conn) conn.end();
        }
    });

    ipcMain.handle('upload-files-to-server', async (event, { server, files }) => {
        let conn;
        try {
            const name = assertValidServerName(server.name);
            const remotePath = remoteDirFor(name);
            conn = await ssh.connectSSH(sshConfigFrom(server));

            let uploadedCount = 0;
            for (const file of files) {
                const safeName = sanitizeFileName(file.name);
                const tempPath = path.join(os.tmpdir(), `msc-upload-${Date.now()}-${safeName}`);
                await fsp.writeFile(tempPath, Buffer.from(file.buffer));
                try {
                    await ssh.uploadFile(conn, tempPath, `${remotePath}/${safeName}`);
                } finally {
                    await fsp.unlink(tempPath).catch(() => {});
                }
                uploadedCount++;
            }

            return { success: true, uploaded: uploadedCount };
        } catch (err) {
            console.error('Upload-Fehler:', err);
            return { success: false, message: err.message };
        } finally {
            if (conn) conn.end();
        }
    });

    ipcMain.handle('reload-window', async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.reload();
    });

    ipcMain.handle('app-version', () => app.getVersion());
}

function startLogStream(sender, senderId, name, serverData) {
    const conn = new Client();
    const remoteLogPath = `${remoteDirFor(name)}/logs/latest.log`;

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
        sender.send('log-stream-error', `SSH-Verbindungsfehler: ${err.message}`);
        activeLogStreams.delete(senderId);
    });

    conn.connect({
        host: serverData.ip,
        port: serverData.sshPort,
        username: serverData.username,
        password: serverData.password
    });
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
