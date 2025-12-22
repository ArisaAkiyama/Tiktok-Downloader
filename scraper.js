/**
 * TikTok Scraper - Video and Audio Extraction
 * Gets video URL from page data and downloads WITHOUT WATERMARK
 * Supports cookies for bypassing verification
 */

const fs = require('fs');
const path = require('path');
const browserManager = require('./browser-manager');
const rateLimiter = require('./rate-limiter');
const errorRecovery = require('./error-recovery');

const TIMEOUT = parseInt(process.env.TIMEOUT) || 60000;
const DOWNLOAD_DIR = process.env.DOWNLOAD_PATH || path.join(require('os').homedir(), 'Downloads', 'TikTok');
const COOKIES_PATH = path.join(__dirname, 'cookies.json');

// TikTok URL Patterns
const TIKTOK_PATTERNS = {
    video: /tiktok\.com\/@[\w.-]+\/video\/(\d+)/i,
    photo: /tiktok\.com\/@[\w.-]+\/photo\/(\d+)/i,  // Story/Photo posts
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

    try {
        await rateLimiter.waitForSlot();

        page = await browserManager.getPage();
        console.log('⚡ Got page from browser pool');

        // Load cookies if available
        const cookies = loadCookies();
        if (cookies.length > 0) {
            await page.setCookie(...cookies);
            console.log('🍪 Cookies loaded - authenticated mode');
        }

        console.log('Loading:', url);
        await rateLimiter.addJitter(300);

        // Detect if this is a photo/story URL early
        const isPhoto = isPhotoUrl(url);

        // For photo stories, intercept network requests to capture image URLs
        const capturedImageUrls = [];
        if (isPhoto) {
            console.log('📸 Photo story detected - enabling network interception');
            await page.setRequestInterception(true);

            page.on('request', request => {
                request.continue();
            });

            page.on('response', async response => {
                const url = response.url();
                const contentType = response.headers()['content-type'] || '';

                // PRIORITY: Capture photomode images (actual story photos)
                if (url.includes('photomode') && url.includes('tiktokcdn')) {
                    // Extract unique image ID to deduplicate different resolutions
                    // URL format: /tos-alisg-i-photomode-sg/IMAGEID~tplv-photomode-image.jpeg
                    const imageIdMatch = url.match(/photomode-sg\/([a-zA-Z0-9]+)/);
                    const imageId = imageIdMatch ? imageIdMatch[1] : null;

                    // Check if we already have this image (any resolution)
                    const isDuplicate = imageId && capturedImageUrls.some(existingUrl =>
                        existingUrl.includes(imageId)
                    );

                    if (!isDuplicate && !capturedImageUrls.includes(url)) {
                        capturedImageUrls.push(url);
                        console.log(`📷 Photo ${capturedImageUrls.length} captured:`, url.substring(0, 80) + '...');
                    }
                    return;
                }

                // FALLBACK: Capture other CDN images ONLY if no photomode found
                // Use separate array to avoid mixing with photomode images
                if ((url.includes('tiktokcdn') || url.includes('muscdn')) &&
                    (contentType.includes('image') || url.match(/\.(jpg|jpeg|png|webp)/i)) &&
                    !url.includes('photomode')) {  // Skip if already handled by photomode

                    // Exclude patterns for UI elements, logos, audio covers
                    const excludePatterns = [
                        'avatar',      // Profile pictures
                        'avt-',        // Avatar images (tos-alisg-avt)
                        'music',       // Audio/music covers
                        'logo',        // TikTok logo
                        'icon',        // Icons
                        'emoji',       // Emojis
                        'sticker',     // Stickers
                        '100x100',     // Small thumbnails
                        '150x150',     // Small thumbnails
                        '200x200',     // Medium thumbnails
                        'aweme/100',   // Small video covers
                        'aweme/150',   // Small video covers
                        'tos-alisg-p-0037',  // Profile/UI images
                        'tos-alisg-p-0068',  // Other UI images
                    ];

                    const isExcluded = excludePatterns.some(pattern => url.toLowerCase().includes(pattern.toLowerCase()));

                    // Only capture if NOT excluded and NOT already have photomode images
                    if (!isExcluded && capturedImageUrls.length === 0) {
                        capturedImageUrls.push(url);
                        console.log('📷 Fallback image captured:', url.substring(0, 80) + '...');
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
            console.log('⏳ Waiting extra time for story content to load...');
            await delay(3000);
            console.log(`📷 Network captured ${capturedImageUrls.length} image URLs`);
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

                    // Try different data paths for photo vs video
                    let item = data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct;

                    // Alternative path for photos/stories
                    if (!item) {
                        item = data?.['__DEFAULT_SCOPE__']?.['webapp.post-detail']?.itemInfo?.itemStruct;
                    }

                    if (item) {
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
                                for (const img of item.imagePost.images) {
                                    if (img.imageURL?.urlList?.[0]) {
                                        result.imageUrls.push(img.imageURL.urlList[0]);
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
                // Debug: Log ALL images on page
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

        // For photo stories, ALWAYS use network-captured photomode URLs (more accurate)
        // DOM extraction often includes non-photo UI elements
        if (isPhoto && capturedImageUrls.length > 0) {
            // Filter to only keep photomode URLs
            const photomodeOnly = capturedImageUrls.filter(url => url.includes('photomode'));
            if (photomodeOnly.length > 0) {
                console.log(`📷 Using ${photomodeOnly.length} network-captured photomode images (ignoring ${pageData.imageUrls.length} from DOM)`);
                pageData.imageUrls = photomodeOnly;
            }
        } else if (isPhoto && pageData.imageUrls.length === 0 && capturedImageUrls.length > 0) {
            console.log(`📷 Using ${capturedImageUrls.length} network-captured image URLs (fallback)`);
            pageData.imageUrls = capturedImageUrls;
        }

        // CAROUSEL NAVIGATION for photo stories (similar to Instagram implementation)
        if (isPhoto && pageData.imageUrls.length <= 1) {
            // Check for carousel indicators
            const hasCarousel = await page.evaluate(() => {
                const dots = document.querySelectorAll('[class*="DotSlider"] span, [class*="swiper-pagination"] span, [class*="Pagination"] span');
                return dots.length > 1 ? dots.length : 0;
            });

            if (hasCarousel > 1) {
                console.log(`🎠 Carousel detected with ${hasCarousel} slides - navigating...`);

                let slideCount = 0;
                const maxSlides = 20;

                while (slideCount < maxSlides) {
                    // Try to click next button
                    const hasNext = await page.evaluate(() => {
                        const nextBtn = document.querySelector('[class*="SliderArrowRight"], [class*="arrow-right"], button[aria-label*="next" i], button[aria-label*="Next" i], [class*="swiper-button-next"]');
                        if (nextBtn && getComputedStyle(nextBtn).display !== 'none') {
                            nextBtn.click();
                            return true;
                        }
                        return false;
                    });

                    if (!hasNext) {
                        console.log(`🎠 Finished at slide ${slideCount + 1}`);
                        break;
                    }

                    slideCount++;
                    await delay(700); // Wait for slide transition

                    // Check for new images captured
                    const beforeCount = capturedImageUrls.length;
                    await delay(300); // Extra wait for image load

                    console.log(`📷 Slide ${slideCount + 1}/${hasCarousel} - Captured ${capturedImageUrls.length - beforeCount} new image(s) | Total: ${capturedImageUrls.length}`);
                }

                // Update pageData with all captured images
                if (capturedImageUrls.length > pageData.imageUrls.length) {
                    pageData.imageUrls = capturedImageUrls;
                    console.log(`📷 Carousel complete: ${capturedImageUrls.length} total photos captured`);
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
            await browserManager.releasePage(page);

            const username = pageData.username || 'unknown';
            const timestamp = Date.now();
            const photoCount = pageData.imageUrls.length;

            console.log('📷 Content type: PHOTO/CAROUSEL');
            console.log(`📷 Found ${photoCount} photo(s) in ${photoCount > 1 ? 'carousel' : 'story'}`);

            const media = [];

            for (let i = 0; i < pageData.imageUrls.length; i++) {
                const imgUrl = pageData.imageUrls[i];
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
                thumbnail: pageData.thumbnail || pageData.imageUrls[0],
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
