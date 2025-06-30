let servers = [];
let masterServers = [];
let selectedServer = null;
let logStreamActive = false;

// Serverliste laden
async function loadServers() {
    servers = await window.electronAPI.loadServers();
    const listElem = document.getElementById('serverList');
    listElem.innerHTML = '';

    servers.forEach((srv, i) => {
        const li = document.createElement('li');
        li.textContent = `${srv.name} (${srv.ip}:${srv.serverPort})`;
        li.style.cursor = 'pointer';
        li.onclick = () => selectServer(i);
        listElem.appendChild(li);
    });
}

// Server auswählen
function selectServer(index) {
    selectedServer = servers[index];
    document.getElementById('selectedServerName').innerText = selectedServer.name;
    document.getElementById('serverDetail').style.display = 'block';

    document.getElementById('consoleOutput').textContent = 'Verbinde zur Live-Konsole...';
    window.electronAPI.startLogStream(selectedServer);
    logStreamActive = true;

    loadFiles();
}

async function loadMasterServers() {
    const result = await window.electronAPI.loadMasterServers();
    const listElem = document.getElementById('masterServerList');
    listElem.innerHTML = '';

    if (result.success) {
        masterServers = result.masterServers;

        masterServers.forEach((ms, i) => {
            const li = document.createElement('li');
            li.textContent = `${ms.name} (${ms.ip})`;
            li.style.cursor = 'pointer';
            li.onclick = () => selectMasterServer(i);
            listElem.appendChild(li);
        });
    } else {
        listElem.textContent = 'Fehler beim Laden der Masterserver: ' + (result.message || 'Unbekannter Fehler');
    }
}

// Beispiel-Funktion, um einen Masterserver auszuwählen
function selectMasterServer(index) {
    const ms = masterServers[index];
    console.log('Ausgewählter Masterserver:', ms);
    // Hier kannst du weitere Details anzeigen oder Aktionen ausführen
}

// Server starten
async function startServer() {
    if (!selectedServer) return;
    const res = await window.electronAPI.startServer(selectedServer);
    appendConsole(res.message);
}

// Server stoppen
async function stopServer() {
    if (!selectedServer) return;
    const res = await window.electronAPI.stopServer(selectedServer);
    appendConsole(res.message);
}

async function loadMasterServersDropdown() {
    const masterSelect = document.getElementById('masterServer');

    // Vorhandene Optionen löschen
    masterSelect.innerHTML = '';
    // Platzhalter-Option hinzufügen
    const placeholderOption = document.createElement('option');
    placeholderOption.disabled = true;
    placeholderOption.selected = true;
    placeholderOption.textContent = 'Wähle einen Masterserver';
    masterSelect.appendChild(placeholderOption);

    try {
        const response = await window.electronAPI.loadMasterServers(); // oder window.api.loadMasterServers()
        if (response.success && Array.isArray(response.masterServers) && response.masterServers.length > 0) {
            response.masterServers.forEach(server => {
                const option = document.createElement('option');
                option.value = server.ip || server;   // je nachdem wie dein JSON aussieht
                option.textContent = server.name || server;
                masterSelect.appendChild(option);
            });
        } else if (!response.success) {
            console.error('Fehler beim Laden der Masterserver:', response.message);
            const errorOption = document.createElement('option');
            errorOption.disabled = true;
            errorOption.textContent = 'Fehler beim Laden der Masterserver';
            masterSelect.appendChild(errorOption);
        }
    } catch (error) {
        console.error('Unerwarteter Fehler beim Laden der Masterserver:', error);
        const errorOption = document.createElement('option');
        errorOption.disabled = true;
        errorOption.textContent = 'Fehler beim Laden der Masterserver';
        masterSelect.appendChild(errorOption);
    }
}

// Live-Log-Streaming einrichten
function setupLiveLogStream() {
    window.addEventListener('logStreamData', (e) => {
        appendConsole(e.detail);
    });

    window.addEventListener('logStreamError', (e) => {
        appendConsole(`❌ Fehler beim Streamen:\n${e.detail}`);
    });

    window.addEventListener('logStreamEnd', () => {
        appendConsole(`📴 Log-Stream wurde beendet.`);
        logStreamActive = false;
    });
}

// Konsolenausgabe anhängen
function appendConsole(text) {
    const consoleOutput = document.getElementById('consoleOutput');
    consoleOutput.innerText += text + '\n';
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

// Dateien laden und anzeigen
async function loadFiles(path = null) {
    if (!selectedServer) return;

    const files = await window.electronAPI.listServerFiles(selectedServer, path);
    const fileList = document.getElementById('fileList');
    fileList.innerHTML = '';

    files.forEach(file => {
        const li = document.createElement('li');
        li.className = 'cursor-pointer text-blue-600';

        if (file.type === 'directory') {
            li.textContent = `[📁] ${file.name}`;
            li.onclick = () => loadFiles(file.path);
        } else {
            li.textContent = file.name;
        }

        fileList.appendChild(li);
    });
}

async function handleFiles(files) {
    if (!selectedServer) {
        alert('Bitte wähle zuerst einen Server aus.');
        return;
    }

    const uploads = [];

    for (const file of files) {
        if (!addedFiles.has(file.name)) {
            addedFiles.add(file.name);

            const arrayBuffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);

            uploads.push({
                name: file.name,
                buffer: uint8Array,
            });

            const li = document.createElement('li');
            li.textContent = file.name;
            fileList.appendChild(li);
        }
    }

    const result = await window.electronAPI.uploadFilesToServer({
        server: selectedServer,
        files: uploads
    });

    if (!result.success) {
        alert(`❌ Upload fehlgeschlagen: ${result.message}`);
    } else {
        alert(`✅ ${result.uploaded} Datei(en) erfolgreich hochgeladen.`);
        loadFiles();
    }
}

async function loadJarOptions() {
    const result = await window.electronAPI.listJarFiles();
    const select = document.getElementById('serverSoftware');

    if (result.success) {
        result.jars.forEach(jar => {
            const option = document.createElement('option');
            option.value = jar;
            option.textContent = jar;
            select.appendChild(option);
        });
    } else {
        const option = document.createElement('option');
        option.disabled = true;
        option.textContent = 'Fehler beim Laden der Software';
        select.appendChild(option);
    }
}

function submitServerSoftware() {
    const input = document.getElementById('serverFile');
    const file = input.files[0];

    if (!file) {
        alert("Bitte wählen Sie eine Datei aus.");
        return;
    }

    const reader = new FileReader();

    reader.onload = async function () {
        const arrayBuffer = reader.result;
        const uint8Array = new Uint8Array(arrayBuffer);

        try {
            const result = await window.electronAPI.uploadServerSoftware(file.name, uint8Array);
            if (result.success) {
                alert("Datei erfolgreich hochgeladen.");
            } else {
                alert("Fehler beim Hochladen: " + result.error);
            }
        } catch (err) {
            alert("Kommunikationsfehler: " + err.message);
        } finally {
            closeSoftwareModal(); // Modal schließen
        }
    };

    reader.readAsArrayBuffer(file);
}

function closeServerDetail() {
    if (logStreamActive && selectedServer && window.electronAPI.stopLogStream) {
        try {
            window.electronAPI.stopLogStream(selectedServer);
        } catch (e) {
            console.warn('Fehler beim Beenden des LogStreams:', e);
        }
        logStreamActive = false;
    }

    selectedServer = null;
    document.getElementById('serverDetail').style.display = 'none';
    document.getElementById('selectedServerName').innerText = '';
    document.getElementById('consoleOutput').textContent = '';
    document.getElementById('fileList').innerHTML = '';
}

document.getElementById('commandInput').addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        const command = event.target.value.trim();
        if (!command || !selectedServer) return;

        // Befehl senden
        const res = await window.electronAPI.sendServerCommand(selectedServer, command);

        // Konsolenausgabe ergänzen mit Antwort oder Bestätigung
        appendConsole(`> ${command}`);
        appendConsole(res.message || 'Befehl gesendet.');

        // Input leeren
        event.target.value = '';
    }
});

function reloadFrontend() {
  window.electronAPI.reloadWindow();
}

window.addEventListener('DOMContentLoaded', async () => {
    const version = await window.electronAPI.getVersion();
    document.title = `Minecraft Server Manager - v${version} by Coreframe Studio`;
});

// Setup beim Laden
setupLiveLogStream();
loadServers();
loadJarOptions();
loadMasterServers();
loadMasterServersDropdown();