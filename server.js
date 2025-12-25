/**
 * Express Server for TikTok Downloader API
 * Handles Video and Audio downloads
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { scrapeTikTokVideo, isValidTikTokUrl, saveCapturedBuffer, getCapturedBuffer } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// Import managers
const browserManager = require('./browser-manager');
const rateLimiter = require('./rate-limiter');
const errorRecovery = require('./error-recovery');
const downloadQueue = require('./download-queue');

// Cookie file path
const COOKIES_PATH = path.join(__dirname, 'cookies.json');

// Default download folder
const DEFAULT_DOWNLOAD_FOLDER = process.env.DOWNLOAD_PATH || path.join(require('os').homedir(), 'Downloads', 'TikTok');

/**
 * API Endpoint: Set TikTok Cookies
 * POST /api/set-cookies
 * Body: { cookies: [...] }
 */
app.post('/api/set-cookies', async (req, res) => {
    try {
        const { cookies } = req.body;

        if (!cookies || !Array.isArray(cookies)) {
            return res.status(400).json({
                success: false,
                error: 'Cookies array diperlukan'
            });
        }

        // Validate TikTok session cookies exist
        const sessionCookie = cookies.find(c =>
            c.name === 'sessionid' || c.name === 'sid_tt' || c.name === 'tt_chain_token'
        );
        if (!sessionCookie || !sessionCookie.value) {
            return res.status(400).json({
                success: false,
                error: 'Session cookie tidak ditemukan (sessionid/sid_tt/tt_chain_token)'
            });
        }

        // Save cookies to file
        fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));

        console.log(`🍪 Auto-synced from browser: ${cookies.length} cookies`);

        res.json({
            success: true,
            message: 'Cookies saved successfully',
            count: cookies.length
        });

    } catch (error) {
        console.error('Set cookies error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save cookies: ' + error.message
        });
    }
});

/**
 * API Endpoint: Check Cookie Status
 * GET /api/cookie-status
 */
app.get('/api/cookie-status', (req, res) => {
    try {
        if (!fs.existsSync(COOKIES_PATH)) {
            return res.json({ loggedIn: false, message: 'No cookies file' });
        }

        const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
        const sessionCookie = cookies.find(c =>
            c.name === 'sessionid' || c.name === 'sid_tt'
        );

        if (sessionCookie && sessionCookie.value && !sessionCookie.value.includes('YOUR_')) {
            res.json({
                loggedIn: true,
                cookieCount: cookies.length
            });
        } else {
            res.json({ loggedIn: false, message: 'No valid session' });
        }
    } catch (error) {
        res.json({ loggedIn: false, error: error.message });
    }
});

/**
 * API Endpoint: Download TikTok Video
 * POST /api/download
 * Body: { url: "https://www.tiktok.com/@user/video/123" }
 */
app.post('/api/download', async (req, res) => {
    try {
        const { url } = req.body;

        // Validate request
        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL diperlukan',
                code: 'MISSING_URL'
            });
        }

        // Quick URL validation before scraping
        if (!isValidTikTokUrl(url)) {
            return res.status(400).json({
                success: false,
                error: 'URL tidak valid. Masukkan URL video TikTok yang benar.',
                code: 'INVALID_URL'
            });
        }

        console.log('Processing request for:', url);

        // Call scraper
        const result = await scrapeTikTokVideo(url);

        if (result.success) {
            console.log(`Successfully extracted ${result.count} media items`);
            return res.json(result);
        } else {
            console.log('Scraping failed:', result.error);
            return res.status(400).json(result);
        }

    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({
            success: false,
            error: 'Terjadi kesalahan server. Silakan coba lagi.',
            code: 'SERVER_ERROR'
        });
    }
});

/**
 * API Endpoint: Proxy download for CORS bypass
 * GET /api/proxy?url=...
 */
app.get('/api/proxy', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ error: 'URL diperlukan' });
        }

        const fetch = (await import('node-fetch')).default;

        // TikTok requires specific headers
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'identity;q=1, *;q=0',
            'Range': 'bytes=0-',
            'Referer': 'https://www.tiktok.com/',
            'Origin': 'https://www.tiktok.com',
            'Sec-Fetch-Dest': 'video',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site'
        };

        let response = await fetch(url, { headers, redirect: 'follow' });

        // Retry with different headers if 403
        if (response.status === 403) {
            delete headers['Range'];
            response = await fetch(url, { headers, redirect: 'follow' });
        }

        if (response.status === 403) {
            response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
                },
                redirect: 'follow'
            });
        }

        if (!response.ok && response.status !== 206) {
            return res.status(response.status).json({ error: 'Failed to fetch media' });
        }

        // Forward the content
        const contentType = response.headers.get('content-type') || 'video/mp4';
        const contentLength = response.headers.get('content-length');

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', 'attachment');
        if (contentLength) {
            res.setHeader('Content-Length', contentLength);
        }

        response.body.pipe(res);

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).json({ error: 'Proxy error: ' + error.message });
    }
});

/**
 * API Endpoint: Save captured buffer (uses memory buffer, not refetch)
 * POST /api/save-captured
 * Body: { filename, username }
 */
app.post('/api/save-captured', (req, res) => {
    try {
        const { filename, username } = req.body;

        if (!filename || !username) {
            return res.status(400).json({
                success: false,
                error: 'Filename dan username diperlukan'
            });
        }

        const result = saveCapturedBuffer(filename, username);

        if (result.success) {
            res.json({
                success: true,
                path: result.path,
                size: result.size,
                message: `File tersimpan: ${filename}`
            });
        } else {
            res.status(400).json({
                success: false,
                error: result.error || 'Gagal menyimpan file'
            });
        }
    } catch (error) {
        console.error('Save captured error:', error);
        res.status(500).json({
            success: false,
            error: 'Gagal menyimpan: ' + error.message
        });
    }
});

/**
 * API Endpoint: Get captured buffer as download
 * GET /api/download-captured/:filename
 */
app.get('/api/download-captured/:filename', (req, res) => {
    const filename = req.params.filename;
    const buffer = getCapturedBuffer(filename);

    if (!buffer) {
        return res.status(404).json({ error: 'File not found or expired' });
    }

    const ext = filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
    res.setHeader('Content-Type', ext);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
});

/**
 * Health check endpoint
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        browser: browserManager.getStats(),
        rateLimit: rateLimiter.getStats(),
        errors: errorRecovery.getStats()
    });
});

/**
 * API Endpoint: Save media to local folder (organized by username)
 * POST /api/save
 * Body: { url, filename, type, username, downloadPath }
 */
app.post('/api/save', async (req, res) => {
    console.log('[Save] Request received:', req.body.filename || 'no filename');
    try {
        const { url, filename, type, username, downloadPath } = req.body;

        if (!url || !filename) {
            return res.status(400).json({
                success: false,
                error: 'URL dan filename diperlukan'
            });
        }

        // Use custom download path if provided, otherwise use default
        const baseFolder = downloadPath && downloadPath.trim()
            ? downloadPath.trim()
            : DEFAULT_DOWNLOAD_FOLDER;

        // Create subfolder based on username
        const safeUsername = (username || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const userFolder = path.join(baseFolder, safeUsername);

        if (!fs.existsSync(userFolder)) {
            fs.mkdirSync(userFolder, { recursive: true });
            console.log(`📁 Created folder: ${userFolder}`);
        }

        // Download file with proper headers
        const fetch = (await import('node-fetch')).default;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.tiktok.com/',
            'Origin': 'https://www.tiktok.com'
        };

        let response = await fetch(url, { headers, redirect: 'follow' });

        // Retry with mobile UA if 403
        if (response.status === 403) {
            response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15'
                },
                redirect: 'follow'
            });
        }

        if (!response.ok && response.status !== 206) {
            throw new Error(`HTTP ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        const filePath = path.join(userFolder, filename);

        fs.writeFileSync(filePath, Buffer.from(buffer));

        console.log(`✅ Saved: ${safeUsername}/${filename}`);

        res.json({
            success: true,
            filename,
            username: safeUsername,
            path: filePath,
            size: buffer.byteLength
        });

    } catch (error) {
        console.error('Save error:', error);
        res.status(500).json({
            success: false,
            error: 'Gagal menyimpan file: ' + error.message
        });
    }
});

/**
 * API Endpoint: Batch download (parallel)
 * POST /api/batch-save
 * Body: { items: [{url, filename, type}], username }
 */
app.post('/api/batch-save', async (req, res) => {
    try {
        const { items, username, downloadPath } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Items array diperlukan'
            });
        }

        if (!username) {
            return res.status(400).json({
                success: false,
                error: 'Username diperlukan'
            });
        }

        // Add to queue and get job ID
        const jobId = downloadQueue.addBatch(items, username, downloadPath);

        console.log(`📦 Batch job started: ${jobId} (${items.length} items)`);

        res.json({
            success: true,
            jobId,
            total: items.length,
            message: 'Download started in background'
        });

    } catch (error) {
        console.error('Batch save error:', error);
        res.status(500).json({
            success: false,
            error: 'Batch save failed: ' + error.message
        });
    }
});

/**
 * API Endpoint: Check batch job status
 * GET /api/batch-status/:jobId
 */
app.get('/api/batch-status/:jobId', (req, res) => {
    const status = downloadQueue.getStatus(req.params.jobId);
    res.json(status);
});

/**
 * API Endpoint: Get download queue stats
 * GET /api/queue-stats
 */
app.get('/api/queue-stats', (req, res) => {
    res.json(downloadQueue.getStats());
});

// Serve index.html for root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint tidak ditemukan'
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           TikTok Downloader Server Started!               ║
║═══════════════════════════════════════════════════════════║
║  🌐 URL: http://localhost:${PORT}                           ║
║  📡 API: http://localhost:${PORT}/api/download               ║
║  💚 Health: http://localhost:${PORT}/api/health              ║
╚═══════════════════════════════════════════════════════════╝
`);
});

module.exports = app;
