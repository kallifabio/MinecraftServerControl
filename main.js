const { app, BrowserWindow, ipcMain, Menu, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs').promises;
const { Client } = require('ssh2');

const dataDir = path.join(app.getPath('userData'), 'data');
const jarsDir = path.join(app.getPath('userData'), 'jars');
const serversFile = path.join(dataDir, 'servers.json');
const masterServersFile = path.join(dataDir, 'masterservers.json');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(jarsDir)) {
    fs.mkdirSync(jarsDir, { recursive: true });
}

if (!fs.existsSync(serversFile)) {
    fs.writeFileSync(serversFile, '{}', 'utf8');
}

if (!fs.existsSync(masterServersFile)) {
    fs.writeFileSync(masterServersFile, '{}', 'utf8');
}

// SSH Connect Helper (einfacher Wrapper)
function connectSSH(config) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => resolve(conn));
        conn.on('error', reject);
        conn.connect(config);
    });
}

// Kommando per SSH ausführen
function execCommand(conn, cmd) {
    return new Promise((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            let data = '';
            let error = '';
            stream.on('close', (code, signal) => {
                if (code !== 0) return reject(new Error(error || `Exit code ${code}`));
                resolve(data);
            });
            stream.on('data', chunk => (data += chunk));
            stream.stderr.on('data', chunk => (error += chunk));
        });
    });
}

// Datei per SFTP hochladen
function uploadFile(conn, localPath, remotePath) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            sftp.fastPut(localPath, remotePath, err => {
                if (err) return reject(err);
                resolve();
            });
        });
    });
}

// Fenster erstellen
function createWindow() {
    const win = new BrowserWindow({
        width: 1080,
        height: 720,
        icon: 'renderer/images/logo.png',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.loadFile('renderer/index.html');

    globalShortcut.register('F5', () => {
        win.reload();
    });

    globalShortcut.register('CmdOrCtrl+R', () => {
        win.reload();
    });

    globalShortcut.register('Ctrl+D', () => {
        win.webContents.openDevTools();
    });
}

// Handler - Jar Files auflisten
ipcMain.handle('listJarFiles', async () => {
    try {
        const files = await fs.promises.readdir(jarsDir);
        const jarFiles = files.filter(f => f.endsWith('.jar'));
        return { success: true, jars: jarFiles };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// Handler - Server Software hochladen
ipcMain.handle('upload-server-software', async (event, name, data) => {
    const targetPath = path.join(jarsDir, name);

    try {
        await fsp.writeFile(targetPath, data);
        console.log(`Server-Software gespeichert unter: ${targetPath}`);
        return { success: true };
    } catch (err) {
        console.error("Fehler beim Speichern der Server-Datei:", err);
        return { success: false, error: err.message };
    }
});

// Handler - Minecraft Server erstellen
ipcMain.handle('create-server', async (event, serverData) => {
    console.log('Empfangene Daten vom Frontend:', serverData);

    const { name, ip, sshPort, serverPort, software, ramMb, username, password } = serverData;

    const jarFileName = software;
    if (!jarFileName.endsWith('.jar')) {
        return { success: false, message: `Ungültige Jar-Datei: ${jarFileName}` };
    }

    const localJarPath = path.join(__dirname, 'jars', jarFileName);

    console.log('Jar-Datei:', jarFileName);
    console.log('Pfad zur JAR:', localJarPath);
    console.log('Existiert:', fs.existsSync(localJarPath));

    if (!fs.existsSync(localJarPath)) {
        return { success: false, message: `Lokale Datei ${jarFileName} nicht gefunden unter ${localJarPath}` };
    }

    const remoteDir = `/root/${name}`;
    const remoteJarPath = `${remoteDir}/server.jar`;

    try {
        const conn = await connectSSH({
            host: ip,
            port: sshPort,
            username: username,
            password: password
        });

        await execCommand(conn, `mkdir -p ${remoteDir}`);
        await uploadFile(conn, localJarPath, remoteJarPath);
        await execCommand(conn, `echo "eula=true" > ${remoteDir}/eula.txt`);

        const serverProperties = `
        #Minecraft server properties
        #Sun May 18 03:52:10 CEST 2025
        accepts-transfers=false
        allow-flight=false
        allow-nether=true
        broadcast-console-to-ops=true
        broadcast-rcon-to-ops=true
        bug-report-link=
        debug=false
        difficulty=easy
        enable-command-block=false
        enable-jmx-monitoring=false
        enable-query=false
        enable-rcon=false
        enable-status=true
        enforce-secure-profile=true
        enforce-whitelist=false
        entity-broadcast-range-percentage=100
        force-gamemode=false
        function-permission-level=2
        gamemode=survival
        generate-structures=true
        generator-settings={}
        hardcore=false
        hide-online-players=false
        initial-disabled-packs=
        initial-enabled-packs=vanilla
        level-name=world
        level-seed=
        level-type=minecraft\:normal
        log-ips=true
        max-chained-neighbor-updates=1000000
        max-players=20
        max-tick-time=60000
        max-world-size=29999984
        motd=A ${name} Minecraft Server
        network-compression-threshold=256
        online-mode=true
        op-permission-level=4
        player-idle-timeout=0
        prevent-proxy-connections=false
        pvp=true
        query.port=25565
        rate-limit=0
        rcon.password=
        rcon.port=25575
        region-file-compression=deflate
        require-resource-pack=false
        resource-pack=
        resource-pack-id=
        resource-pack-prompt=
        resource-pack-sha1=
        server-ip=
        server-port=${serverPort}
        simulation-distance=10
        spawn-animals=true
        spawn-monsters=true
        spawn-npcs=true
        spawn-protection=16
        sync-chunk-writes=true
        text-filtering-config=
        use-native-transport=true
        view-distance=10
        white-list=false
        `;

        await execCommand(conn, `echo "${serverProperties.replace(/(["`\\$])/g, '\\$1')}" > ${remoteDir}/server.properties`);

        const startScript = `
        #!/bin/bash
        cd "${remoteDir}"
        java -Xms${ramMb}M -Xmx${ramMb}M -jar server.jar nogui
        `;

        const escapedScript = startScript.replace(/(["`\\$])/g, '\\$1');
        await execCommand(
            conn,
            `echo "${escapedScript}" > ${remoteDir}/start.sh && chmod +x ${remoteDir}/start.sh`
        );

        await execCommand(conn, `screen -S ${name} -dm bash ${remoteDir}/start.sh`);

        conn.end();

        let servers = [];
        try {
            if (fs.existsSync(serversFile)) {
                const content = fs.readFileSync(serversFile, 'utf-8');
                servers = JSON.parse(content);
            }
        } catch (err) {
            console.error('Fehler beim Lesen von servers.json:', err.message);
        }

        servers.push(serverData);
        saveServers(servers);

        return { success: true, message: `Server "${name}" erfolgreich erstellt.` };
    } catch (err) {
        console.error('Fehler beim Server erstellen:', err);
        return { success: false, message: `Fehler: ${err.message}` };
    }
});

// Masterserver-Liste laden
async function loadMasterServersFromFile() {
    try {
        const data = await fs.readFile(masterServersFile, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

// Masterserver-Liste speichern
function saveMasterServersToFile(masterServers) {
    fs.writeFile(masterServersFile, JSON.stringify(masterServers, null, 2), 'utf8', (err) => {
        if (err) console.error('Fehler beim Speichern Masterserver:', err);
    });
}

// Handler - Masterserver erstellen
ipcMain.handle('createMasterServer', async (event, masterServerData) => {
    try {
        const masterServers = await loadMasterServersFromFile();

        if (masterServers.find(ms => ms.name === masterServerData.name)) {
            return { success: false, message: 'Masterserver mit diesem Namen existiert bereits.' };
        }

        // Nur erlaubte Felder speichern (Sicherheit)
        const newMasterServer = {
            name: masterServerData.name,
            ip: masterServerData.ip,
            sshPort: masterServerData.sshPort,
            username: masterServerData.username,
            password: masterServerData.password,
        };

        masterServers.push(newMasterServer);
        await saveMasterServersToFile(masterServers);

        return { success: true, message: `Masterserver "${newMasterServer.name}" wurde gespeichert.` };
    } catch (err) {
        console.error('Fehler beim Speichern Masterserver:', err);
        return { success: false, message: `Fehler: ${err.message}` };
    }
});

// Handler - Masterserver laden
ipcMain.handle('loadMasterServers', async () => {
    try {
        if (!fs.existsSync(masterServersFile)) {
            return { success: true, masterServers: [] };
        }
        const data = fs.readFileSync(masterServersFile, 'utf-8');
        const masterServers = JSON.parse(data);
        return { success: true, masterServers };
    } catch (e) {
        console.error('Fehler beim Laden der Masterserver:', e);
        return { success: false, message: e.message };
    }
});

// Handler - Server laden
ipcMain.handle('load-servers', async () => {
    try {
        if (!fs.existsSync(serversFile)) return [];
        const data = fs.readFileSync(serversFile, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        console.error('Fehler beim Laden der Serverliste:', e);
        return [];
    }
});

// Server in File speichern
function saveServers(servers) {
    fs.writeFileSync(serversFile, JSON.stringify(servers, null, 2), 'utf-8');
}

// Handler - Server starten
ipcMain.handle('start-server', async (event, serverData) => {
    const { ip, sshPort, name, ramMb, username, password } = serverData;
    const remoteDir = `/root/${name}`;

    try {
        const conn = await connectSSH({
            host: ip,
            port: sshPort,
            username: username,
            password: password
        });

        const cmd = `screen -S ${name} -dm bash ${remoteDir}/start.sh`;
        const result = await execCommand(conn, cmd);
        conn.end();
        return { success: true, message: `Server ${name} gestartet.` };
    } catch (e) {
        return { success: false, message: 'Fehler beim Starten: ' + e.message };
    }
});

// Handler - Server stoppen
ipcMain.handle('stop-server', async (event, serverData) => {
    const { ip, sshPort, name, username, password } = serverData;

    try {
        const conn = await connectSSH({
            host: ip,
            port: sshPort,
            username: username,
            password: password
        });

        const cmd = `screen -S ${name} -X quit`;
        const result = await execCommand(conn, cmd);
        conn.end();
        return { success: true, message: `Server ${name} gestoppt.` };
    } catch (e) {
        return { success: false, message: 'Fehler beim Stoppen: ' + e.message };
    }
});

// Handler - Serverfiles auflisten
ipcMain.handle('list-server-files', async (event, serverData, folderPath = '') => {
    const { ip, sshPort, name, username, password } = serverData;
    const remoteDir = `/root/${name}`;
    const targetDir = folderPath ? `${remoteDir}/${folderPath}` : remoteDir;

    try {
        const conn = await connectSSH({
            host: ip,
            port: sshPort,
            username: username,
            password: password
        });

        const list = await execCommand(conn, `ls -p -l "${targetDir}"`);
        conn.end();

        const files = list
            .split('\n')
            .filter(line => line && !line.startsWith('total'))
            .map(line => {
                const match = line.match(/^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +(.+)$/);
                if (!match) return null;
                const name = match[1];
                const isDir = line.startsWith('d');
                return {
                    name,
                    path: folderPath ? `${folderPath}/${name}` : name,
                    type: isDir ? 'directory' : 'file'
                };
            }).filter(Boolean);

        return files;
    } catch (e) {
        conn.end();
        return [];
    }
});

// Handler - Letzten Log laden
ipcMain.handle('load-latest-log', async (event, serverData) => {
    const { name, ip, sshPort, username, password } = serverData;
    const remoteLogPath = `/root/${name}/logs/latest.log`;

    try {
        const conn = await connectSSH({
            host: ip,
            port: sshPort,
            username: username,
            password: password
        });

        const result = await execCommand(conn, `cat ${remoteLogPath}`);
        conn.end();

        return { success: true, log: result.stdout || 'Keine Logs gefunden.' };
    } catch (err) {
        console.error('Fehler beim Laden der Logs:', err);
        return { success: false, log: `Fehler: ${err.message}` };
    }
});

// Handler - Letzten Log bekommen
ipcMain.handle('get-latest-log', async (event, serverData) => {
    const { ip, sshPort, name, username, password } = serverData;
    const remotePath = `/root/${name}/logs/latest.log`;

    try {
        const conn = await connectSSH({
            host: ip,
            port: sshPort,
            username: username,
            password: password
        });

        const check = await execCommand(conn, `pgrep -f "/root/${name}/server.jar"`);

        if (!check.trim()) {
            conn.end();
            return { success: false, reason: 'offline' };
        }

        const log = await execCommand(conn, `cat "${remotePath}" || echo "__NO_LOG__"`);

        conn.end();

        if (log.includes('__NO_LOG__')) {
            return { success: false, reason: 'no_log' };
        }

        return { success: true, log };
    } catch (err) {
        return { success: false, reason: 'error', error: err.message };
    }
});

// Handler - Log live streamen
ipcMain.on('stream-log', async (event, serverData) => {
    const { ip, sshPort, name, username, password } = serverData;
    const conn = new Client();
    const remoteLogPath = `/root/${name}/logs/latest.log`;

    conn.on('ready', () => {
        conn.exec(`tail -n 50 -f "${remoteLogPath}"`, (err, stream) => {
            if (err) {
                event.sender.send('log-stream-error', `Fehler beim Starten von tail: ${err.message}`);
                conn.end();
                return;
            }

            stream.on('data', chunk => {
                event.sender.send('log-stream-data', chunk.toString());
            });

            stream.stderr.on('data', chunk => {
                event.sender.send('log-stream-error', chunk.toString());
            });

            stream.on('close', () => {
                event.sender.send('log-stream-end');
                conn.end();
            });
        });
    });

    conn.on('error', (err) => {
        event.sender.send('log-stream-error', `SSH-Verbindungsfehler: ${err.message}`);
    });

    conn.connect({
        host: ip,
        port: sshPort,
        username: username,
        password: password
    });
});

// Handler - Serverdetails schließen
ipcMain.handle('stop-log-stream', async (event, serverData) => {
    const { ip, sshPort, name, username, password } = serverData;

    try {
        const conn = await connectSSH({
            host: ip,
            port: sshPort,
            username: username,
            password: password
        });

        try {
            //
        } catch (innerErr) {
            console.warn(`Warnung: screen-Session ${serverData.name} existiert möglicherweise nicht.`);
        }

        conn.end();
        return { success: true };
    } catch (err) {
        console.error('Fehler beim Stoppen des Log-Streams:', err);
        return { success: false, message: err.message };
    }
});

// Serverstatus prüfen vor dem Senden des Befehls
async function isServerRunning(conn, screenName) {
    try {
        const { stdout } = await execCommand(conn, `screen -ls | grep ${screenName}`);
        return stdout.includes(screenName);
    } catch {
        return false;
    }
}

// Handler - Commands senden
ipcMain.handle('sendServerCommand', async (event, serverData, command) => {
    const { ip, sshPort, name, username, password } = serverData;

    try {
        const conn = await connectSSH({
            host: ip,
            port: sshPort,
            username: username,
            password: password
        });

        const running = await isServerRunning(conn, name);
        if (!running) {
            conn.end();
            return { success: false, message: `Server "${name}" ist nicht online.` };
        }

        const sendCmd = `screen -S ${name} -p 0 -X stuff '${command}\n'`;
        await execCommand(conn, sendCmd);

        conn.end();
        return { success: true, message: `Befehl "${command}" gesendet.` };
    } catch (err) {
        console.error('Fehler beim Senden des Befehls:', err);
        return { success: false, message: `Fehler: ${err.message}` };
    }
});

// Handler - Upload Files per Drag and Drop
ipcMain.handle('upload-files-to-server', async (event, { server, files }) => {
    const { ip, sshPort, username, password, name } = server;
    const remotePath = `/root/${name}`;

    try {
        const conn = await connectSSH({
            host: ip,
            port: sshPort,
            username: username,
            password: password
        });

        let uploadedCount = 0;

        for (const file of files) {
            // Temporär auf lokale Festplatte speichern
            const tempPath = path.join(os.tmpdir(), file.name);
            fs.writeFileSync(tempPath, Buffer.from(file.buffer));

            // Hochladen per SFTP
            const remoteFilePath = `${remotePath}/${file.name}`;
            await uploadFile(conn, tempPath, remoteFilePath);

            // Lokale temporäre Datei entfernen
            fs.unlinkSync(tempPath);
            uploadedCount++;
        }

        conn.end();
        return { success: true, uploaded: uploadedCount };
    } catch (err) {
        console.error('Upload-Fehler:', err);
        return { success: false, message: err.message };
    }
});

// Handler - Frontend neuladen
ipcMain.handle('reload-window', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.reload();
});

// Handler - Version Nummer
ipcMain.handle('app-version', () => {
    return app.getVersion();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.whenReady().then(() => {
    createWindow();

    Menu.setApplicationMenu(null);
});
