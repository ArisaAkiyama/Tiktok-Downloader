/**
 * Browser Manager - Keep-alive browser pool for faster scraping
 * Reuses browser instance instead of launching new one each request
 * Includes memory management to prevent memory leaks
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const HEADLESS = process.env.HEADLESS !== 'false';
const BROWSER_TIMEOUT = 5 * 60 * 1000; // 5 minutes idle timeout
const MAX_PAGES = 5; // Max concurrent pages
const MAX_REQUESTS = 50; // Restart browser after N requests
const MAX_MEMORY_MB = 500; // Restart browser if memory exceeds this (MB)
const MEMORY_CHECK_INTERVAL = 30 * 1000; // Check memory every 30 seconds

class BrowserManager {
    constructor() {
        this.browser = null;
        this.lastUsed = null;
        this.requestCount = 0;
        this.isLaunching = false;
        this.launchPromise = null;
        this.idleTimer = null;
        this.memoryCheckTimer = null;
        this.peakMemoryMB = 0;
        this.restartCount = 0;
    }

    /**
     * Get browser instance (creates new one if needed)
     */
    async getBrowser() {
        // If browser exists and is connected, return it
        if (this.browser && this.browser.isConnected()) {
            this.lastUsed = Date.now();
            this.resetIdleTimer();
            return this.browser;
        }

        // If already launching, wait for it
        if (this.isLaunching && this.launchPromise) {
            return this.launchPromise;
        }

        // Launch new browser
        this.isLaunching = true;
        this.launchPromise = this.launchBrowser();

        try {
            this.browser = await this.launchPromise;
            this.lastUsed = Date.now();
            this.requestCount = 0;
            this.resetIdleTimer();
            this.startMemoryMonitor();
            console.log('🚀 Browser launched (keep-alive mode)');
            return this.browser;
        } finally {
            this.isLaunching = false;
            this.launchPromise = null;
        }
    }

    /**
     * Start memory monitoring
     */
    startMemoryMonitor() {
        if (this.memoryCheckTimer) {
            clearInterval(this.memoryCheckTimer);
        }

        this.memoryCheckTimer = setInterval(async () => {
            await this.checkMemoryUsage();
        }, MEMORY_CHECK_INTERVAL);
    }

    /**
     * Check memory usage and restart if needed
     */
    async checkMemoryUsage() {
        if (!this.browser || !this.browser.isConnected()) return;

        try {
            // Get process memory usage
            const memUsage = process.memoryUsage();
            const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
            const rssMB = Math.round(memUsage.rss / 1024 / 1024);

            // Track peak memory
            if (rssMB > this.peakMemoryMB) {
                this.peakMemoryMB = rssMB;
            }

            // Force restart if memory too high
            if (rssMB > MAX_MEMORY_MB) {
                console.log(`⚠️ Memory usage high: ${rssMB}MB > ${MAX_MEMORY_MB}MB - restarting browser`);
                this.restartCount++;
                await this.closeBrowser();
            }
        } catch (e) {
            // Ignore errors
        }
    }

    /**
     * Launch new browser instance
     */
    async launchBrowser() {
        return puppeteer.launch({
            headless: HEADLESS ? 'new' : false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--no-first-run',
                '--window-size=1280,720',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-web-security',
                '--disable-site-isolation-trials'
            ],
            defaultViewport: { width: 1280, height: 720 },
            protocolTimeout: 60000
        });
    }

    /**
     * Get a new page from the browser pool
     */
    async getPage() {
        const browser = await this.getBrowser();

        // Check if we need to restart browser (memory management)
        this.requestCount++;
        if (this.requestCount >= MAX_REQUESTS) {
            console.log('🔄 Browser restart scheduled (memory management)');
            // Schedule restart after current request
            setTimeout(() => this.closeBrowser(), 1000);
        }

        // Check current page count
        const pages = await browser.pages();
        if (pages.length >= MAX_PAGES) {
            // Close oldest page (skip first which is usually blank)
            const oldestPage = pages[1];
            if (oldestPage) {
                try { await oldestPage.close(); } catch (e) { }
            }
        }

        const page = await browser.newPage();

        // Random user agents for better evasion
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ];
        const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];

        // Set up page defaults
        await page.setUserAgent(randomUA);

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'max-age=0',
            'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        });

        // Additional anti-detection evasions
        await page.evaluateOnNewDocument(() => {
            // Override navigator properties
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'id'] });

            // Override chrome runtime
            window.chrome = { runtime: {} };

            // Add realistic permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );

            // Realistic screen properties
            Object.defineProperty(screen, 'availWidth', { get: () => window.screen.width });
            Object.defineProperty(screen, 'availHeight', { get: () => window.screen.height - 40 });
        });

        return page;
    }

    /**
     * Release a page back to the pool (close it)
     */
    async releasePage(page) {
        if (page && !page.isClosed()) {
            try {
                await page.close();
            } catch (e) {
                // Ignore close errors
            }
        }
        this.lastUsed = Date.now();
        this.resetIdleTimer();
    }

    /**
     * Reset idle timer - close browser after inactivity
     */
    resetIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }

        this.idleTimer = setTimeout(() => {
            console.log('💤 Browser idle timeout - closing');
            this.closeBrowser();
        }, BROWSER_TIMEOUT);
    }

    /**
     * Close browser and cleanup
     */
    async closeBrowser() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        if (this.memoryCheckTimer) {
            clearInterval(this.memoryCheckTimer);
            this.memoryCheckTimer = null;
        }

        if (this.browser) {
            try {
                await this.browser.close();
                console.log('🔒 Browser closed');
            } catch (e) {
                // Ignore close errors
            }
            this.browser = null;
        }

        this.requestCount = 0;
    }

    /**
     * Get browser stats including memory
     */
    getStats() {
        const memUsage = process.memoryUsage();
        const currentMemMB = Math.round(memUsage.rss / 1024 / 1024);
        const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);

        return {
            isRunning: this.browser && this.browser.isConnected(),
            requestCount: this.requestCount,
            maxRequests: MAX_REQUESTS,
            restartCount: this.restartCount,
            lastUsed: this.lastUsed ? new Date(this.lastUsed).toISOString() : null,
            idleTimeout: BROWSER_TIMEOUT / 1000 + 's',
            memory: {
                currentMB: currentMemMB,
                heapUsedMB: heapUsedMB,
                peakMB: this.peakMemoryMB,
                maxMB: MAX_MEMORY_MB,
                checkIntervalSec: MEMORY_CHECK_INTERVAL / 1000
            }
        };
    }
}

// Singleton instance
const browserManager = new BrowserManager();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down browser...');
    await browserManager.closeBrowser();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await browserManager.closeBrowser();
    process.exit(0);
});

module.exports = browserManager;
