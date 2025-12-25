/**
 * TikTok Scraper - Video and Audio Extraction
 * Gets video URL from page data and downloads WITHOUT WATERMARK
 * Supports cookies for bypassing verification
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const browserManager = require('./browser-manager');
const rateLimiter = require('./rate-limiter');
const errorRecovery = require('./error-recovery');

const TIMEOUT = parseInt(process.env.TIMEOUT) || 60000;
const DOWNLOAD_DIR = process.env.DOWNLOAD_PATH || path.join(require('os').homedir(), 'Downloads', 'TikTok');
const COOKIES_PATH = path.join(__dirname, 'cookies.json');

// TikTok URL Patterns
const TIKTOK_PATTERNS = {
    video: /tiktok\.com\/@[\w.-]+\/video\/(\d+)/i,
    photo: /tiktok\.com\/@[\w.-]+\/photo\/(\d+)/i,  // Photo carousel posts
    short: /vm\.tiktok\.com\/(\w+)/i,
    mobile: /m\.tiktok\.com\/v\/(\d+)/i,
    webapp: /tiktok\.com\/t\/(\w+)/i,
    videoAlt: /tiktok\.com\/.*\/video\/(\d+)/i
};

function isValidTikTokUrl(url) {
    return Object.values(TIKTOK_PATTERNS).some(pattern => pattern.test(url));
}

function isPhotoUrl(url) {
    return TIKTOK_PATTERNS.photo.test(url);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeUrl(url) {
    if (!url) return null;
    return url
        .replace(/\\u002F/g, '/')
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/')
        .replace(/\\/g, '');
}

/**
 * Load cookies from file
 */
function loadCookies() {
    try {
        if (fs.existsSync(COOKIES_PATH)) {
            const rawCookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
            if (Array.isArray(rawCookies) && rawCookies.length > 0) {
                // Check for valid session cookie
                const sessionCookie = rawCookies.find(c =>
                    c.name === 'sessionid' || c.name === 'sid_tt' || c.name === 'tt_chain_token'
                );
                if (sessionCookie && !sessionCookie.value.includes('YOUR_')) {
                    // Format cookies for Puppeteer
                    const cookies = rawCookies.map(c => {
                        // Fix sameSite values for Puppeteer
                        let sameSite = 'Lax';
                        if (c.sameSite === 'no_restriction' || c.sameSite === 'None') {
                            sameSite = 'None';
                        } else if (c.sameSite === 'strict' || c.sameSite === 'Strict') {
                            sameSite = 'Strict';
                        }

                        return {
                            name: c.name,
                            value: c.value,
                            domain: c.domain || '.tiktok.com',
                            path: c.path || '/',
                            secure: c.secure !== false,
                            httpOnly: c.httpOnly || false,
                            sameSite
                        };
                    });

                    console.log(`✅ Valid TikTok cookies found (${cookies.length} cookies)`);
                    console.log(`   Session: ${sessionCookie.name}=${sessionCookie.value.substring(0, 20)}...`);
                    return cookies;
                }
            }
        }
    } catch (e) {
        console.error('Cookie error:', e.message);
    }
    console.log('⚠️ No valid cookies found - using anonymous mode');
    return [];
}

/**
 * Download video using page context (same cookies/session)
 */
async function downloadVideoInContext(page, videoUrl) {
    console.log('📥 Downloading video from:', videoUrl.substring(0, 80) + '...');

    try {
        const buffer = await page.evaluate(async (url) => {
            try {
                const response = await fetch(url, {
                    credentials: 'include',
                    headers: {
                        'Accept': '*/*',
                        'Range': 'bytes=0-'
                    }
                });

                if (!response.ok) return null;

                const arrayBuffer = await response.arrayBuffer();
                return Array.from(new Uint8Array(arrayBuffer));
            } catch (e) {
                return null;
            }
        }, videoUrl);

        if (buffer && buffer.length > 50000) {
            return Buffer.from(buffer);
        }
    } catch (e) {
        console.log('Context download failed:', e.message);
    }

    return null;
}

/**
 * Extract carousel photos from TikTok page
 * TikTok moved data out of __UNIVERSAL_DATA_FOR_REHYDRATION__
 * Now we search ALL script tags for imagePost data
 */
async function extractCarouselPhotos(page) {
    console.log('📷 Extracting carousel photos...');

    const result = await page.evaluate(() => {
        const photos = [];
        const seenIds = new Set();
        const debug = { method: null };

        // Helper: Get unique image ID from URL
        const getImageId = (url) => {
            // Pattern: /[HEXID]~ or /[HEXID]/
            const match = url.match(/\/([a-fA-F0-9]{16,})(?:~|\/|$)/);
            return match ? match[1] : url;
        };

        // Helper: Check if URL is CAROUSEL photo (not avatar/icon)
        const isCarouselPhoto = (url) => {
            if (!url) return false;
            const lower = url.toLowerCase();
            // Must be TikTok CDN
            if (!lower.includes('tiktokcdn')) return false;
            // MUST NOT be avatar (avt-XXXX pattern)
            if (lower.includes('-avt-') || lower.includes('/avt-') || lower.includes('avatar')) return false;
            // Must NOT be small sizes
            if (lower.includes('100x100') || lower.includes('150x150') || lower.includes('192x192')) return false;
            // Should contain photomode or image content patterns
            return lower.includes('photomode') ||
                lower.includes('-i-') ||      // tos-alisg-i- = image content
                lower.includes('-p-') ||      // tos-alisg-p- = photo content
                lower.includes('/obj/');      // object storage
        };

        // METHOD 1: Search ALL scripts for imagePost JSON
        try {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const content = script.textContent || '';

                // Skip small scripts
                if (content.length < 1000) continue;

                // Look for imagePost pattern
                if (content.includes('"imagePost"') || content.includes('"imageURL"')) {
                    console.log('[DEBUG] Found script with imagePost pattern');

                    // Try to extract imagePost JSON
                    // Pattern: "imagePost":{"images":[...]}
                    const imagePostMatch = content.match(/"imagePost"\s*:\s*(\{[^}]*"images"\s*:\s*\[[^\]]*\][^}]*\})/);
                    if (imagePostMatch) {
                        try {
                            // This is tricky - the JSON might be nested
                            // Look for urlList patterns instead
                            const urlMatches = content.match(/https:\\u002F\\u002F[^"]+(?:photomode|tos-[a-z]+-[ip]-)[^"]+/g) || [];

                            for (const match of urlMatches) {
                                // Decode URL
                                const url = match
                                    .replace(/\\u002F/g, '/')
                                    .replace(/\\u0026/g, '&')
                                    .replace(/\\/g, '');

                                if (isCarouselPhoto(url)) {
                                    const imgId = getImageId(url);
                                    if (!seenIds.has(imgId)) {
                                        seenIds.add(imgId);
                                        photos.push(url);
                                        console.log('[DEBUG] Found carousel photo:', url.substring(0, 60));
                                    }
                                }
                            }

                            if (photos.length > 0) {
                                debug.method = 'script-regex';
                                break;
                            }
                        } catch (e) {
                            console.log('[DEBUG] Parse error:', e.message);
                        }
                    }
                }
            }
        } catch (e) {
            console.log('[DEBUG] Script search error:', e.message);
        }

        // METHOD 2: Try SIGI_STATE
        if (photos.length === 0) {
            try {
                const sigiScript = document.getElementById('SIGI_STATE');
                if (sigiScript) {
                    console.log('[DEBUG] Found SIGI_STATE');
                    const data = JSON.parse(sigiScript.textContent);
                    const itemModule = data?.ItemModule;

                    if (itemModule) {
                        for (const key of Object.keys(itemModule)) {
                            const item = itemModule[key];
                            if (item?.imagePost?.images) {
                                console.log('[DEBUG] Found imagePost in SIGI_STATE, images:', item.imagePost.images.length);
                                for (const img of item.imagePost.images) {
                                    const urlList = img.imageURL?.urlList || [];
                                    if (urlList.length > 0) {
                                        const url = urlList[0];
                                        if (isCarouselPhoto(url)) {
                                            const imgId = getImageId(url);
                                            if (!seenIds.has(imgId)) {
                                                seenIds.add(imgId);
                                                photos.push(url);
                                            }
                                        }
                                    }
                                }
                                debug.method = 'SIGI_STATE';
                                break;
                            }
                        }
                    }
                }
            } catch (e) {
                console.log('[DEBUG] SIGI_STATE error:', e.message);
            }
        }

        // METHOD 3: Get visible large images from DOM (last resort)
        if (photos.length === 0) {
            console.log('[DEBUG] Trying DOM extraction...');
            const imgs = document.querySelectorAll('img');
            for (const img of imgs) {
                const src = img.src;
                if (!src) continue;

                const width = Math.max(img.naturalWidth || 0, img.width || 0);
                const height = Math.max(img.naturalHeight || 0, img.height || 0);

                // Must be large (main carousel images are big)
                if (width < 300 && height < 300) continue;

                if (isCarouselPhoto(src)) {
                    const imgId = getImageId(src);
                    if (!seenIds.has(imgId)) {
                        seenIds.add(imgId);
                        photos.push(src);
                        console.log('[DEBUG] DOM found large image:', src.substring(0, 60));
                    }
                }
            }
            if (photos.length > 0) {
                debug.method = 'DOM';
            }
        }

        debug.count = photos.length;
        return { photos, debug };
    });

    console.log(`📷 Found ${result.photos.length} carousel photos (method: ${result.debug?.method || 'none'})`);
    return result;
}

/**
 * Main scraper function
 */
async function scrapeTikTokVideo(url) {
    if (!isValidTikTokUrl(url)) {
        return {
            success: false,
            error: 'Invalid URL. Please enter a valid TikTok video URL.',
            code: 'INVALID_URL'
        };
    }

    console.log('Processing TikTok URL:', url);

    let page = null;
    let directBrowser = null;  // For photo stories, we launch a fresh browser

    // Detect if this is a photo/story URL early
    const isPhoto = isPhotoUrl(url);

    try {
        await rateLimiter.waitForSlot();

        if (isPhoto) {
            // PHOTO STORIES: Launch fresh browser to avoid caching issues
            console.log('📸 Photo story - launching fresh browser for request interception');
            directBrowser = await puppeteer.launch({
                headless: process.env.HEADLESS !== 'false' ? 'new' : false,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            page = await directBrowser.newPage();
            await page.setViewport({ width: 1280, height: 800 });
        } else {
            // VIDEOS: Use browser pool as normal
            page = await browserManager.getPage();
            console.log('⚡ Got page from browser pool');
        }

        // Load cookies if available
        const cookies = loadCookies();
        if (cookies.length > 0) {
            await page.setCookie(...cookies);
            console.log('🍪 Cookies loaded - authenticated mode');
        }

        console.log('Loading:', url);
        await rateLimiter.addJitter(300);

        // For photo stories, intercept network requests to capture image URLs
        const capturedImageUrls = [];
        if (isPhoto) {
            console.log('📸 Photo story detected - enabling network interception');

            // Disable cache to ensure images are fetched fresh (fixes browser pool caching)
            await page.setCacheEnabled(false);

            await page.setRequestInterception(true);

            page.on('request', request => {
                const url = request.url();
                const resourceType = request.resourceType();

                // Intercept image requests from TikTok CDN
                if (resourceType === 'image' &&
                    (url.includes('tiktokcdn') || url.includes('muscdn'))) {

                    // Check if this is a carousel photo (photomode)
                    const lower = url.toLowerCase();

                    // ONLY capture photomode images (actual carousel photos)
                    const isPhotomode = lower.includes('photomode') ||
                        lower.includes('-i-photomode');

                    if (isPhotomode) {
                        const isDuplicate = capturedImageUrls.some(existing =>
                            existing === url || existing.includes(url.split('/').pop().split('?')[0])
                        );

                        if (!isDuplicate) {
                            capturedImageUrls.push(url);
                            console.log(`📷 Captured photo ${capturedImageUrls.length}:`, url.substring(0, 70) + '...');
                        }
                    }
                }

                request.continue();
            });

            page.on('response', async response => {
                const url = response.url();
                const contentType = response.headers()['content-type'] || '';
                const lower = url.toLowerCase();

                // Skip non-TikTok CDN
                if (!lower.includes('tiktokcdn') && !lower.includes('muscdn')) return;

                // Must be an image
                if (!contentType.includes('image') && !lower.match(/\.(jpg|jpeg|png|webp)/)) return;

                // MUST EXCLUDE: avatars, icons, thumbnails, PWA assets
                const excludePatterns = [
                    '-avt-',       // Avatar images
                    '/avatar/',    // Avatar path
                    'pwa/',        // PWA icons
                    'eden-sg',     // PWA/app icons
                    'login_static',// Login UI
                    '-p-0037',     // UI pattern
                    '-p-0068',     // UI pattern
                ];
                if (excludePatterns.some(p => lower.includes(p))) return;

                // INCLUDE: Large images from CDN (carousel photos)
                // Pattern 1: /obj/ path (object storage)
                // Pattern 2: Long hex hash in URL (like 88e2522d81156aa59)
                // Pattern 3: photomode, tos-*-i- patterns
                const isCarouselPhoto =
                    lower.includes('/obj/') ||
                    lower.includes('photomode') ||
                    /tos-[a-z]+-i-/.test(lower) ||
                    /\/[a-f0-9]{16,}/.test(lower);  // hex hash pattern

                if (isCarouselPhoto) {
                    // Extract unique ID for deduplication
                    const idMatch = url.match(/\/([a-fA-F0-9]{16,})/) || url.match(/\/([^\/]+)\.(jpg|jpeg|png|webp)/);
                    const imageId = idMatch ? idMatch[1] : url.substring(0, 100);

                    // Check if already captured
                    const isDuplicate = capturedImageUrls.some(existing => {
                        const existingMatch = existing.match(/\/([a-fA-F0-9]{16,})/) || existing.match(/\/([^\/]+)\.(jpg|jpeg|png|webp)/);
                        return existingMatch && existingMatch[1] === imageId;
                    });

                    if (!isDuplicate) {
                        capturedImageUrls.push(url);
                        console.log(`📷 Captured photo ${capturedImageUrls.length}:`, url.substring(0, 70) + '...');
                    }
                }
            });
        }

        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: TIMEOUT
        });

        await delay(3000);

        console.log(`Content type: ${isPhoto ? 'PHOTO/STORY' : 'VIDEO'}`);

        // Wait longer for photo stories (they often load slower)
        if (isPhoto) {
            console.log('⏳ Waiting for story content to load...');
            await delay(5000);  // Increased from 3s to 5s for carousel to fully render

            // DOM-BASED CAROUSEL CAPTURE
            // Look for images with photomode pattern in DOM
            console.log('📷 Extracting carousel photos from DOM...');

            const domPhotos = await page.evaluate(() => {
                const photos = [];
                const seenUrls = new Set();

                document.querySelectorAll('img').forEach(img => {
                    if (!img.src) return;
                    const lower = img.src.toLowerCase();

                    // Skip data URLs
                    if (lower.startsWith('data:')) return;

                    // Skip non-TikTok CDN
                    if (!lower.includes('tiktokcdn')) return;

                    // Skip avatars
                    if (lower.includes('-avt-') || lower.includes('/avatar/')) return;

                    // Get dimensions
                    const rect = img.getBoundingClientRect();

                    // ONLY capture photomode images (actual carousel photos)
                    const isPhotomode = lower.includes('photomode') ||
                        lower.includes('-i-photomode');

                    if (!isPhotomode) return;

                    // Accept any visible image (min 100x100)
                    if (rect.width < 100 || rect.height < 100) return;

                    // Extract unique ID from URL for dedup
                    const idMatch = img.src.match(/\/([a-f0-9]{32,})(?:~|\/)/i);
                    const uniqueId = idMatch ? idMatch[1] : img.src;

                    if (!seenUrls.has(uniqueId)) {
                        seenUrls.add(uniqueId);
                        photos.push({
                            src: img.src,
                            width: rect.width,
                            height: rect.height
                        });
                    }
                });

                return photos;
            });

            console.log(`📷 Found ${domPhotos.length} carousel photos in DOM`);

            for (const photo of domPhotos) {
                if (!capturedImageUrls.includes(photo.src)) {
                    capturedImageUrls.push(photo.src);
                    console.log(`   ✅ ${photo.width}x${photo.height}: ${photo.src.substring(0, 60)}...`);
                }
            }

            console.log(`📷 Total captured: ${capturedImageUrls.length} photos`);

            // If we captured images, use them!
            if (capturedImageUrls.length > 0) {
                console.log('✅ Using captured carousel images');
            }
        }

        // Extract data from page
        const pageData = await page.evaluate((isPhotoPost) => {
            const result = {
                videoUrls: [],
                imageUrls: [],  // For photo posts
                username: null,
                caption: null,
                thumbnail: null,
                stats: {},
                videoId: null,
                isPhoto: isPhotoPost,
                debug: {} // Debug info
            };

            // Get ID from URL
            const urlMatch = window.location.href.match(/(video|photo)\/(\d+)/);
            if (urlMatch) result.videoId = urlMatch[2];

            const scriptEl = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (scriptEl) {
                try {
                    const data = JSON.parse(scriptEl.textContent);
                    const defaultScope = data?.['__DEFAULT_SCOPE__'];

                    // Log available keys for debugging
                    result.debug.availableKeys = defaultScope ? Object.keys(defaultScope) : [];

                    // Try different data paths for photo vs video
                    let item = defaultScope?.['webapp.video-detail']?.itemInfo?.itemStruct;

                    // Alternative path for photos/stories
                    if (!item) {
                        item = defaultScope?.['webapp.post-detail']?.itemInfo?.itemStruct;
                    }

                    // Search through ALL keys if still not found
                    if (!item && defaultScope) {
                        for (const key of Object.keys(defaultScope)) {
                            const scopeData = defaultScope[key];
                            if (scopeData?.itemInfo?.itemStruct) {
                                item = scopeData.itemInfo.itemStruct;
                                result.debug.foundItemIn = key;
                                break;
                            }
                            if (scopeData?.itemStruct) {
                                item = scopeData.itemStruct;
                                result.debug.foundItemIn = key;
                                break;
                            }
                        }
                    }

                    if (item) {
                        result.debug.hasItem = true;
                        result.username = item.author?.uniqueId || item.author?.nickname;
                        result.caption = item.desc;
                        result.stats = {
                            likes: item.stats?.diggCount || 0,
                            comments: item.stats?.commentCount || 0,
                            shares: item.stats?.shareCount || 0,
                            plays: item.stats?.playCount || 0
                        };

                        // Photo/Image extraction
                        if (isPhotoPost || item.imagePost) {
                            // Image carousel/slideshow
                            if (item.imagePost?.images) {
                                result.debug.imagePostCount = item.imagePost.images.length;
                                for (const img of item.imagePost.images) {
                                    if (img.imageURL?.urlList && img.imageURL.urlList.length > 0) {
                                        // Get highest quality URL (usually first), but filter out avatars
                                        const url = img.imageURL.urlList[0];
                                        const lowerUrl = url.toLowerCase();

                                        // Skip avatar/profile images 
                                        if (lowerUrl.includes('avt-') ||
                                            lowerUrl.includes('avatar') ||
                                            lowerUrl.includes('-avt-')) {
                                            result.debug.avatarSkipped = (result.debug.avatarSkipped || 0) + 1;
                                            continue;
                                        }

                                        result.imageUrls.push(url);
                                    }
                                }
                            }

                            // Single image cover
                            if (item.imagePost?.cover?.urlList?.[0]) {
                                result.thumbnail = item.imagePost.cover.urlList[0];
                            }

                            // Fallback: look for any image data
                            if (result.imageUrls.length === 0 && item.video?.cover) {
                                result.thumbnail = item.video.cover;
                            }
                        }

                        // Video extraction (existing logic)
                        if (!isPhotoPost) {
                            result.thumbnail = item.video?.cover || item.video?.originCover;

                            // Priority 1: bitrateInfo - best quality WITHOUT watermark
                            if (item.video?.bitrateInfo && item.video.bitrateInfo.length > 0) {
                                const sorted = [...item.video.bitrateInfo].sort((a, b) =>
                                    (b.Bitrate || 0) - (a.Bitrate || 0)
                                );
                                for (const br of sorted) {
                                    if (br.PlayAddr?.UrlList && br.PlayAddr.UrlList.length > 0) {
                                        result.videoUrls.push(...br.PlayAddr.UrlList);
                                    }
                                }
                            }

                            // Priority 2: playAddr - usually no watermark
                            if (item.video?.playAddr) {
                                result.videoUrls.push(item.video.playAddr);
                            }
                        }
                    }
                } catch (e) {
                    result.debug.parseError = e.message;
                }
            } else {
                result.debug.noScriptEl = true;
            }

            // Collect debug info
            result.debug.pageTitle = document.title;
            result.debug.totalImgs = document.querySelectorAll('img').length;
            result.debug.totalVideos = document.querySelectorAll('video').length;
            // More accurate login wall detection - check for actual login modal
            result.debug.hasLoginWall = document.querySelector('[class*="LoginModal"]') !== null ||
                document.querySelector('[data-e2e="login-modal"]') !== null;
            result.debug.pageContainsPhoto = document.body.innerHTML.includes('photo');

            // Fallback: get images from page (for photos)
            if (isPhotoPost && result.imageUrls.length === 0) {
                // METHOD 1: Extract from raw script content (photomode URLs)
                const scripts = document.querySelectorAll('script');
                for (const script of scripts) {
                    const content = script.textContent || '';
                    if (content.includes('imagePost') || content.includes('photomode') || content.includes('imageURL')) {
                        // Look for escaped URLs in JSON
                        const urlMatches = content.match(/https:\\u002F\\u002F[^"]+(?:photomode|tos-)[^"]+/g) || [];
                        for (const match of urlMatches) {
                            const cleanUrl = match
                                .replace(/\\u002F/g, '/')
                                .replace(/\\u0026/g, '&')
                                .replace(/\\/g, '');
                            if (!cleanUrl.includes('avatar') &&
                                !cleanUrl.includes('avt-') &&
                                !cleanUrl.includes('music') &&
                                !cleanUrl.includes('logo') &&
                                !result.imageUrls.includes(cleanUrl)) {
                                result.imageUrls.push(cleanUrl);
                            }
                        }

                        // Also try unescaped URLs
                        const directMatches = content.match(/https:\/\/[^"'\s]+(?:photomode|tos-maliva|tos-alisg)[^"'\s]+/g) || [];
                        for (const match of directMatches) {
                            if (!match.includes('avatar') &&
                                !match.includes('avt-') &&
                                !result.imageUrls.includes(match)) {
                                result.imageUrls.push(match);
                            }
                        }
                    }
                }

                result.debug.rawExtractedCount = result.imageUrls.length;

                // METHOD 2: Debug - Log ALL images on page
                const allImgs = document.querySelectorAll('img');
                const allImgData = [];
                const candidates = [];

                allImgs.forEach(img => {
                    const width = img.naturalWidth || img.width || 0;
                    const height = img.naturalHeight || img.height || 0;
                    const src = img.src || img.currentSrc || '';

                    // Log all images for debugging
                    allImgData.push({
                        src: src.substring(0, 100),
                        width,
                        height
                    });

                    // Very lenient filter: any image > 50px that's not obviously an icon
                    if (src &&
                        (width > 50 || height > 50) &&
                        !src.includes('avatar') &&
                        !src.includes('profile') &&
                        !src.includes('emoji') &&
                        !src.includes('data:image') &&
                        !src.includes('svg')) {
                        candidates.push({
                            src,
                            width,
                            height
                        });
                    }
                });

                result.debug.allImages = allImgData;

                // Sort by size (largest first) and add to results
                candidates.sort((a, b) => (b.width * b.height) - (a.width * a.height));
                candidates.forEach(c => {
                    if (!result.imageUrls.includes(c.src)) {
                        result.imageUrls.push(c.src);
                    }
                });

                result.debug.candidateImgs = candidates.length;

                // Method 2: Look for background images in CSS
                if (result.imageUrls.length === 0) {
                    const elements = document.querySelectorAll('[style*="background-image"]');
                    elements.forEach(el => {
                        const style = el.getAttribute('style');
                        const match = style.match(/url\(['"]*([^'")]+)['"]*\)/);
                        if (match && match[1] &&
                            (match[1].includes('tiktokcdn') || match[1].includes('muscdn'))) {
                            result.imageUrls.push(match[1]);
                        }
                    });
                }

                // Method 3: Check for video (TikTok renders photo stories as video!)
                const videoEl = document.querySelector('video');
                result.debug.hasVideoEl = !!videoEl;

                if (videoEl) {
                    const videoSrc = videoEl.src || '';
                    const sourceSrc = videoEl.querySelector('source')?.src || '';
                    result.debug.videoSrc = videoSrc.substring(0, 100);
                    result.debug.sourceSrc = sourceSrc.substring(0, 100);

                    // For photo stories, always try to get the video (it's likely the photo content)
                    const actualSrc = videoSrc || sourceSrc;
                    if (actualSrc && !actualSrc.includes('blob:')) {
                        result.videoUrls.push(actualSrc);
                        result.isActuallyVideo = true;
                        result.debug.usingVideoAsPhoto = true;
                    }
                }
            }

            // Fallback: get from video element
            if (!isPhotoPost) {
                const videoEl = document.querySelector('video');
                if (videoEl && videoEl.src && !result.videoUrls.includes(videoEl.src)) {
                    result.videoUrls.unshift(videoEl.src);
                }
            }

            if (!result.username) {
                const nameMatch = window.location.href.match(/@([\w.-]+)/);
                if (nameMatch) result.username = nameMatch[1];
            }

            return result;
        }, isPhoto);

        console.log(`Found ${pageData.imageUrls.length} images, ${pageData.videoUrls.length} videos for ID: ${pageData.videoId}`);


        // ========== PHOTO CAROUSEL EXTRACTION ==========
        // For photo posts, use extractCarouselPhotos (gets from JSON data)
        if (isPhoto) {
            console.log('📸 Photo post detected - extracting carousel photos...');

            // PRIORITY 1: Use captured photomode images from network interception
            if (capturedImageUrls.length > 0) {
                pageData.imageUrls = capturedImageUrls;
                console.log(`📷 Using ${capturedImageUrls.length} photos from network capture`);
            } else {
                // PRIORITY 2: Try extractCarouselPhotos
                const carouselResult = await extractCarouselPhotos(page);

                if (carouselResult.photos && carouselResult.photos.length > 0) {
                    pageData.imageUrls = carouselResult.photos;
                    if (carouselResult.username) pageData.username = carouselResult.username;
                    if (carouselResult.caption) pageData.caption = carouselResult.caption;
                    if (carouselResult.thumbnail) pageData.thumbnail = carouselResult.thumbnail;
                    console.log(`📷 Extracted ${carouselResult.photos.length} carousel photos from JSON`);
                } else {
                    console.log('⚠️ No carousel photos found');
                }
            }
        }

        // Photo story minimal logging
        if (isPhoto) {
            if (pageData.debug.hasLoginWall) {
                console.log('⚠️ Login wall detected - cookies may not be working');
            }
        }

        // Check for captcha
        const html = await page.content();

        // Handle PHOTO posts (with images)
        if (isPhoto && pageData.imageUrls.length > 0) {
            // Close browser - either direct browser for photos or release to pool
            if (directBrowser) {
                await directBrowser.close();
                console.log('🔒 Direct browser closed');
            } else {
                await browserManager.releasePage(page);
            }

            const username = pageData.username || 'unknown';
            const timestamp = Date.now();

            // DEDUPLICATE by image ID - extract unique image identifier from URL
            const deduplicateByImageId = (urls) => {
                const seenIds = new Set();
                return urls.filter(url => {
                    // Extract image ID from URL patterns like:
                    // tos-alisg-avt-0068/88e2522d81156aa59... -> 88e2522d81156aa59
                    // photomode-sg/7cad0d2fbdfb01c95... -> 7cad0d2fbdfb01c95
                    let imageId = null;

                    // Pattern 1: tos-xxx-xxx/[ID]~
                    const match1 = url.match(/tos-[^/]+\/([a-fA-F0-9]{20,})(?:~|\/|$)/);
                    if (match1) imageId = match1[1];

                    // Pattern 2: photomode-sg/[ID]~
                    if (!imageId) {
                        const match2 = url.match(/photomode-[^/]+\/([a-zA-Z0-9]+)(?:~|\/|$)/);
                        if (match2) imageId = match2[1];
                    }

                    // Pattern 3: obj/[ID].ext
                    if (!imageId) {
                        const match3 = url.match(/obj\/([a-zA-Z0-9_-]+)\.(jpg|jpeg|png|webp)/i);
                        if (match3) imageId = match3[1];
                    }

                    // Fallback: use full URL
                    if (!imageId) imageId = url;

                    if (seenIds.has(imageId)) {
                        console.log(`   🔄 Skipping duplicate: ${imageId.substring(0, 20)}...`);
                        return false;
                    }
                    seenIds.add(imageId);
                    return true;
                });
            };

            const uniquePhotos = deduplicateByImageId(pageData.imageUrls);

            // CRITICAL: Filter out AVATARS - they contain -avt- pattern
            const carouselPhotos = uniquePhotos.filter(url => {
                // DATA URLs are valid (base64 encoded images)
                if (url.startsWith('data:image')) {
                    return true;
                }

                const lower = url.toLowerCase();
                // MUST NOT be avatar (contains -avt- or /avatar/)
                if (lower.includes('-avt-') || lower.includes('/avatar/')) {
                    return false;
                }
                // Should be content image (photomode, -i-, or -p- pattern)
                const isContentImage = lower.includes('photomode') ||
                    lower.includes('-i-') ||
                    lower.includes('-p-') ||
                    lower.includes('/obj/');
                if (!isContentImage) {
                    return false;
                }
                return true;
            });

            const photoCount = carouselPhotos.length;

            console.log('📷 Content type: PHOTO/CAROUSEL');
            console.log(`📷 Found ${photoCount} unique photo(s) (from ${pageData.imageUrls.length} total URLs)`);

            const media = [];

            for (let i = 0; i < carouselPhotos.length; i++) {
                const imgUrl = carouselPhotos[i];
                const filename = `${username}_${timestamp}_${i + 1}.jpg`;

                console.log(`🔽 Processing photo ${i + 1}/${photoCount}: ${imgUrl.substring(0, 70)}...`);

                media.push({
                    type: 'image',
                    url: imgUrl,
                    thumbnail: imgUrl,
                    filename: filename,
                    hasWatermark: false
                });

                console.log(`✅ Ready: ${filename}`);
            }

            console.log(`📦 Successfully extracted ${media.length} photo(s) from @${username}`);

            return {
                success: true,
                media,
                count: media.length,
                username,
                caption: pageData.caption,
                stats: pageData.stats,
                thumbnail: pageData.thumbnail || carouselPhotos[0],
                downloadPath: DOWNLOAD_DIR,
                isPhoto: true
            };
        }

        // Handle "photo" URLs that are actually videos (TikTok sometimes uses /photo/ for video stories)
        if (isPhoto && pageData.isActuallyVideo && pageData.videoUrls.length > 0) {
            console.log('📹 Photo story is actually a video, downloading as video...');
            // Continue to video download logic below
        }

        // Check for captcha (only for video if no content found)
        if (pageData.videoUrls.length === 0 && pageData.imageUrls.length === 0 &&
            (html.includes('captcha') || html.includes('Verify to continue'))) {
            await browserManager.releasePage(page);

            // Suggest using cookies
            return {
                success: false,
                error: 'TikTok requires verification. Add cookies.json with your TikTok session cookies.',
                code: 'CAPTCHA',
                hint: 'Export your TikTok cookies using a browser extension and save to cookies.json'
            };
        }

        // Try to download video from extracted URLs
        let videoBuffer = null;

        for (const videoUrl of pageData.videoUrls) {
            const decodedUrl = decodeUrl(videoUrl);
            if (!decodedUrl) continue;

            console.log('Trying URL:', decodedUrl.substring(0, 60) + '...');

            videoBuffer = await downloadVideoInContext(page, decodedUrl);

            if (videoBuffer && videoBuffer.length > 100000) {
                console.log(`✅ Downloaded: ${Math.round(videoBuffer.length / 1024)}KB (no watermark)`);
                break;
            }
        }

        await browserManager.releasePage(page);

        // Process result
        if (videoBuffer && videoBuffer.length > 50000) {
            const username = pageData.username || 'unknown';
            const timestamp = Date.now();
            const videoFilename = `${username}_${timestamp}.mp4`;

            global.capturedBuffers = global.capturedBuffers || {};
            global.capturedBuffers[videoFilename] = videoBuffer;

            const media = [{
                type: 'video',
                size: videoBuffer.length,
                thumbnail: pageData.thumbnail,
                filename: videoFilename,
                hasCapturedBuffer: true,
                hasWatermark: false
            }];

            console.log(`✅ Ready: ${videoFilename} (${Math.round(videoBuffer.length / 1024)}KB)`);

            return {
                success: true,
                media,
                count: media.length,
                username: pageData.username || 'unknown',
                caption: pageData.caption,
                stats: pageData.stats,
                thumbnail: pageData.thumbnail,
                downloadPath: DOWNLOAD_DIR
            };
        }

        return {
            success: false,
            error: isPhoto ? 'Could not find photo/story images. The story may have expired.' : 'Could not download video. TikTok may be blocking or video is protected.',
            code: 'DOWNLOAD_FAILED',
            username: pageData.username,
            thumbnail: pageData.thumbnail
        };

    } catch (error) {
        console.error('Scrape error:', error.message);
        if (page) await browserManager.releasePage(page);
        return {
            success: false,
            error: error.message || 'Scraping failed',
            code: 'SCRAPE_ERROR'
        };
    }
}

/**
 * Save captured buffer to file
 */
function saveCapturedBuffer(filename, username) {
    const buffer = global.capturedBuffers?.[filename];
    if (!buffer) {
        return { success: false, error: 'Buffer not found. Please scrape the video again.' };
    }

    const userFolder = path.join(DOWNLOAD_DIR, username);
    if (!fs.existsSync(userFolder)) {
        fs.mkdirSync(userFolder, { recursive: true });
    }

    const filePath = path.join(userFolder, filename);

    if (fs.existsSync(filePath)) {
        console.log(`⚠️ File already exists: ${filename}`);
        return {
            success: true,
            path: filePath,
            size: buffer.length,
            message: 'File already exists'
        };
    }

    fs.writeFileSync(filePath, buffer);

    console.log(`✅ Saved: ${filename} (${Math.round(buffer.length / 1024)}KB)`);

    return {
        success: true,
        path: filePath,
        size: buffer.length
    };
}

/**
 * Get captured buffer for download
 */
function getCapturedBuffer(filename) {
    return global.capturedBuffers?.[filename] || null;
}

/**
 * Check if cookies are available
 */
function hasCookies() {
    return loadCookies().length > 0;
}

module.exports = {
    scrapeTikTokVideo,
    isValidTikTokUrl,
    saveCapturedBuffer,
    getCapturedBuffer,
    hasCookies
};
