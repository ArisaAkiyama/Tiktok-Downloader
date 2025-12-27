/**
 * TikDown - Background Service Worker
 * Handles downloads in background so popup closing doesn't interrupt
 */

// Default server URL - will be updated from settings
let serverUrl = 'http://localhost:3000';

// Store current download state
let downloadState = {
    isProcessing: false,
    url: null,
    media: null,
    username: null,
    error: null,
    progress: 0
};

// Track last processed tab to detect changes
let lastProcessedTabId = null;

/**
 * Clear state and badge - reset extension
 */
function clearDownloadState() {
    downloadState = {
        isProcessing: false,
        url: null,
        media: null,
        username: null,
        error: null,
        progress: 0
    };
    lastProcessedTabId = null;
    chrome.action.setBadgeText({ text: '' });
    console.log('[Background] State cleared');
}

/**
 * Listen for tab updates (page refresh/navigation)
 * Show badge when on downloadable TikTok content
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // When page finishes loading, check if it's downloadable TikTok content
    if (changeInfo.status === 'complete' && tab.url) {
        if (isValidTikTokUrl(tab.url)) {
            // Show badge to indicate content is ready to download
            const isPhoto = tab.url.includes('/photo/');
            chrome.action.setBadgeText({ text: '●', tabId });
            chrome.action.setBadgeBackgroundColor({ color: isPhoto ? '#FFD700' : '#FE2C55', tabId }); // Yellow for photo, Red for video
            console.log('[Background] Detected downloadable TikTok content:', isPhoto ? 'photo' : 'video');
        } else if (tab.url.includes('tiktok.com')) {
            // On TikTok but not on video/photo page - clear badge
            chrome.action.setBadgeText({ text: '', tabId });
        }
    }

    // When page starts loading (refresh or navigation)
    if (changeInfo.status === 'loading' && tab.url) {
        // If this tab had results and is now refreshing, clear state
        if (downloadState.url && tab.url.includes('tiktok.com')) {
            console.log('[Background] TikTok page refreshed, clearing state');
            clearDownloadState();
        }
    }
});

/**
 * Get server URL from settings
 */
async function getServerUrl() {
    try {
        const result = await chrome.storage.sync.get('settings');
        if (result.settings?.serverUrl) {
            serverUrl = result.settings.serverUrl;
        }
    } catch (e) {
        console.log('[Background] Using default server URL');
    }
    return serverUrl;
}

/**
 * Sync TikTok cookies from browser to server
 * Called automatically before each download
 */
async function syncCookiesToServer() {
    try {
        const url = await getServerUrl();

        // Get all TikTok cookies from browser
        const cookies = await chrome.cookies.getAll({ domain: '.tiktok.com' });

        if (cookies.length === 0) {
            console.log('[Background] No TikTok cookies found in browser');
            return false;
        }

        // Send cookies to server
        const response = await fetch(`${url}/api/set-cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies })
        });

        const result = await response.json();

        if (result.success) {
            console.log(`[Background] Cookies synced to server (${cookies.length} cookies)`);
            return true;
        } else {
            console.log('[Background] Failed to sync cookies:', result.error);
            return false;
        }
    } catch (e) {
        console.log('[Background] Cookie sync error:', e.message);
        return false;
    }
}

/**
 * Validate TikTok URL
 */
function isValidTikTokUrl(url) {
    const patterns = [
        /tiktok\.com\/@[\w.-]+\/video\/\d+/i,
        /tiktok\.com\/@[\w.-]+\/photo\/\d+/i,  // Photo stories
        /vm\.tiktok\.com\/\w+/i,
        /m\.tiktok\.com\/v\/\d+/i,
        /tiktok\.com\/t\/\w+/i
    ];
    return patterns.some(pattern => pattern.test(url));
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[Background] Received message:', request.action);

    if (request.action === 'startDownload') {
        handleDownload(request.url);
        sendResponse({ started: true });
        return true;
    }

    if (request.action === 'getState') {
        sendResponse(downloadState);
        return true;
    }

    if (request.action === 'clearState') {
        clearDownloadState();
        sendResponse({ cleared: true });
        return true;
    }

    if (request.action === 'saveMedia') {
        handleSaveMedia(request.items, request.username);
        sendResponse({ started: true });
        return true;
    }

    if (request.action === 'validateUrl') {
        const isValid = isValidTikTokUrl(request.url);
        sendResponse({ valid: isValid });
        return true;
    }

    if (request.action === 'updateProgress') {
        // Update progress in state and persist to storage
        if (downloadState.isProcessing) {
            downloadState.progress = request.progress;
            // Persist to storage so it survives popup close/reopen
            chrome.storage.local.set({ downloadState });
        }
        sendResponse({ updated: true });
        return true;
    }

    if (request.action === 'getCookies') {
        // Get TikTok cookies for content script
        chrome.cookies.getAll({ domain: '.tiktok.com' }, (cookies) => {
            sendResponse({ cookies: cookies || [] });
        });
        return true; // Keep channel open for async response
    }
});

/**
 * Handle download request - runs in background
 */
async function handleDownload(url) {
    console.log('[Background] Starting download for:', url);

    // Auto-sync cookies from browser to server before download
    await syncCookiesToServer();

    const isPhotoUrl = url.includes('/photo/');

    // Get server URL from settings
    const baseUrl = await getServerUrl();
    const API_URL = `${baseUrl}/api/download`;

    downloadState = {
        isProcessing: true,
        url: url,
        media: null,
        username: null,
        error: null
    };

    // Persist state
    await chrome.storage.local.set({ downloadState });


    try {
        // ALWAYS use server for photos - server uses Puppeteer with network interception
        // which is more reliable than content script DOM extraction
        // Content script often captures wrong images (avatars, thumbnails, etc.)
        if (isPhotoUrl) {
            console.log('[Background] Photo URL detected, using server for reliable extraction...');
        }

        // Create abort controller with 2 minute timeout (for server fallback)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minutes

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const data = await response.json();

        if (data.success && data.media?.length > 0) {
            downloadState = {
                isProcessing: false,
                url: url,
                media: data.media,
                username: data.username || 'unknown',
                caption: data.caption || '',
                hashtags: data.hashtags || [],
                stats: data.stats || {},
                thumbnail: data.thumbnail,
                downloadPath: data.downloadPath,
                error: null
            };
            console.log('[Background] Download complete:', data.media.length, 'items');

            // Show badge with count (pink for TikTok theme)
            chrome.action.setBadgeText({ text: String(data.media.length) });
            chrome.action.setBadgeBackgroundColor({ color: '#FE2C55' }); // TikTok pink
        } else {
            downloadState = {
                isProcessing: false,
                url: url,
                media: null,
                username: null,
                error: data.error || 'Failed to extract media'
            };
            console.log('[Background] Download failed:', downloadState.error);
        }

    } catch (error) {
        console.error('[Background] Download error:', error);
        let errorMsg = 'Server tidak terkoneksi. Pastikan server berjalan.';
        if (error.name === 'AbortError') {
            errorMsg = 'Request timeout. Video mungkin terlalu besar atau server lambat.';
        }
        downloadState = {
            isProcessing: false,
            url: url,
            media: null,
            username: null,
            error: errorMsg
        };
    }

    // Persist final state
    await chrome.storage.local.set({ downloadState });
}

/**
 * Handle saving multiple media files
 */
async function handleSaveMedia(items, username) {
    console.log('[Background] Saving', items.length, 'items for', username);

    // Get server URL from settings
    const baseUrl = await getServerUrl();
    const SAVE_URL = `${baseUrl}/api/save`;

    let savedCount = 0;
    let errors = [];

    for (const item of items) {
        try {
            const response = await fetch(SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: item.url,
                    filename: item.filename,
                    type: item.type,
                    username: username
                })
            });

            const result = await response.json();
            if (result.success) {
                savedCount++;
            } else {
                errors.push(item.filename);
            }
        } catch (error) {
            errors.push(item.filename);
        }
    }

    console.log('[Background] Saved', savedCount, 'of', items.length);

    // Update state with save results
    await chrome.storage.local.set({
        lastSaveResult: {
            total: items.length,
            saved: savedCount,
            errors: errors.length
        }
    });
}

// Restore state on startup
chrome.runtime.onStartup.addListener(async () => {
    const data = await chrome.storage.local.get('downloadState');
    if (data.downloadState) {
        downloadState = data.downloadState;
        console.log('[Background] Restored state:', downloadState);
    }
});

console.log('[Background] TikDown service worker started');
