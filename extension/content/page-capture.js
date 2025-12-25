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

        // PRIORITY for photos: Use Post ID and page data for accurate extraction
        if (isPhotoPage) {
            console.log('[TikDown] Photo page detected - using Post ID extraction');

            // Extract Post ID from URL
            const postIdMatch = window.location.href.match(/photo\/(\d+)/);
            const postId = postIdMatch ? postIdMatch[1] : null;
            console.log('[TikDown] Post ID:', postId);

            // Helper function to filter only carousel photos (content URLs, not avatars)
            const filterCarouselPhotos = (urls) => {
                // Valid content patterns (expanded to include more CDN paths)
                const validPatterns = [
                    'photomode-sg', 'photomode-image', 'tplv-photomode', 'photomode',
                    'tos-alisg-i-', 'tos-alisg-p-', 'tos-alisg-avt-0068',
                    'tos-maliva-i-', 'tos-maliva-p-', 'tos-maliva-avt-0068',
                    '/obj/', 'tiktok-obj'
                ];
                // Patterns to ALWAYS exclude (icons, avatars, etc)
                const excludePatterns = [
                    '/avatar/', 'profile_pic', '/music/', 'logo', 'icon', 'emoji',
                    '100x100', '150x150', '192x192', '200x200', 'cover_small'
                ];

                // Filter: must be TikTok CDN, not excluded, prefer valid patterns
                return urls.filter(url => {
                    const lower = url.toLowerCase();
                    // Must be from TikTok CDN
                    if (!lower.includes('tiktokcdn') && !lower.includes('muscdn')) return false;
                    // Must NOT match exclude patterns
                    if (excludePatterns.some(p => lower.includes(p))) return false;
                    // Prefer URLs with valid content patterns, but also accept image files
                    return validPatterns.some(p => lower.includes(p)) ||
                        lower.match(/\.(jpeg|jpg|png|webp)(\?|$)/);
                });
            };

            // Helper function to deduplicate by image ID
            const deduplicateByImageId = (urls) => {
                const seenIds = new Set();
                return urls.filter(url => {
                    // Try multiple patterns to extract image ID
                    let imageId = null;
                    let match = url.match(/photomode-sg\/([a-zA-Z0-9]+)(?:~|\/|$)/);
                    if (match) imageId = match[1];
                    if (!imageId) {
                        match = url.match(/tos-[^/]+\/([a-zA-Z0-9]+)(?:~|$)/);
                        if (match) imageId = match[1];
                    }
                    if (!imageId) imageId = url;

                    if (seenIds.has(imageId)) return false;
                    seenIds.add(imageId);
                    return true;
                });
            };

            // METHOD 1: Try TikTok API directly (most reliable)
            if (postId) {
                try {
                    console.log('[TikDown] METHOD 1: Trying TikTok API with postId:', postId);
                    const apiUrl = `https://www.tiktok.com/api/item/detail/?itemId=${postId}`;
                    const response = await fetch(apiUrl, { credentials: 'include' });

                    if (response.ok) {
                        const data = await response.json();
                        console.log('[TikDown] API statusCode:', data.statusCode);

                        if (data.statusCode === 0 && data.itemInfo?.itemStruct?.imagePost?.images) {
                            const images = data.itemInfo.itemStruct.imagePost.images;
                            console.log('[TikDown] API found', images.length, 'images in imagePost');

                            const imageUrls = [];
                            for (const img of images) {
                                const urlList = img.imageURL?.urlList || [];
                                console.log('[TikDown] Image urlList:', urlList.length, 'URLs');

                                if (urlList.length > 0) {
                                    // Get the best URL (prefer larger/non-avatar ones)
                                    let photoUrl = urlList.find(url =>
                                        url.includes('photomode') &&
                                        !url.toLowerCase().includes('avt-') &&
                                        !url.toLowerCase().includes('avatar')
                                    );

                                    // Fallback: get first non-avatar URL
                                    if (!photoUrl) {
                                        photoUrl = urlList.find(url =>
                                            !url.toLowerCase().includes('avatar') &&
                                            !url.toLowerCase().includes('/avt-') &&
                                            url.includes('tiktokcdn')
                                        );
                                    }

                                    // Last fallback: just get first URL
                                    if (!photoUrl && urlList[0]) {
                                        photoUrl = urlList[0];
                                    }

                                    if (photoUrl && !imageUrls.includes(photoUrl)) {
                                        imageUrls.push(photoUrl);
                                    }
                                }
                            }

                            if (imageUrls.length > 0) {
                                result.username = data.itemInfo.itemStruct.author?.uniqueId;
                                result.caption = data.itemInfo.itemStruct.desc;
                                result.isPhoto = true;

                                const filtered = deduplicateByImageId(filterCarouselPhotos(imageUrls));
                                filtered.forEach(url => {
                                    result.images.push({ url, type: 'api' });
                                });

                                console.log('[TikDown] ✅ API extracted', result.images.length, 'carousel photos');
                                return result;
                            } else {
                                console.log('[TikDown] API: No valid image URLs found');
                            }
                        } else {
                            console.log('[TikDown] API: No imagePost data found');
                        }
                    } else {
                        console.log('[TikDown] API response not OK:', response.status);
                    }
                } catch (e) {
                    console.log('[TikDown] API error:', e.message);
                }
            }

            // METHOD 2: Extract from page data JSON
            const scriptEl = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (scriptEl) {
                try {
                    const data = JSON.parse(scriptEl.textContent);
                    const defaultScope = data?.['__DEFAULT_SCOPE__'];

                    console.log('[TikDown] Available keys:', defaultScope ? Object.keys(defaultScope) : 'none');

                    let item = defaultScope?.['webapp.video-detail']?.itemInfo?.itemStruct;
                    if (!item) {
                        item = defaultScope?.['webapp.post-detail']?.itemInfo?.itemStruct;
                    }

                    // Search through ALL keys if still not found
                    if (!item && defaultScope) {
                        for (const key of Object.keys(defaultScope)) {
                            const scopeData = defaultScope[key];
                            if (scopeData?.itemInfo?.itemStruct?.imagePost?.images) {
                                item = scopeData.itemInfo.itemStruct;
                                console.log('[TikDown] Found item in key:', key);
                                break;
                            }
                        }
                    }

                    if (item?.imagePost?.images && Array.isArray(item.imagePost.images)) {
                        console.log('[TikDown] Found imagePost with', item.imagePost.images.length, 'images');

                        const imageUrls = [];
                        for (const img of item.imagePost.images) {
                            if (img.imageURL?.urlList && img.imageURL.urlList.length > 0) {
                                // Get URL that's NOT an avatar
                                const photoUrl = img.imageURL.urlList.find(url =>
                                    (url.includes('photomode') || url.includes('tos-alisg-i-') || url.includes('tos-maliva-i-')) &&
                                    !url.toLowerCase().includes('avt-') && !url.toLowerCase().includes('avatar')
                                ) || img.imageURL.urlList.find(url =>
                                    !url.toLowerCase().includes('avt-') && !url.toLowerCase().includes('avatar')
                                );

                                if (photoUrl && !imageUrls.includes(photoUrl)) {
                                    imageUrls.push(photoUrl);
                                }
                            }
                        }

                        if (imageUrls.length > 0) {
                            result.username = item.author?.uniqueId || item.author?.nickname;
                            result.caption = item.desc;
                            result.isPhoto = true;

                            const filtered = deduplicateByImageId(filterCarouselPhotos(imageUrls));
                            filtered.forEach(url => {
                                result.images.push({ url, type: 'imagePost' });
                            });

                            console.log('[TikDown] ✅ Extracted', result.images.length, 'photos from imagePost data');
                            return result;
                        }
                    }
                } catch (e) {
                    console.log('[TikDown] Page data parse error:', e.message);
                }
            }

            // METHOD 3: Performance API fallback (expanded patterns)
            try {
                console.log('[TikDown] Trying Performance API...');
                const perfUrls = [];
                performance.getEntriesByType('resource').forEach(entry => {
                    const url = entry.name.toLowerCase();
                    // Capture all image files from TikTok CDN
                    if (url.includes('tiktokcdn') &&
                        (url.includes('.jpeg') || url.includes('.jpg') || url.includes('.png') || url.includes('.webp'))) {
                        // Exclude avatars and icons
                        if (!url.includes('/avatar/') && !url.includes('profile_pic') &&
                            !url.includes('/music/') && !url.includes('100x100') &&
                            !url.includes('150x150') && !url.includes('192x192')) {
                            perfUrls.push(entry.name);
                        }
                    }
                });

                if (perfUrls.length > 0) {
                    console.log('[TikDown] Performance API raw URLs:', perfUrls.length);
                    const filtered = deduplicateByImageId(filterCarouselPhotos(perfUrls));
                    filtered.forEach(url => {
                        if (!result.images.some(i => i.url === url)) {
                            result.images.push({ url, type: 'performance-api' });
                        }
                    });
                    console.log('[TikDown] ✅ Performance API found', result.images.length, 'unique photos');
                }
            } catch (e) {
                console.log('[TikDown] Performance API error:', e.message);
            }

            // METHOD 4: DOM extraction - get large visible images
            if (result.images.length === 0) {
                console.log('[TikDown] Trying DOM extraction...');
                const domImages = [];
                document.querySelectorAll('img').forEach(img => {
                    const src = img.src || img.currentSrc;
                    if (!src) return;

                    const width = Math.max(img.naturalWidth || 0, img.width || 0);
                    const height = Math.max(img.naturalHeight || 0, img.height || 0);

                    // Must be large (> 300px)
                    if (width > 300 || height > 300) {
                        if (src.includes('tiktokcdn') && !src.includes('/avatar/') &&
                            !src.includes('profile_pic') && !src.includes('/music/')) {
                            domImages.push(src);
                        }
                    }
                });

                if (domImages.length > 0) {
                    const filtered = deduplicateByImageId(filterCarouselPhotos(domImages));
                    filtered.forEach(url => {
                        if (!result.images.some(i => i.url === url)) {
                            result.images.push({ url, type: 'dom' });
                        }
                    });
                    console.log('[TikDown] ✅ DOM extraction found', result.images.length, 'photos');
                }
            }

            // METHOD 5: Carousel Navigation - click through slides
            const carouselExists = document.querySelector('[class*="SliderArrow"], [class*="arrow"], [class*="Swiper"]');
            if (carouselExists && result.images.length < 3) {
                console.log('[TikDown] Carousel detected, navigating slides...');

                // Function to get current visible image
                const getCurrentImage = () => {
                    const imgs = document.querySelectorAll('img');
                    for (const img of imgs) {
                        const rect = img.getBoundingClientRect();
                        const src = img.src;
                        if (rect.width > 300 && rect.height > 300 &&
                            src && src.includes('tiktokcdn') &&
                            !src.includes('/avatar/')) {
                            return src;
                        }
                    }
                    return null;
                };

                // Try clicking next button
                for (let i = 0; i < 20; i++) {
                    await new Promise(r => setTimeout(r, 300));

                    const nextBtn = document.querySelector('[class*="SliderArrowRight"], [class*="arrow-right"], button[aria-label*="next" i]');
                    if (nextBtn) {
                        nextBtn.click();
                        await new Promise(r => setTimeout(r, 400));

                        const currentImg = getCurrentImage();
                        if (currentImg && !result.images.some(i => i.url === currentImg)) {
                            result.images.push({ url: currentImg, type: 'carousel-nav' });
                            console.log('[TikDown] Slide', i + 1, ': captured new photo');
                        }
                    } else {
                        break;
                    }
                }
            }

            if (result.images.length > 0) {
                result.isPhoto = true;
                const urlMatch = window.location.href.match(/@([\w.-]+)/);
                if (urlMatch) result.username = urlMatch[1];
                console.log('[TikDown] ✅ Total photos extracted:', result.images.length);
                return result;
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
                                        const imgUrl = decode(img.imageURL.urlList[0]);
                                        // Check for duplicates before adding
                                        if (!result.images.some(i => i.url === imgUrl)) {
                                            result.images.push({
                                                url: imgUrl,
                                                type: 'photo'
                                            });
                                        }
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
