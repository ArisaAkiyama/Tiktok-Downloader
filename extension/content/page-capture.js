/**
 * TikDown - Content Script for Page Capture
 * Captures video data directly from TikTok page
 * Auto-syncs cookies to server on TikTok visit
 */

(function () {
    'use strict';

    // Only run on TikTok pages
    if (!window.location.href.includes('tiktok.com')) return;

    console.log('[TikDown] Content script loaded');

    /**
     * Auto-sync cookies to server when visiting TikTok
     */
    async function autoSyncCookies() {
        try {
            // Get settings
            const result = await chrome.storage.sync.get('settings');
            const settings = result.settings || { serverUrl: 'http://localhost:3000' };

            // Request cookies from background script
            const response = await chrome.runtime.sendMessage({ action: 'getCookies' });

            if (response && response.cookies && response.cookies.length > 0) {
                // Check for session cookies
                const hasSession = response.cookies.some(c =>
                    c.name === 'sessionid' || c.name === 'sid_tt' || c.name === 'tt_chain_token'
                );

                if (hasSession) {
                    // Format cookies
                    const formattedCookies = response.cookies.map(c => ({
                        name: c.name,
                        value: c.value,
                        domain: c.domain,
                        path: c.path || '/',
                        secure: c.secure || false,
                        httpOnly: c.httpOnly || false,
                        sameSite: c.sameSite || 'Lax'
                    }));

                    // Send to server
                    const apiResponse = await fetch(`${settings.serverUrl}/api/set-cookies`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cookies: formattedCookies })
                    });

                    if (apiResponse.ok) {
                        console.log('[TikDown] ✅ Cookies auto-synced to server');
                    }
                }
            }
        } catch (e) {
            // Silently fail - don't interrupt user browsing
            console.log('[TikDown] Cookie sync skipped:', e.message);
        }
    }

    /**
     * Extract video data from current page
     */
    async function extractVideoData() {
        const result = {
            videos: [],
            audios: [],
            images: [],  // NEW: for photo stories
            thumbnail: null,
            username: null,
            caption: null,
            isPhoto: false
        };

        const html = document.documentElement.innerHTML;
        const isPhotoPage = window.location.href.includes('/photo/');

        const decode = (url) => {
            if (!url) return url;
            return url
                .replace(/\\u0026/g, '&')
                .replace(/\\\//g, '/')
                .replace(/\\/g, '');
        };

        // PRIORITY for photos: Use Performance API to find photomode images from network
        if (isPhotoPage) {
            console.log('[TikDown] Photo page detected - checking for carousel...');

            // Helper function to get photomode URLs from Performance API (deduplicated by image ID)
            const getPhotomodeUrls = () => {
                const entries = performance.getEntriesByType('resource');
                const urls = [];
                const seenImageIds = new Set();

                entries.forEach(entry => {
                    const url = entry.name;
                    const isPhotoContent = (
                        url.includes('tiktokcdn') &&
                        (url.includes('photomode-sg') || url.includes('photomode-image') || url.includes('tplv-photomode'))
                    );
                    if (isPhotoContent && (url.includes('.jpeg') || url.includes('.jpg') || url.includes('.png') || url.includes('.webp'))) {
                        // Extract unique image ID to deduplicate resolutions
                        // URL format: /photomode-sg/IMAGEID~tplv-...
                        const imageIdMatch = url.match(/photomode-sg\/([a-zA-Z0-9]+)/);
                        const imageId = imageIdMatch ? imageIdMatch[1] : url;

                        if (!seenImageIds.has(imageId)) {
                            seenImageIds.add(imageId);
                            urls.push(url);
                        }
                    }
                });
                return urls;
            };

            // Helper function to wait
            const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

            // Check for carousel (pagination dots)
            const paginationDots = document.querySelectorAll('[class*="DotSlider"] span, [class*="swiper-pagination"] span, [class*="Pagination"] span');
            const isCarousel = paginationDots.length > 1;

            console.log('[TikDown] Carousel detected:', isCarousel, '| Dots:', paginationDots.length);

            // If carousel, navigate through all slides
            if (isCarousel) {
                console.log('[TikDown] 🎠 Carousel mode - navigating through', paginationDots.length, 'slides...');

                const seenUrls = new Set();
                let slideCount = 0;
                const maxSlides = 20;

                // First, get URLs from current slide
                let currentUrls = getPhotomodeUrls();
                currentUrls.forEach(url => seenUrls.add(url));
                console.log('[TikDown] Captured', seenUrls.size, 'photos from initial view');

                // Navigate through carousel
                while (slideCount < maxSlides) {
                    // Find Next button - TikTok uses various class names
                    const nextBtn = document.querySelector('[class*="SliderArrowRight"], [class*="arrow-right"], button[aria-label*="next" i], button[aria-label*="Next" i], [class*="swiper-button-next"]');

                    if (!nextBtn || nextBtn.offsetParent === null) {
                        console.log('[TikDown] No more slides (Next button not found/hidden)');
                        break;
                    }

                    // Click next
                    nextBtn.click();
                    slideCount++;

                    // Wait for transition and image load
                    await wait(600);

                    // Capture new photomode URLs
                    currentUrls = getPhotomodeUrls();
                    let newCount = 0;
                    currentUrls.forEach(url => {
                        if (!seenUrls.has(url)) {
                            seenUrls.add(url);
                            newCount++;
                        }
                    });

                    console.log('[TikDown] Slide', slideCount + 1, '- Captured', newCount, 'new photos | Total:', seenUrls.size);

                    // If no new photos found for 2 consecutive slides, stop
                    if (newCount === 0 && slideCount > 2) {
                        break;
                    }
                }

                // Add all unique URLs to result
                seenUrls.forEach(url => {
                    if (!result.images.some(i => i.url === url)) {
                        result.images.push({ url, type: 'carousel' });
                    }
                });

                console.log('[TikDown] ✅ Carousel complete:', result.images.length, 'total photos');

            } else {
                // Single photo - use existing logic
                try {
                    const photomodeUrls = getPhotomodeUrls();

                    // Sort by URL length (longer URLs tend to be more specific/actual content)
                    photomodeUrls.sort((a, b) => b.length - a.length);

                    photomodeUrls.forEach(url => {
                        if (!result.images.some(i => i.url === url)) {
                            result.images.push({ url, type: 'performance-api' });
                            console.log('[TikDown] ✅ Captured photomode image:', url.substring(0, 100) + '...');
                        }
                    });

                    console.log('[TikDown] Performance API found', result.images.length, 'photomode images');
                } catch (e) {
                    console.log('[TikDown] Performance API failed:', e.message);
                }
            }

            if (result.images.length > 0) {
                result.isPhoto = true;
                // Get username
                const urlMatch = window.location.href.match(/@([\w.-]+)/);
                if (urlMatch) result.username = urlMatch[1];
                return result; // Return early with photomode images
            }
        }

        // Try __UNIVERSAL_DATA_FOR_REHYDRATION__
        const scriptEl = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (scriptEl) {
            try {
                const jsonData = JSON.parse(scriptEl.textContent);
                const defaultScope = jsonData['__DEFAULT_SCOPE__'];

                if (defaultScope) {
                    // Try video-detail first, then post-detail for photos
                    let item = defaultScope['webapp.video-detail']?.itemInfo?.itemStruct;
                    if (!item) {
                        item = defaultScope['webapp.post-detail']?.itemInfo?.itemStruct;
                    }

                    if (item) {
                        // Photo/Story extraction
                        if (item.imagePost || isPhotoPage) {
                            result.isPhoto = true;

                            // Get images from imagePost
                            if (item.imagePost?.images) {
                                for (const img of item.imagePost.images) {
                                    if (img.imageURL?.urlList?.[0]) {
                                        result.images.push({
                                            url: decode(img.imageURL.urlList[0]),
                                            type: 'photo'
                                        });
                                    }
                                }
                            }

                            // Thumbnail
                            if (item.imagePost?.cover?.urlList?.[0]) {
                                result.thumbnail = decode(item.imagePost.cover.urlList[0]);
                            }
                        }

                        // Video extraction (existing logic)
                        if (item.video) {
                            if (item.video.playAddr) {
                                result.videos.push({
                                    url: decode(item.video.playAddr),
                                    type: 'watermark'
                                });
                            }
                            if (item.video.downloadAddr) {
                                result.videos.push({
                                    url: decode(item.video.downloadAddr),
                                    type: 'download'
                                });
                            }
                            if (item.video.cover) {
                                result.thumbnail = decode(item.video.cover);
                            }
                        }

                        // Get audio
                        if (item.music?.playUrl) {
                            result.audios.push({
                                url: decode(item.music.playUrl),
                                title: item.music.title || 'Unknown'
                            });
                        }

                        // Get metadata
                        if (item.author) {
                            result.username = item.author.uniqueId;
                        }
                        result.caption = item.desc || '';
                    }
                }
            } catch (e) {
                console.log('[TikDown] Failed to parse page data:', e);
            }
        }

        // Fallback for photos: get images directly from DOM (multiple methods)
        if (isPhotoPage && result.images.length === 0) {
            console.log('[TikDown] Trying DOM extraction for photo story...');

            // Method 1: Check picture/source elements
            document.querySelectorAll('picture source').forEach(source => {
                const srcset = source.srcset;
                if (srcset && (srcset.includes('tiktokcdn') || srcset.includes('muscdn'))) {
                    const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
                    const bestUrl = urls[urls.length - 1];
                    if (bestUrl && !result.images.some(i => i.url === bestUrl)) {
                        result.images.push({ url: bestUrl, type: 'picture-source' });
                    }
                }
            });

            // Method 2: Any large image (not just from tiktokcdn)
            document.querySelectorAll('img').forEach(img => {
                const src = img.src || img.currentSrc;
                const width = img.naturalWidth || img.width || 0;
                const height = img.naturalHeight || img.height || 0;

                // Skip base64, small images, avatars
                if (src &&
                    !src.startsWith('data:') &&
                    (width > 200 || height > 200) &&
                    !src.includes('avatar') &&
                    !src.includes('profile') &&
                    !src.includes('emoji') &&
                    !result.images.some(i => i.url === src)) {
                    result.images.push({ url: src, type: 'img-dom', width, height });
                }
            });

            // Method 3: Check srcset on img elements
            document.querySelectorAll('img[srcset]').forEach(img => {
                const srcset = img.srcset;
                if (srcset && !srcset.startsWith('data:')) {
                    const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
                    urls.forEach(url => {
                        if (url && !url.startsWith('data:') && !result.images.some(i => i.url === url)) {
                            result.images.push({ url, type: 'srcset' });
                        }
                    });
                }
            });

            // Method 4: Background images in divs
            document.querySelectorAll('[style*="background"]').forEach(el => {
                const style = el.getAttribute('style') || '';
                const match = style.match(/url\(['"]?([^'"()]+)['"]?\)/);
                if (match && match[1] && !match[1].startsWith('data:')) {
                    result.images.push({ url: match[1], type: 'bg-image' });
                }
            });

            // Method 5: data-src and data-original attributes
            document.querySelectorAll('[data-src], [data-original]').forEach(el => {
                const src = el.getAttribute('data-src') || el.getAttribute('data-original');
                if (src && !src.startsWith('data:') && !result.images.some(i => i.url === src)) {
                    result.images.push({ url: src, type: 'data-attr' });
                }
            });

            // Method 6: Blob URLs (lazy loaded images)
            document.querySelectorAll('img[src^="blob:"]').forEach(img => {
                const src = img.src;
                const width = img.naturalWidth || img.width || 0;
                if (src && width > 200 && !result.images.some(i => i.url === src)) {
                    result.images.push({ url: src, type: 'blob', width });
                    console.log('[TikDown] Found blob image:', src.substring(0, 50));
                }
            });

            // Method 7: Canvas elements (rendered images)
            document.querySelectorAll('canvas').forEach(canvas => {
                try {
                    if (canvas.width > 200 && canvas.height > 200) {
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
                        if (dataUrl && dataUrl.length > 1000) { // Not empty canvas
                            result.images.push({
                                url: dataUrl,
                                type: 'canvas',
                                width: canvas.width,
                                height: canvas.height
                            });
                            console.log('[TikDown] Captured canvas:', canvas.width, 'x', canvas.height);
                        }
                    }
                } catch (e) {
                    console.log('[TikDown] Canvas capture failed (CORS):', e.message);
                }
            });

            console.log('[TikDown] DOM extraction found:', result.images.length, 'images');

            if (result.images.length > 0) {
                result.isPhoto = true;
            }
        }

        // Fallback: try to get from video element
        if (result.videos.length === 0) {
            const videoEl = document.querySelector('video');
            if (videoEl && videoEl.src && !videoEl.src.startsWith('blob:')) {
                result.videos.push({
                    url: videoEl.src,
                    type: 'element'
                });
            }
        }

        // Get username from page URL if not found
        if (!result.username) {
            const urlMatch = window.location.href.match(/@([\w.-]+)/);
            if (urlMatch) {
                result.username = urlMatch[1];
            }
        }

        return result;
    }

    /**
     * Check if current page is a video page
     */
    function isVideoPage() {
        return /\/@[\w.-]+\/video\/\d+/.test(window.location.href);
    }

    // Listen for messages from popup/background
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'extractFromPage') {
            console.log('[TikDown] Extracting data from page...');

            // Use async wrapper for carousel support
            (async () => {
                try {
                    const data = await extractVideoData();
                    const hasContent = data.videos.length > 0 || data.audios.length > 0 || data.images.length > 0;
                    console.log('[TikDown] Extracted:', {
                        videos: data.videos.length,
                        images: data.images.length,
                        audios: data.audios.length,
                        isPhoto: data.isPhoto
                    });
                    sendResponse({
                        success: hasContent,
                        data: data,
                        url: window.location.href,
                        isVideoPage: isVideoPage(),
                        isPhotoPage: window.location.href.includes('/photo/')
                    });
                } catch (e) {
                    console.error('[TikDown] Extraction error:', e);
                    sendResponse({ success: false, error: e.message });
                }
            })();
            return true; // Keep message channel open for async response
        }

        if (request.action === 'getCurrentUrl') {
            sendResponse({
                url: window.location.href,
                isVideoPage: isVideoPage()
            });
            return true;
        }
    });

    // Auto-sync cookies when page loads (with small delay)
    setTimeout(() => {
        autoSyncCookies();
    }, 2000);

    // Notify that content script is ready
    console.log('[TikDown] Ready on:', window.location.href);
})();
