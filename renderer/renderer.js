// ---------------------------------------------------------------------------
// Icons (minimal inline SVG, stroke-based) - static, trusted markup only.
// ---------------------------------------------------------------------------
const ICONS = {
    reload: '<path d="M13 3v4h-4"/><path d="M3 13v-4h4"/><path d="M3.5 7a5.5 5.5 0 0 1 9.3-3.5L13 5"/><path d="M12.5 9a5.5 5.5 0 0 1-9.3 3.5L3 11"/>',
    upload: '<path d="M8 2v8"/><path d="M5 5l3-3 3 3"/><path d="M3 12h10"/>',
    download: '<path d="M8 2v8"/><path d="M5 6l3 3 3-3"/><path d="M3 12h10"/>',
    plus: '<path d="M8 2v12"/><path d="M2 8h12"/>',
    pencil: '<path d="M10.5 1.5l4 4-8 8H3v-4z"/>',
    trash: '<path d="M3 4h10"/><path d="M6 4V2h4v2"/><path d="M4.5 4l.8 10h5.4l.8-10"/>',
    key: '<circle cx="5" cy="8" r="3"/><path d="M8 8h6"/><path d="M11.5 8v2.5"/><path d="M14 8v2.5"/>',
    play: '<path d="M4.5 2.5v11l9-5.5z"/>',
    stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1"/>',
    chevron: '<path d="M6 3l5 5-5 5"/>',
    folder: '<path d="M2 4.5h4l1 1.5h7v7H2z"/>',
    file: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>',
    x: '<path d="M3.5 3.5l9 9"/><path d="M12.5 3.5l-9 9"/>',
    server: '<rect x="2" y="3" width="12" height="4" rx="1"/><rect x="2" y="9" width="12" height="4" rx="1"/><path d="M4.5 5h.01"/><path d="M4.5 11h.01"/>',
    archive: '<rect x="2" y="3" width="12" height="3"/><path d="M3 6v7h10V6"/><path d="M6.5 9h3"/>'
};

function iconSvg(name, cls = 'w-4 h-4') {
    return `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let masterServers = [];
let servers = [];
let selectedServer = null;
let currentFolderPath = '';
let logStreamActive = false;

// ---------------------------------------------------------------------------
// Toasts (Ersatz für alert())
// ---------------------------------------------------------------------------
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const colors = {
        info: 'border-edge text-ink',
        success: 'border-online/40 text-online',
        error: 'border-danger/40 text-danger'
    };
    const el = document.createElement('div');
    el.className = `toast bg-panel2 border ${colors[type] || colors.info} rounded-md px-3 py-2.5 text-[12px] shadow-lg`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity .2s';
        setTimeout(() => el.remove(), 200);
    }, 4500);
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
function openModal(id) {
    const el = document.getElementById(id);
    el.classList.remove('hidden');
    el.classList.add('flex');
}

function closeModal(id) {
    const el = document.getElementById(id);
    el.classList.add('hidden');
    el.classList.remove('flex');
}

document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
});

function confirmDialog({ title, message, checkboxLabel }) {
    return new Promise(resolve => {
        document.getElementById('confirmModalTitle').textContent = title;
        document.getElementById('confirmModalMessage').textContent = message;
        const checkboxWrap = document.getElementById('confirmModalCheckboxWrap');
        const checkbox = document.getElementById('confirmModalCheckbox');
        checkbox.checked = false;
        if (checkboxLabel) {
            document.getElementById('confirmModalCheckboxLabel').textContent = checkboxLabel;
            checkboxWrap.hidden = false;
        } else {
            checkboxWrap.hidden = true;
        }

        const confirmBtn = document.getElementById('confirmModalConfirm');
        const cancelBtn = document.getElementById('confirmModalCancel');

        function cleanup(result) {
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            closeModal('confirmModal');
            resolve(result);
        }
        function onConfirm() { cleanup({ confirmed: true, checked: checkbox.checked }); }
        function onCancel() { cleanup({ confirmed: false, checked: false }); }

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        openModal('confirmModal');
    });
}

// ---------------------------------------------------------------------------
// Busy-State-Helfer für Buttons bei langlaufenden IPC-Aktionen
// ---------------------------------------------------------------------------
function withBusy(button, busyLabel, fn) {
    return async (...args) => {
        if (button.disabled) return;
        const original = button.innerHTML;
        button.disabled = true;
        button.classList.add('opacity-60', 'cursor-wait');
        if (busyLabel) button.textContent = busyLabel;
        try {
            return await fn(...args);
        } finally {
            button.disabled = false;
            button.classList.remove('opacity-60', 'cursor-wait');
            button.innerHTML = original;
        }
    };
}

function formatBytes(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Masterserver
// ---------------------------------------------------------------------------
async function loadMasterServers() {
    const result = await window.electronAPI.loadMasterServers();
    const listEl = document.getElementById('masterServerList');
    const emptyEl = document.getElementById('masterServerEmpty');
    const selectEl = document.getElementById('serverMasterServer');
    listEl.innerHTML = '';

    if (!result.success) {
        showToast('Fehler beim Laden der Masterserver: ' + (result.message || 'Unbekannter Fehler'), 'error');
        masterServers = [];
    } else {
        masterServers = result.masterServers;
    }

    emptyEl.hidden = masterServers.length > 0;

    selectEl.innerHTML = '<option value="" disabled selected>Wähle einen Masterserver</option>';
    for (const ms of masterServers) {
        const opt = document.createElement('option');
        opt.value = ms.id;
        opt.textContent = `${ms.name} (${ms.ip})`;
        selectEl.appendChild(opt);
    }

    for (const ms of masterServers) {
        const li = document.createElement('li');
        li.className = 'list-row flex items-center justify-between gap-2 px-3 py-2 group';

        const info = document.createElement('div');
        info.className = 'min-w-0';
        const nameEl = document.createElement('p');
        nameEl.className = 'truncate text-[12.5px]';
        nameEl.textContent = ms.name;
        const metaEl = document.createElement('p');
        metaEl.className = 'text-dim font-mono text-[11px] truncate';
        metaEl.textContent = `${ms.username}@${ms.ip}:${ms.sshPort}`;
        info.append(nameEl, metaEl);

        const actions = document.createElement('div');
        actions.className = 'flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0';

        const editBtn = document.createElement('button');
        editBtn.className = 'icon-btn p-1.5';
        editBtn.title = 'Bearbeiten';
        editBtn.innerHTML = iconSvg('pencil');
        editBtn.addEventListener('click', () => openMasterServerModal(ms));

        const keyBtn = document.createElement('button');
        keyBtn.className = 'icon-btn p-1.5';
        keyBtn.title = 'Host-Key zurücksetzen (nach legitimer Neuinstallation des Servers)';
        keyBtn.innerHTML = iconSvg('key');
        keyBtn.addEventListener('click', () => forgetHostKey(ms));

        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn danger p-1.5';
        delBtn.title = 'Löschen';
        delBtn.innerHTML = iconSvg('trash');
        delBtn.addEventListener('click', () => deleteMasterServer(ms));

        actions.append(editBtn, keyBtn, delBtn);
        li.append(info, actions);
        listEl.appendChild(li);
    }
}

function openMasterServerModal(ms) {
    const form = document.getElementById('masterServerForm');
    form.reset();
    document.getElementById('masterServerId').value = ms ? ms.id : '';
    document.getElementById('masterServerModalTitle').textContent = ms ? 'Masterserver bearbeiten' : 'Masterserver erstellen';
    document.getElementById('masterServerPasswordHint').hidden = !ms;
    document.getElementById('masterServerPassword').required = !ms;
    if (ms) {
        document.getElementById('masterServerName').value = ms.name;
        document.getElementById('masterServerIP').value = ms.ip;
        document.getElementById('masterServerSSHPort').value = ms.sshPort;
        document.getElementById('masterServerUsername').value = ms.username;
    }
    openModal('masterServerModal');
}

document.getElementById('btnNewMasterServer').addEventListener('click', () => openMasterServerModal(null));
document.getElementById('btnNewMasterServer').innerHTML = iconSvg('plus');
document.getElementById('masterServerModalClose').innerHTML = iconSvg('x');

document.getElementById('masterServerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = document.getElementById('masterServerId').value;
    const payload = {
        name: document.getElementById('masterServerName').value.trim(),
        ip: document.getElementById('masterServerIP').value.trim(),
        sshPort: parseInt(document.getElementById('masterServerSSHPort').value, 10),
        username: document.getElementById('masterServerUsername').value.trim(),
        password: document.getElementById('masterServerPassword').value
    };

    const result = id
        ? await window.electronAPI.updateMasterServer(id, payload)
        : await window.electronAPI.createMasterServer(payload);

    if (result.success) {
        showToast(result.message, 'success');
        closeModal('masterServerModal');
        await loadMasterServers();
    } else {
        showToast(result.message || 'Fehler beim Speichern.', 'error');
    }
});

async function deleteMasterServer(ms) {
    const { confirmed } = await confirmDialog({
        title: 'Masterserver löschen',
        message: `"${ms.name}" (${ms.ip}) wirklich löschen? Das schlägt fehl, solange noch Minecraft-Server darauf verweisen.`
    });
    if (!confirmed) return;

    const result = await window.electronAPI.deleteMasterServer(ms.id);
    showToast(result.message || (result.success ? 'Gelöscht.' : 'Fehler.'), result.success ? 'success' : 'error');
    if (result.success) await loadMasterServers();
}

async function forgetHostKey(ms) {
    const { confirmed } = await confirmDialog({
        title: 'Host-Key zurücksetzen',
        message: `Der gespeicherte SSH-Host-Key-Fingerabdruck für ${ms.ip}:${ms.sshPort} wird gelöscht und beim nächsten Verbindungsaufbau neu vertraut. Nur tun, wenn du sicher bist, dass sich der Server legitim geändert hat (z.B. Neuinstallation) - sonst öffnet das die Tür für Man-in-the-Middle-Angriffe.`
    });
    if (!confirmed) return;

    const result = await window.electronAPI.forgetHostKey({ ip: ms.ip, sshPort: ms.sshPort });
    showToast(result.removed ? 'Host-Key zurückgesetzt.' : 'Kein gespeicherter Host-Key gefunden.', result.success ? 'success' : 'error');
}

// ---------------------------------------------------------------------------
// Minecraft-Server-Liste
// ---------------------------------------------------------------------------
function masterServerLabel(masterServerId) {
    const ms = masterServers.find(m => m.id === masterServerId);
    return ms ? ms : null;
}

async function loadServers() {
    servers = await window.electronAPI.loadServers();
    const listEl = document.getElementById('serverList');
    const emptyEl = document.getElementById('serverEmpty');
    listEl.innerHTML = '';
    emptyEl.hidden = servers.length > 0;

    for (const srv of servers) {
        const ms = masterServerLabel(srv.masterServerId);
        const li = document.createElement('li');
        li.className = 'list-row flex items-center gap-2 px-3 py-2 cursor-pointer';
        li.dataset.serverKey = serverKey(srv);

        const dot = document.createElement('span');
        dot.className = 'status-dot pending';
        dot.dataset.role = 'status-dot';

        const info = document.createElement('div');
        info.className = 'min-w-0';
        const nameEl = document.createElement('p');
        nameEl.className = 'truncate text-[12.5px]';
        nameEl.textContent = srv.name;
        const metaEl = document.createElement('p');
        metaEl.className = 'text-dim font-mono text-[11px] truncate';
        metaEl.textContent = ms ? `${ms.ip}:${srv.serverPort}` : 'Masterserver fehlt';
        info.append(nameEl, metaEl);

        li.append(dot, info);
        li.addEventListener('click', () => selectServer(srv));
        listEl.appendChild(li);

        refreshServerStatus(srv, dot);
    }

    updateSelectedHighlight();
}

function serverKey(srv) {
    return `${srv.masterServerId || ''}::${srv.name}`;
}

function updateSelectedHighlight() {
    document.querySelectorAll('#serverList .list-row').forEach(row => {
        row.classList.toggle('active', selectedServer && row.dataset.serverKey === serverKey(selectedServer));
    });
}

async function refreshServerStatus(srv, dotEl) {
    try {
        const result = await window.electronAPI.getServerStatus(srv);
        dotEl.className = `status-dot ${result.success ? (result.online ? 'online' : 'offline') : 'error'}`;
        if (selectedServer && serverKey(selectedServer) === serverKey(srv)) {
            updateDetailStatusDot(result.success ? (result.online ? 'online' : 'offline') : 'error');
        }
    } catch {
        dotEl.className = 'status-dot error';
    }
}

function updateDetailStatusDot(state) {
    document.getElementById('detailStatusDot').className = `status-dot ${state}`;
}

// ---------------------------------------------------------------------------
// Server-Erstellung
// ---------------------------------------------------------------------------
document.getElementById('btnNewServer').addEventListener('click', () => {
    if (masterServers.length === 0) {
        showToast('Bitte zuerst einen Masterserver anlegen.', 'error');
        return;
    }
    document.getElementById('serverForm').reset();
    openModal('serverModal');
});
document.getElementById('btnNewServer').innerHTML = iconSvg('plus');
document.getElementById('serverModalClose').innerHTML = iconSvg('x');

document.getElementById('serverForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitBtn = document.getElementById('serverFormSubmit');
    await withBusy(submitBtn, 'Wird erstellt…', async () => {
        const payload = {
            masterServerId: document.getElementById('serverMasterServer').value,
            name: document.getElementById('serverName').value.trim(),
            serverPort: parseInt(document.getElementById('serverPort').value, 10),
            ramMb: parseInt(document.getElementById('serverRAM').value, 10),
            software: document.getElementById('serverSoftware').value
        };
        const result = await window.electronAPI.createServer(payload);
        showToast(result.message, result.success ? 'success' : 'error');
        if (result.success) {
            closeModal('serverModal');
            await loadServers();
        }
    })();
});

async function deleteSelectedServer() {
    if (!selectedServer) return;
    const { confirmed, checked } = await confirmDialog({
        title: 'Server löschen',
        message: `"${selectedServer.name}" wirklich aus der Liste entfernen?`,
        checkboxLabel: 'Auch Dateien auf dem Server löschen (screen wird beendet, Verzeichnis mit rm -rf gelöscht - unwiderruflich!)'
    });
    if (!confirmed) return;

    const result = await window.electronAPI.deleteServer(selectedServer, { deleteRemoteFiles: checked });
    showToast(result.message, result.success ? 'success' : 'error');
    if (result.success) {
        closeServerDetail();
        await loadServers();
    }
}

// ---------------------------------------------------------------------------
// Server-Detail (Konsole / Dateien / Backups)
// ---------------------------------------------------------------------------
function selectServer(srv) {
    selectedServer = srv;
    currentFolderPath = '';
    document.getElementById('emptyState').hidden = true;
    document.getElementById('serverDetail').hidden = false;
    updateSelectedHighlight();

    const ms = masterServerLabel(srv.masterServerId);
    document.getElementById('detailServerName').textContent = srv.name;
    document.getElementById('detailServerMeta').textContent = ms ? `${ms.ip}:${srv.serverPort} · ${srv.software}` : srv.software;
    updateDetailStatusDot('pending');

    document.getElementById('consoleOutput').textContent = 'Verbinde zur Live-Konsole...';
    window.electronAPI.startLogStream(selectedServer);
    logStreamActive = true;

    switchTab('console');
    loadFiles('');
}

function closeServerDetail() {
    if (logStreamActive && selectedServer) {
        try { window.electronAPI.stopLogStream(selectedServer); } catch { /* ignore */ }
        logStreamActive = false;
    }
    selectedServer = null;
    document.getElementById('serverDetail').hidden = true;
    document.getElementById('emptyState').hidden = false;
    updateSelectedHighlight();
}

document.getElementById('btnDeleteServer').innerHTML = iconSvg('trash');
document.getElementById('btnDeleteServer').addEventListener('click', deleteSelectedServer);

document.getElementById('btnStartServer').innerHTML = iconSvg('play') + '<span>Starten</span>';
document.getElementById('btnStopServer').innerHTML = iconSvg('stop') + '<span>Stoppen</span>';

document.getElementById('btnStartServer').addEventListener('click', withBusy(document.getElementById('btnStartServer'), null, async () => {
    if (!selectedServer) return;
    const res = await window.electronAPI.startServer(selectedServer);
    appendConsole(res.message);
    showToast(res.message, res.success ? 'success' : 'error');
}));

document.getElementById('btnStopServer').addEventListener('click', withBusy(document.getElementById('btnStopServer'), null, async () => {
    if (!selectedServer) return;
    const { confirmed } = await confirmDialog({ title: 'Server stoppen', message: `"${selectedServer.name}" wirklich stoppen?` });
    if (!confirmed) return;
    const res = await window.electronAPI.stopServer(selectedServer);
    appendConsole(res.message);
    showToast(res.message, res.success ? 'success' : 'error');
}));

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
    });
    ['console', 'files', 'backups'].forEach(t => {
        document.getElementById(`tab-${t}`).hidden = t !== tab;
    });
    if (tab === 'backups' && selectedServer) loadBackups();
}

function appendConsole(text) {
    const el = document.getElementById('consoleOutput');
    el.textContent += text + '\n';
    el.scrollTop = el.scrollHeight;
}

function setupLiveLogStream() {
    window.addEventListener('logStreamData', (e) => appendConsole(e.detail));
    window.addEventListener('logStreamError', (e) => {
        appendConsole(`Fehler beim Streamen:\n${e.detail}`);
        updateDetailStatusDot('error');
    });
    window.addEventListener('logStreamEnd', () => {
        appendConsole('Log-Stream wurde beendet.');
        logStreamActive = false;
    });
}

document.getElementById('commandInput').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const input = event.target;
    const command = input.value.trim();
    if (!command || !selectedServer) return;

    input.value = '';
    appendConsole(`> ${command}`);
    const res = await window.electronAPI.sendServerCommand(selectedServer, command);
    if (!res.success) appendConsole(res.message || 'Fehler beim Senden.');
});

// ---------------------------------------------------------------------------
// Dateien
// ---------------------------------------------------------------------------
function renderBreadcrumb() {
    const el = document.getElementById('fileBreadcrumb');
    el.innerHTML = '';
    const segments = currentFolderPath ? currentFolderPath.split('/') : [];

    const rootBtn = document.createElement('button');
    rootBtn.className = 'hover:text-ink shrink-0';
    rootBtn.textContent = selectedServer.name;
    rootBtn.addEventListener('click', () => loadFiles(''));
    el.appendChild(rootBtn);

    let acc = '';
    segments.forEach(seg => {
        acc = acc ? `${acc}/${seg}` : seg;
        const chevron = document.createElement('span');
        chevron.innerHTML = iconSvg('chevron', 'w-3 h-3 shrink-0');
        el.appendChild(chevron);

        const path = acc;
        const btn = document.createElement('button');
        btn.className = 'hover:text-ink shrink-0';
        btn.textContent = seg;
        btn.addEventListener('click', () => loadFiles(path));
        el.appendChild(btn);
    });
}

async function loadFiles(path) {
    if (!selectedServer) return;
    currentFolderPath = path;
    renderBreadcrumb();

    const files = await window.electronAPI.listServerFiles(selectedServer, path);
    const listEl = document.getElementById('fileList');
    listEl.innerHTML = '';

    if (files.length === 0) {
        const li = document.createElement('li');
        li.className = 'px-3 py-3 text-dim text-[12px]';
        li.textContent = 'Leer.';
        listEl.appendChild(li);
        return;
    }

    for (const file of files) {
        const li = document.createElement('li');
        li.className = 'flex items-center gap-2 px-3 py-2 group hover:bg-panel2';

        const iconWrap = document.createElement('span');
        iconWrap.className = 'text-dim shrink-0';
        iconWrap.innerHTML = iconSvg(file.type === 'directory' ? 'folder' : 'file');

        const nameEl = document.createElement(file.type === 'directory' ? 'button' : 'span');
        nameEl.className = file.type === 'directory'
            ? 'flex-1 min-w-0 truncate text-left hover:text-accenthi'
            : 'flex-1 min-w-0 truncate';
        nameEl.textContent = file.name;
        if (file.type === 'directory') {
            nameEl.addEventListener('click', () => loadFiles(file.path));
        }

        const sizeEl = document.createElement('span');
        sizeEl.className = 'text-dim font-mono text-[11px] shrink-0';
        sizeEl.textContent = file.type === 'directory' ? '' : formatBytes(file.sizeBytes);

        const actions = document.createElement('div');
        actions.className = 'flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0';

        if (file.type === 'file') {
            const dlBtn = document.createElement('button');
            dlBtn.className = 'icon-btn p-1.5';
            dlBtn.title = 'Herunterladen';
            dlBtn.innerHTML = iconSvg('download');
            dlBtn.addEventListener('click', () => downloadServerFile(file));
            actions.appendChild(dlBtn);
        }

        const renameBtn = document.createElement('button');
        renameBtn.className = 'icon-btn p-1.5';
        renameBtn.title = 'Umbenennen';
        renameBtn.innerHTML = iconSvg('pencil');
        renameBtn.addEventListener('click', () => renameServerFile(file));

        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn danger p-1.5';
        delBtn.title = 'Löschen';
        delBtn.innerHTML = iconSvg('trash');
        delBtn.addEventListener('click', () => deleteServerFile(file));

        actions.append(renameBtn, delBtn);
        li.append(iconWrap, nameEl, sizeEl, actions);
        listEl.appendChild(li);
    }
}

async function downloadServerFile(file) {
    const result = await window.electronAPI.downloadServerFile(selectedServer, file.path);
    if (result.canceled) return;
    showToast(result.success ? `Gespeichert unter ${result.path}` : result.message, result.success ? 'success' : 'error');
}

async function renameServerFile(file) {
    const newName = prompt(`Neuer Name für "${file.name}":`, file.name);
    if (!newName || newName === file.name) return;
    const result = await window.electronAPI.renameServerFile(selectedServer, file.path, newName);
    showToast(result.success ? 'Umbenannt.' : (result.message || 'Fehler.'), result.success ? 'success' : 'error');
    if (result.success) loadFiles(currentFolderPath);
}

async function deleteServerFile(file) {
    const { confirmed } = await confirmDialog({ title: 'Datei löschen', message: `"${file.name}" unwiderruflich löschen?` });
    if (!confirmed) return;
    const result = await window.electronAPI.deleteServerFile(selectedServer, file.path);
    showToast(result.success ? 'Gelöscht.' : (result.message || 'Fehler.'), result.success ? 'success' : 'error');
    if (result.success) loadFiles(currentFolderPath);
}

const addedFiles = new Set();
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => handleFiles(e.target.files));
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('border-accent'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('border-accent'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('border-accent');
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
});

async function handleFiles(files) {
    if (!selectedServer) {
        showToast('Bitte zuerst einen Server auswählen.', 'error');
        return;
    }

    const uploads = [];
    for (const file of files) {
        if (addedFiles.has(file.name)) continue;
        addedFiles.add(file.name);
        const arrayBuffer = await file.arrayBuffer();
        uploads.push({ name: file.name, buffer: new Uint8Array(arrayBuffer) });
    }
    if (uploads.length === 0) return;

    const result = await window.electronAPI.uploadFilesToServer({ server: selectedServer, files: uploads });
    for (const f of uploads) addedFiles.delete(f.name);

    if (!result.success) {
        showToast(`Upload fehlgeschlagen: ${result.message}`, 'error');
    } else {
        showToast(`${result.uploaded} Datei(en) erfolgreich hochgeladen.`, 'success');
        loadFiles(currentFolderPath);
    }
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------
async function loadBackups() {
    const listEl = document.getElementById('backupList');
    listEl.innerHTML = '<li class="px-3 py-3 text-dim text-[12px]">Lädt…</li>';

    const result = await window.electronAPI.listBackups(selectedServer);
    listEl.innerHTML = '';

    if (!result.success) {
        listEl.innerHTML = `<li class="px-3 py-3 text-danger text-[12px]">${result.message || 'Fehler beim Laden.'}</li>`;
        return;
    }
    if (result.backups.length === 0) {
        listEl.innerHTML = '<li class="px-3 py-3 text-dim text-[12px]">Noch keine Backups vorhanden.</li>';
        return;
    }

    for (const backup of result.backups.sort((a, b) => b.name.localeCompare(a.name))) {
        const li = document.createElement('li');
        li.className = 'flex items-center gap-2 px-3 py-2 group hover:bg-panel2';

        const iconWrap = document.createElement('span');
        iconWrap.className = 'text-dim shrink-0';
        iconWrap.innerHTML = iconSvg('archive');

        const nameEl = document.createElement('span');
        nameEl.className = 'flex-1 min-w-0 truncate font-mono text-[12px]';
        nameEl.textContent = backup.name;

        const sizeEl = document.createElement('span');
        sizeEl.className = 'text-dim font-mono text-[11px] shrink-0';
        sizeEl.textContent = formatBytes(backup.sizeBytes);

        const actions = document.createElement('div');
        actions.className = 'flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0';

        const dlBtn = document.createElement('button');
        dlBtn.className = 'icon-btn p-1.5';
        dlBtn.title = 'Herunterladen';
        dlBtn.innerHTML = iconSvg('download');
        dlBtn.addEventListener('click', async () => {
            const res = await window.electronAPI.downloadBackup(selectedServer, backup.name);
            if (res.canceled) return;
            showToast(res.success ? `Gespeichert unter ${res.path}` : res.message, res.success ? 'success' : 'error');
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn danger p-1.5';
        delBtn.title = 'Löschen';
        delBtn.innerHTML = iconSvg('trash');
        delBtn.addEventListener('click', async () => {
            const { confirmed } = await confirmDialog({ title: 'Backup löschen', message: `"${backup.name}" unwiderruflich löschen?` });
            if (!confirmed) return;
            const res = await window.electronAPI.deleteBackup(selectedServer, backup.name);
            showToast(res.success ? 'Gelöscht.' : (res.message || 'Fehler.'), res.success ? 'success' : 'error');
            if (res.success) loadBackups();
        });

        actions.append(dlBtn, delBtn);
        li.append(iconWrap, nameEl, sizeEl, actions);
        listEl.appendChild(li);
    }
}

document.getElementById('btnCreateBackup').addEventListener('click', withBusy(document.getElementById('btnCreateBackup'), 'Erstelle…', async () => {
    const result = await window.electronAPI.createBackup(selectedServer);
    showToast(result.message, result.success ? 'success' : 'error');
    if (result.success) loadBackups();
}));

// ---------------------------------------------------------------------------
// Server-Software hochladen
// ---------------------------------------------------------------------------
async function loadJarOptions() {
    const result = await window.electronAPI.listJarFiles();
    const select = document.getElementById('serverSoftware');
    select.innerHTML = '<option value="" disabled selected>Wähle eine Server-JAR</option>';

    if (result.success) {
        for (const jar of result.jars) {
            const opt = document.createElement('option');
            opt.value = jar;
            opt.textContent = jar;
            select.appendChild(opt);
        }
    } else {
        const opt = document.createElement('option');
        opt.disabled = true;
        opt.textContent = 'Fehler beim Laden der Software';
        select.appendChild(opt);
    }
}

document.getElementById('btnUploadSoftware').innerHTML = iconSvg('upload');
document.getElementById('btnUploadSoftware').addEventListener('click', () => openModal('softwareModal'));
document.getElementById('softwareModalClose').innerHTML = iconSvg('x');

document.getElementById('btnSubmitSoftware').addEventListener('click', withBusy(document.getElementById('btnSubmitSoftware'), 'Lädt hoch…', async () => {
    const input = document.getElementById('serverFile');
    const file = input.files[0];
    if (!file) {
        showToast('Bitte eine Datei auswählen.', 'error');
        return;
    }

    const arrayBuffer = await file.arrayBuffer();
    const result = await window.electronAPI.uploadServerSoftware(file.name, new Uint8Array(arrayBuffer));
    showToast(result.success ? 'Datei erfolgreich hochgeladen.' : `Fehler: ${result.error}`, result.success ? 'success' : 'error');
    if (result.success) {
        closeModal('softwareModal');
        input.value = '';
        await loadJarOptions();
    }
}));

// ---------------------------------------------------------------------------
// Sonstiges
// ---------------------------------------------------------------------------
document.getElementById('btnReload').innerHTML = iconSvg('reload');
document.getElementById('btnReload').addEventListener('click', () => window.electronAPI.reloadWindow());
document.getElementById('emptyStateIcon').innerHTML = iconSvg('server', 'w-10 h-10');

window.addEventListener('DOMContentLoaded', async () => {
    const version = await window.electronAPI.getVersion();
    document.title = `Minecraft Server Manager - v${version}`;
    document.getElementById('appVersion').textContent = `v${version}`;
});

setupLiveLogStream();
loadMasterServers().then(loadServers);
loadJarOptions();
