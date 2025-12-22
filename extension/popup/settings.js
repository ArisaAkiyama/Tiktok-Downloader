/**
 * TikDown Settings Script
 * Cookie status auto-sync from TikTok visits
 */

// DOM Elements
const backBtn = document.getElementById('backBtn');
const serverUrlInput = document.getElementById('serverUrl');
const downloadPathInput = document.getElementById('downloadPath');
const serverStatus = document.getElementById('serverStatus');
const checkStatusBtn = document.getElementById('checkStatusBtn');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const loginStatus = document.getElementById('loginStatus');
const statusIcon = document.getElementById('statusIcon');
const statusText = document.getElementById('statusText');

// Default settings
const defaultSettings = {
    serverUrl: 'http://localhost:3000',
    downloadPath: ''
};

// Current settings
let settings = { ...defaultSettings };

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    updateUI();
    checkServerStatus();
    checkLoginStatus();
});

// Load settings from storage
async function loadSettings() {
    try {
        const result = await chrome.storage.sync.get('settings');
        if (result.settings) {
            settings = { ...defaultSettings, ...result.settings };
        }
    } catch (e) {
        console.log('Using default settings:', e);
    }
}

// Save settings to storage
async function saveSettings() {
    try {
        await chrome.storage.sync.set({ settings });
        showStatus('Settings saved!', 'success');
    } catch (e) {
        showStatus('Failed to save settings', 'error');
    }
}

// Update UI with current settings
function updateUI() {
    serverUrlInput.value = settings.serverUrl;
    downloadPathInput.value = settings.downloadPath || '';
}

// Check server status
async function checkServerStatus() {
    const indicator = serverStatus.querySelector('.status-indicator');
    const serverStatusText = serverStatus.querySelector('span');

    indicator.className = 'status-indicator checking';
    serverStatusText.textContent = 'Checking...';

    try {
        const response = await fetch(`${settings.serverUrl}/api/health`, {
            method: 'GET',
            timeout: 5000
        });

        if (response.ok) {
            const data = await response.json();
            indicator.className = 'status-indicator online';
            serverStatusText.textContent = `Online - Browser: ${data.browser?.isRunning ? 'Running' : 'Idle'}`;
        } else {
            throw new Error('Server error');
        }
    } catch (e) {
        indicator.className = 'status-indicator offline';
        serverStatusText.textContent = 'Offline - Server tidak terkoneksi';
    }
}

/**
 * Check TikTok cookie status from server
 */
async function checkLoginStatus() {
    try {
        updateLoginStatus('checking', '⏳', 'Checking...');

        // Check cookie status from server
        const response = await fetch(`${settings.serverUrl}/api/cookie-status`);
        const data = await response.json();

        if (data.loggedIn) {
            updateLoginStatus('logged-in', '✅', `TikTok cookies tersedia (${data.cookieCount} cookies)`);
        } else {
            updateLoginStatus('logged-out', '❌', 'TikTok cookies tidak tersedia');
        }
    } catch (error) {
        console.error('Error checking login status:', error);
        updateLoginStatus('logged-out', '⚠️', 'Tidak dapat cek status cookies');
    }
}

/**
 * Update login status UI
 */
function updateLoginStatus(state, icon, text) {
    if (loginStatus) {
        loginStatus.className = 'login-status ' + state;
    }
    if (statusIcon) statusIcon.textContent = icon;
    if (statusText) statusText.textContent = text;
}

// Show status message
function showStatus(message, type) {
    const serverStatusText = serverStatus.querySelector('span');
    const originalText = serverStatusText.textContent;

    serverStatusText.textContent = message;
    serverStatusText.style.color = type === 'success' ? '#00c853' : '#ff3b30';

    setTimeout(() => {
        serverStatusText.textContent = originalText;
        serverStatusText.style.color = '';
    }, 3000);
}

// Event Listeners
backBtn.addEventListener('click', () => {
    window.location.href = 'popup.html';
});

checkStatusBtn.addEventListener('click', () => {
    checkServerStatus();
    checkLoginStatus();
});

saveBtn.addEventListener('click', () => {
    settings.serverUrl = serverUrlInput.value.trim() || defaultSettings.serverUrl;
    settings.downloadPath = downloadPathInput.value.trim();
    saveSettings();
});

resetBtn.addEventListener('click', () => {
    settings = { ...defaultSettings };
    updateUI();
    saveSettings();
});

// Validate URL on input
serverUrlInput.addEventListener('blur', () => {
    let url = serverUrlInput.value.trim();

    // Remove trailing slash
    if (url.endsWith('/')) {
        url = url.slice(0, -1);
    }

    // Add http if missing
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'http://' + url;
    }

    serverUrlInput.value = url;
});
