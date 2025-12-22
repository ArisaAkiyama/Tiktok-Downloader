/**
 * Download Queue Manager
 * Handles parallel downloads with concurrency control
 * Includes Puppeteer fallback for TikTok's signed URLs
 */

const fs = require('fs');
const path = require('path');

const MAX_CONCURRENT = 3; // Reduced for stability
const DEFAULT_DOWNLOAD_FOLDER = process.env.DOWNLOAD_PATH || path.join(require('os').homedir(), 'Downloads', 'TikTok');

class DownloadQueue {
    constructor() {
        this.queue = [];
        this.activeDownloads = 0;
        this.results = new Map();
        this.jobCounter = 0;
    }

    addBatch(items, username, downloadPath = '') {
        const jobId = `job_${++this.jobCounter}_${Date.now()}`;
        const baseFolder = downloadPath && downloadPath.trim() ? downloadPath.trim() : DEFAULT_DOWNLOAD_FOLDER;

        this.results.set(jobId, {
            status: 'processing',
            total: items.length,
            completed: 0,
            failed: 0,
            items: [],
            downloadPath: baseFolder
        });

        for (const item of items) {
            this.queue.push({
                jobId,
                url: item.url,
                filename: item.filename,
                type: item.type,
                username,
                downloadPath: baseFolder
            });
        }

        this.processQueue();
        return jobId;
    }

    async processQueue() {
        while (this.queue.length > 0 && this.activeDownloads < MAX_CONCURRENT) {
            const item = this.queue.shift();
            if (item) {
                this.activeDownloads++;
                this.downloadItem(item).finally(() => {
                    this.activeDownloads--;
                    this.processQueue();
                });
            }
        }
    }

    async downloadItem(item) {
        const { jobId, url, filename, type, username, downloadPath } = item;
        const result = this.results.get(jobId);

        try {
            const userFolder = path.join(downloadPath, username);
            if (!fs.existsSync(userFolder)) {
                fs.mkdirSync(userFolder, { recursive: true });
                console.log(`📁 Created folder: ${userFolder}`);
            }

            const filePath = path.join(userFolder, filename);

            if (fs.existsSync(filePath)) {
                result.completed++;
                result.items.push({ filename, status: 'skipped', reason: 'exists' });
                this.checkJobComplete(jobId);
                return;
            }

            // Try fetch download first
            let buffer = await this.tryFetchDownload(url);

            // If fetch fails, try Puppeteer
            if (!buffer) {
                console.log('🌐 Trying Puppeteer download...');
                buffer = await this.tryPuppeteerDownload(url);
            }

            if (!buffer || buffer.length < 1000) {
                throw new Error('Could not download - TikTok blocking');
            }

            fs.writeFileSync(filePath, buffer);
            result.completed++;
            result.items.push({ filename, status: 'success', path: filePath, size: buffer.length });
            console.log(`✅ Downloaded: ${filename} (${Math.round(buffer.length / 1024)}KB)`);

        } catch (error) {
            result.failed++;
            result.items.push({ filename, status: 'failed', error: error.message });
            console.error(`❌ Failed: ${filename} - ${error.message}`);
        }

        this.checkJobComplete(jobId);
    }

    async tryFetchDownload(url) {
        const fetch = (await import('node-fetch')).default;

        const headerSets = [
            {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Referer': 'https://www.tiktok.com/',
                'Origin': 'https://www.tiktok.com'
            },
            {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
                'Accept': '*/*'
            },
            {
                'User-Agent': 'TikTok 26.1.3 rv:261303 (iPhone; iOS 14.4.2; en_US) Cronet'
            }
        ];

        for (let i = 0; i < headerSets.length; i++) {
            try {
                console.log(`🔄 Fetch attempt ${i + 1}/${headerSets.length}...`);
                const response = await fetch(url, {
                    headers: headerSets[i],
                    timeout: 60000,
                    redirect: 'follow'
                });

                if (response.ok || response.status === 206) {
                    const buffer = await response.buffer();
                    if (buffer.length > 1000) {
                        console.log('✅ Fetch download success');
                        return buffer;
                    }
                }
                console.log(`⚠️ Attempt ${i + 1} failed: HTTP ${response.status}`);
            } catch (e) {
                console.log(`⚠️ Attempt ${i + 1} error: ${e.message}`);
            }
        }

        return null;
    }

    async tryPuppeteerDownload(url) {
        let page = null;

        try {
            const browserManager = require('./browser-manager');
            page = await browserManager.getPage();

            let videoBuffer = null;

            // Set up response interception
            page.on('response', async (response) => {
                const respUrl = response.url();
                const contentType = response.headers()['content-type'] || '';

                if (contentType.includes('video') || respUrl.includes('.mp4')) {
                    try {
                        const buffer = await response.buffer();
                        if (buffer && buffer.length > 10000) {
                            videoBuffer = buffer;
                            console.log(`📥 Captured video: ${buffer.length} bytes`);
                        }
                    } catch (e) {
                        // Ignore buffer errors
                    }
                }
            });

            // Navigate to video URL directly
            await page.goto(url, {
                waitUntil: 'networkidle0',
                timeout: 30000
            });

            await new Promise(r => setTimeout(r, 3000));

            await browserManager.releasePage(page);

            if (videoBuffer) {
                console.log('✅ Puppeteer download success');
            }

            return videoBuffer;

        } catch (e) {
            console.log('Puppeteer download error:', e.message);
            if (page) {
                try {
                    const browserManager = require('./browser-manager');
                    await browserManager.releasePage(page);
                } catch (releaseErr) { }
            }
            return null;
        }
    }

    checkJobComplete(jobId) {
        const result = this.results.get(jobId);
        if (result && (result.completed + result.failed) >= result.total) {
            result.status = 'complete';
            result.completedAt = new Date().toISOString();
            setTimeout(() => this.results.delete(jobId), 5 * 60 * 1000);
        }
    }

    getStatus(jobId) {
        return this.results.get(jobId) || { status: 'not_found' };
    }

    getStats() {
        return {
            queueLength: this.queue.length,
            activeDownloads: this.activeDownloads,
            maxConcurrent: MAX_CONCURRENT,
            activeJobs: this.results.size
        };
    }
}

const downloadQueue = new DownloadQueue();
module.exports = downloadQueue;
