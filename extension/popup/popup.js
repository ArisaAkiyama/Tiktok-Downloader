/**
 * TikDown Popup Script
 * Handles UI interactions and API calls
 */

// DOM Elements
const urlInput = document.getElementById('urlInput');
const pasteBtn = document.getElementById('pasteBtn');
const downloadBtn = document.getElementById('downloadBtn');
const settingsBtn = document.getElementById('settingsBtn');
const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const errorMessage = document.getElementById('errorMessage');
const retryBtn = document.getElementById('retryBtn');
const resultsSection = document.getElementById('resultsSection');
const mediaCount = document.getElementById('mediaCount');
const mediaList = document.getElementById('mediaList');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');
const progressStatus = document.getElementById('progressStatus');
const progressPercent = document.getElementById('progressPercent');
const progressFill = document.getElementById('progressFill');
const progressDetail = document.getElementById('progressDetail');
const videoInfo = document.getElementById('videoInfo');
const previewPopup = document.getElementById('previewPopup');
const previewImage = document.getElementById('previewImage');

// State
let currentMedia = [];
let currentUsername = '';
let currentUrl = '';
let settings = {
    serverUrl: 'http://localhost:3000',
    downloadPath: ''
};

// TikTok URL validation
function isValidTikTokUrl(url) {
    const patterns = [
        /tiktok\.com\/@[\w.-]+\/video\/\d+/i,
        /tiktok\.com\/@[\w.-]+\/photo\/\d+/i,  // Story/Photo posts
        /vm\.tiktok\.com\/\w+/i,
        /m\.tiktok\.com\/v\/\d+/i,
        /tiktok\.com\/t\/\w+/i
    ];
    return patterns.some(pattern => pattern.test(url));
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // Load settings
    await loadSettings();

    // Get current tab URL first
    let currentTabUrl = '';
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) {
            currentTabUrl = tab.url;
            if (isValidTikTokUrl(tab.url)) {
                urlInput.value = tab.url;
            }
        }
    } catch (e) {
        console.log('Could not get tab URL');
    }

    // Check for existing state from background
    const state = await chrome.runtime.sendMessage({ action: 'getState' });

    // Only use cached state if URL matches current tab (prevents stale results after page refresh)
    const stateUrlMatches = state?.url && currentTabUrl &&
        (state.url === currentTabUrl || currentTabUrl.includes(state.url) || state.url.includes(currentTabUrl));

    if (state && state.media && !state.isProcessing && stateUrlMatches) {
        displayResults(state);
    } else if (state && state.isProcessing) {
        showLoading();
        pollForResults();
    } else {
        // Clear old state if URL changed
        if (state && state.media && !stateUrlMatches) {
            console.log('[TikDown] URL changed, clearing cached state');
            await chrome.runtime.sendMessage({ action: 'clearState' });
        }
    }
});

// Load settings from storage
async function loadSettings() {
    try {
        const result = await chrome.storage.sync.get('settings');
        if (result.settings) {
            settings = { ...settings, ...result.settings };
        }
    } catch (e) {
        console.log('Using default settings');
    }
}

// Event Listeners
pasteBtn.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        urlInput.value = text;
        urlInput.focus();
    } catch (e) {
        showToast('Tidak bisa paste dari clipboard', 'error');
    }
});

downloadBtn.addEventListener('click', startDownload);
retryBtn.addEventListener('click', startDownload);

urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        startDownload();
    }
});

settingsBtn.addEventListener('click', () => {
    window.location.href = 'settings.html';
});

// Close preview on click outside
document.addEventListener('click', (e) => {
    if (!previewPopup.classList.contains('hidden') &&
        !previewPopup.contains(e.target) &&
        !e.target.classList.contains('media-thumb')) {
        previewPopup.classList.add('hidden');
    }
});

// Start download process
async function startDownload() {
    const url = urlInput.value.trim();

    if (!url) {
        showToast('Masukkan URL video TikTok', 'error');
        return;
    }

    if (!isValidTikTokUrl(url)) {
        showToast('URL tidak valid. Masukkan URL video TikTok.', 'error');
        return;
    }

    currentUrl = url;

    // Clear previous state
    await chrome.runtime.sendMessage({ action: 'clearState' });

    // Show loading
    showLoading();

    // Start download in background
    chrome.runtime.sendMessage({ action: 'startDownload', url });

    // Poll for results
    pollForResults();
}

// Poll for results from background script
async function pollForResults() {
    let retryCount = 0;
    const maxRetries = 3;
    let pollCount = 0;

    const checkInterval = setInterval(async () => {
        try {
            pollCount++;
            const state = await chrome.runtime.sendMessage({ action: 'getState' });

            if (!state.isProcessing) {
                clearInterval(checkInterval);

                if (state.media && state.media.length > 0) {
                    displayResults(state);
                } else if (state.error) {
                    showError(state.error);
                } else {
                    showError('Tidak ada media ditemukan');
                }
            } else {
                // Update progress - only increase, never decrease
                // Progress: 50% + (pollCount * 2), max 90%
                const targetProgress = Math.min(50 + (pollCount * 2), 90);
                if (targetProgress > currentProgress) {
                    currentProgress = targetProgress;
                    updateProgress(currentProgress, 'Mengekstrak video...');
                }
                retryCount = 0; // Reset retry count on success
            }
        } catch (e) {
            retryCount++;
            console.log('Poll error:', e.message, 'retry:', retryCount);

            if (retryCount >= maxRetries) {
                clearInterval(checkInterval);
                showError('Koneksi ke background script terputus. Coba reload extension.');
            }
            // Otherwise keep trying
        }
    }, 1000); // Slower polling - 1 second

    // Timeout after 2 minutes
    setTimeout(() => {
        clearInterval(checkInterval);
    }, 120000);
}

// Track current progress for smooth animation
let currentProgress = 0;

// Show loading state
function showLoading() {
    loadingState.classList.remove('hidden');
    errorState.classList.add('hidden');
    resultsSection.classList.add('hidden');
    downloadBtn.disabled = true;

    // Reset progress
    currentProgress = 5;
    updateProgress(currentProgress, 'Menghubungkan ke server...');

    // Smooth progress animation - consistent increments
    let pollCount = 0;
    const progressInterval = setInterval(() => {
        pollCount++;
        // Calculate smooth progress: starts fast, slows down approaching 90%
        const targetProgress = Math.min(5 + (pollCount * 2), 90);

        // Only increase, never decrease
        if (targetProgress > currentProgress) {
            currentProgress = targetProgress;

            // Change detail text based on progress
            let detail = 'Menghubungkan ke server...';
            if (currentProgress > 20) detail = 'Memproses halaman TikTok...';
            if (currentProgress > 50) detail = 'Mengekstrak video...';
            if (currentProgress > 75) detail = 'Hampir selesai...';

            updateProgress(currentProgress, detail);
        }
    }, 400);

    // Store interval ID to clear later
    loadingState.dataset.progressInterval = progressInterval;
}

// Update progress bar
function updateProgress(percent, detail) {
    progressFill.style.width = `${percent}%`;
    progressPercent.textContent = `${Math.round(percent)}%`;
    if (detail) {
        progressDetail.textContent = detail;
    }
}

/**
 * Animate progress bar smoothly to target
 */
function animateProgress(targetPercent, duration, detail) {
    return new Promise(resolve => {
        const startPercent = currentProgress;
        const diff = targetPercent - startPercent;
        const startTime = Date.now();

        function animate() {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Easing function (ease-out)
            const eased = 1 - Math.pow(1 - progress, 3);
            currentProgress = startPercent + (diff * eased);

            updateProgress(currentProgress, detail);

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                resolve();
            }
        }

        requestAnimationFrame(animate);
    });
}

// Hide loading state
function hideLoading() {
    loadingState.classList.add('hidden');
    downloadBtn.disabled = false;

    // Clear progress interval
    const intervalId = loadingState.dataset.progressInterval;
    if (intervalId) {
        clearInterval(parseInt(intervalId));
    }
}

// Show error state
function showError(message) {
    hideLoading();
    errorState.classList.remove('hidden');
    resultsSection.classList.add('hidden');
    errorMessage.textContent = message;
}

// Display results
async function displayResults(state) {
    // Clear progress interval
    const intervalId = loadingState.dataset.progressInterval;
    if (intervalId) {
        clearInterval(parseInt(intervalId));
    }

    // Animate smoothly to 100%
    await animateProgress(100, 400, 'Selesai!');

    // Brief pause at 100%
    await new Promise(resolve => setTimeout(resolve, 200));

    hideLoading();

    errorState.classList.add('hidden');
    resultsSection.classList.remove('hidden');

    currentMedia = state.media;
    currentUsername = state.username || 'unknown';

    // Update media count
    const videoCount = currentMedia.filter(m => m.type === 'video').length;
    const audioCount = currentMedia.filter(m => m.type === 'audio').length;
    const imageCount = currentMedia.filter(m => m.type === 'image').length;
    let countText = [];
    if (videoCount > 0) countText.push(`${videoCount} video`);
    if (imageCount > 0) countText.push(`${imageCount} foto`);
    if (audioCount > 0) countText.push(`${audioCount} audio`);
    mediaCount.textContent = countText.join(', ');

    // Show ready message
    showToast(`✅ ${currentMedia.length} file siap download`, 'success');

    // Clear and populate media list
    mediaList.innerHTML = '';

    currentMedia.forEach((item, index) => {
        const mediaItem = createMediaItem(item, index);
        mediaList.appendChild(mediaItem);
    });

    // Reset Download All button
    downloadAllBtn.textContent = '💾 Download Semua';
    downloadAllBtn.disabled = false;
    downloadAllBtn.style.background = '';

    // Show video info
    if (state.username || state.caption || state.stats) {
        videoInfo.classList.remove('hidden');

        document.getElementById('infoUsername').textContent = '@' + (state.username || 'unknown');

        if (state.caption) {
            document.getElementById('captionRow').classList.remove('hidden');
            document.getElementById('infoCaption').textContent = state.caption;
        }

        if (state.stats && Object.keys(state.stats).length > 0) {
            document.getElementById('statsRow').classList.remove('hidden');
            document.getElementById('statLikes').textContent = formatNumber(state.stats.likes || 0);
            document.getElementById('statComments').textContent = formatNumber(state.stats.comments || 0);
            document.getElementById('statShares').textContent = formatNumber(state.stats.shares || 0);
        }
    }
}

// Format large numbers
function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
}

// Create media item element
function createMediaItem(item, index) {
    const div = document.createElement('div');
    div.className = 'media-item';

    const isVideo = item.type === 'video';
    const isAudio = item.type === 'audio';
    const isImage = item.type === 'image';

    // Thumbnail - use direct URL or fallback to icon
    const thumbUrl = item.thumbnail || (isImage ? item.url : null);
    const thumbHtml = thumbUrl
        ? `<img class="media-thumb" src="${thumbUrl}" alt="Thumbnail" data-index="${index}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'"><div class="media-thumb-fallback" style="display:none;align-items:center;justify-content:center;font-size:24px;width:48px;height:48px;background:#333;border-radius:4px;">${isVideo ? '🎬' : isImage ? '🖼️' : '🎵'}</div>`
        : `<div class="media-thumb" style="display:flex;align-items:center;justify-content:center;font-size:24px;">${isVideo ? '🎬' : isImage ? '🖼️' : '🎵'}</div>`;

    // Quality/info text
    let infoText = '';
    const sizeKB = item.size ? Math.round(item.size / 1024) : 0;

    if (isVideo) {
        infoText = `Video ${sizeKB > 0 ? `(${sizeKB}KB)` : ''}`;
    } else if (isImage) {
        infoText = `Photo ${sizeKB > 0 ? `(${sizeKB}KB)` : ''}`;
    } else if (isAudio) {
        infoText = item.title || 'Audio';
        if (item.author) infoText += ` - ${item.author}`;
    }

    // Type label
    const typeLabel = isVideo ? '🎬 Video' : isImage ? '🖼️ Foto' : '🎵 Audio';

    div.innerHTML = `
        ${thumbHtml}
        <div class="media-info">
            <span class="media-type ${item.type}">${typeLabel}</span>
            <div class="media-quality">${infoText}</div>
        </div>
        <div class="media-actions">
            <button class="btn-save" data-index="${index}" title="Simpan ke folder">💾</button>
        </div>
    `;

    // Event listeners
    const thumb = div.querySelector('.media-thumb');
    if (thumb && item.thumbnail) {
        thumb.addEventListener('click', () => showPreview(item.thumbnail, infoText));
    }

    div.querySelector('.btn-save').addEventListener('click', () => saveItem(index));

    return div;
}

// Show thumbnail preview
function showPreview(url, info) {
    previewImage.src = url;
    document.getElementById('previewInfo').textContent = info;
    previewPopup.classList.remove('hidden');
}

// Download single item (browser download)
async function downloadItem(index) {
    const item = currentMedia[index];
    if (!item) return;

    try {
        let downloadUrl;

        // If has captured buffer, use the captured endpoint
        if (item.hasCapturedBuffer && item.filename) {
            downloadUrl = `${settings.serverUrl}/api/download-captured/${encodeURIComponent(item.filename)}`;
        } else {
            // Fallback to proxy
            downloadUrl = `${settings.serverUrl}/api/proxy?url=${encodeURIComponent(item.url)}`;
        }

        // Determine file extension based on type
        let ext = 'mp4';
        if (item.type === 'audio') ext = 'mp3';
        if (item.type === 'image') ext = 'jpg';
        const filename = item.filename || `${currentUsername}_${Date.now()}_${index + 1}.${ext}`;

        // Create download link
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        showToast('Download dimulai...', 'success');
    } catch (e) {
        showToast('Gagal download: ' + e.message, 'error');
    }
}

// Save single item to folder
async function saveItem(index) {
    const item = currentMedia[index];
    if (!item) return;

    try {
        let response;

        // If has captured buffer, use save-captured endpoint
        if (item.hasCapturedBuffer && item.filename) {
            response = await fetch(`${settings.serverUrl}/api/save-captured`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: item.filename,
                    username: currentUsername
                })
            });
        } else {
            // Fallback to regular save
            let ext = 'mp4';
            if (item.type === 'audio') ext = 'mp3';
            if (item.type === 'image') ext = 'jpg';
            const filename = `${currentUsername}_${Date.now()}_${index + 1}.${ext}`;

            response = await fetch(`${settings.serverUrl}/api/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: item.url,
                    filename,
                    type: item.type,
                    username: currentUsername,
                    downloadPath: settings.downloadPath
                })
            });
        }

        const result = await response.json();

        if (result.success) {
            showToast('✅ Berhasil di Download!', 'success');
        } else {
            showToast('Gagal menyimpan: ' + result.error, 'error');
        }
    } catch (e) {
        showToast('Gagal menyimpan: ' + e.message, 'error');
    }
}

// Download all items
async function downloadAll() {
    if (currentMedia.length === 0) return;

    let successCount = 0;
    let failCount = 0;

    showToast(`Menyimpan ${currentMedia.length} file...`, 'info');

    for (let i = 0; i < currentMedia.length; i++) {
        const item = currentMedia[i];

        try {
            let response;

            if (item.hasCapturedBuffer && item.filename) {
                // Use save-captured for captured buffers
                response = await fetch(`${settings.serverUrl}/api/save-captured`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename: item.filename,
                        username: currentUsername
                    })
                });
            } else {
                // Fallback to regular save
                const ext = item.type === 'video' ? 'mp4' : 'mp3';
                const filename = `${currentUsername}_${Date.now()}_${i + 1}.${ext}`;

                response = await fetch(`${settings.serverUrl}/api/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: item.url,
                        filename,
                        type: item.type,
                        username: currentUsername,
                        downloadPath: settings.downloadPath
                    })
                });
            }

            const result = await response.json();
            if (result.success) {
                successCount++;
            } else {
                failCount++;
            }
        } catch (e) {
            failCount++;
        }
    }

    if (successCount > 0) {
        showToast(`✅ ${successCount} file tersimpan!`, 'success');
    }
    if (failCount > 0) {
        showToast(`❌ ${failCount} file gagal`, 'error');
    }
}

// Show toast notification
function showToast(message, type = 'info') {
    toast.className = 'toast ' + type;
    toastMessage.textContent = message;
    toast.classList.remove('hidden');

    setTimeout(() => {
        toast.classList.add('hidden');
    }, 3000);
}
