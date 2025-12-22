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
    error: null
};

// Track last processed URL for cache invalidation
let lastProcessedUrl = null;

/**
 * Clear badge and reset state
 */
function clearBadgeAndState() {
    downloadState = {
        isProcessing: false,
        url: null,
        media: null,
        username: null,
        error: null
    };
    lastProcessedUrl = null;
    chrome.action.setBadgeText({ text: '' });
    console.log('[Background] State cleared due to URL change');
}

/**
 * Listen for tab updates (URL changes, refreshes, navigation)
 * Clears badge and state whenever URL changes or page reloads
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Clear on ANY URL change if we have cached media
    if (changeInfo.url && downloadState.media) {
        console.log('[Background] URL changed to:', changeInfo.url.substring(0, 50));
        clearBadgeAndState();
    }

    // Clear on page reload/navigation start if we have cached media
    if (changeInfo.status === 'loading' && downloadState.media) {
        clearBadgeAndState();
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
        downloadState = {
            isProcessing: false,
            url: null,
            media: null,
            username: null,
            error: null
        };
        // Clear badge when starting new download
        chrome.action.setBadgeText({ text: '' });
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
        // For photo URLs, try to extract from current page first (bypasses server for private accounts)
        if (isPhotoUrl) {
            console.log('[Background] Photo URL detected, trying current page extraction...');
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]) {
                try {
                    const pageData = await chrome.tabs.sendMessage(tabs[0].id, { action: 'extractFromPage' });

                    if (pageData?.success && pageData.data?.images?.length > 0) {
                        console.log('[Background] Extracted', pageData.data.images.length, 'images from current page');

                        // Convert images to media format
                        const media = pageData.data.images.map((img, index) => ({
                            type: 'image',
                            url: img.url,
                            thumbnail: img.url,
                            filename: `${pageData.data.username || 'photo'}_${Date.now()}_${index + 1}.jpg`,
                            hasWatermark: false
                        }));

                        // Also add audios if present
                        if (pageData.data.audios && pageData.data.audios.length > 0) {
                            pageData.data.audios.forEach(audio => {
                                media.push({
                                    type: 'audio',
                                    url: audio.url,
                                    title: audio.title,
                                    filename: `${pageData.data.username || 'audio'}_${Date.now()}.mp3`,
                                    hasWatermark: false
                                });
                            });
                        }

                        downloadState = {
                            isProcessing: false,
                            url: url,
                            media: media,
                            username: pageData.data.username || 'unknown',
                            caption: pageData.data.caption || '',
                            thumbnail: media[0]?.url,
                            error: null,
                            isPhoto: true
                        };

                        await chrome.storage.local.set({ downloadState });
                        chrome.action.setBadgeText({ text: String(media.length) });
                        chrome.action.setBadgeBackgroundColor({ color: '#25F4EE' }); // TikTok cyan for photos

                        // Track URL for cache invalidation
                        lastProcessedUrl = url;

                        console.log('[Background] Photo extraction complete:', media.length, 'items (images + audios)');
                        return; // Skip server call
                    }
                } catch (e) {
                    console.log('[Background] Current page extraction failed:', e.message);
                }
            }
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

            // Track URL for cache invalidation
            lastProcessedUrl = url;

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
