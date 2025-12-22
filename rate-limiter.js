/**
 * Rate Limiter - Prevent TikTok ban by controlling request frequency
 * Ensures minimum delay between requests and max requests per minute
 */

const MIN_DELAY_MS = 2000; // Minimum 2 seconds between requests
const MAX_REQUESTS_PER_MINUTE = 15; // Max 15 requests per minute
const BURST_COOLDOWN_MS = 60000; // 1 minute cooldown after burst

class RateLimiter {
    constructor() {
        this.lastRequestTime = 0;
        this.requestTimestamps = [];
        this.isThrottled = false;
        this.throttleUntil = 0;
    }

    /**
     * Wait until it's safe to make a request
     * @returns {Promise<void>}
     */
    async waitForSlot() {
        // Check if we're in cooldown
        if (this.isThrottled && Date.now() < this.throttleUntil) {
            const waitTime = this.throttleUntil - Date.now();
            console.log(`🚦 Rate limited - waiting ${Math.ceil(waitTime / 1000)}s cooldown...`);
            await this.sleep(waitTime);
            this.isThrottled = false;
        }

        // Clean old timestamps (older than 1 minute)
        const oneMinuteAgo = Date.now() - 60000;
        this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneMinuteAgo);

        // Check requests per minute limit
        if (this.requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
            console.log(`⚠️ Burst limit reached (${MAX_REQUESTS_PER_MINUTE}/min) - entering cooldown`);
            this.isThrottled = true;
            this.throttleUntil = Date.now() + BURST_COOLDOWN_MS;
            await this.sleep(BURST_COOLDOWN_MS);
            this.isThrottled = false;
            this.requestTimestamps = [];
        }

        // Ensure minimum delay between requests
        const timeSinceLastRequest = Date.now() - this.lastRequestTime;
        if (timeSinceLastRequest < MIN_DELAY_MS) {
            const waitTime = MIN_DELAY_MS - timeSinceLastRequest;
            console.log(`⏳ Rate limit delay: ${waitTime}ms`);
            await this.sleep(waitTime);
        }

        // Record this request
        this.lastRequestTime = Date.now();
        this.requestTimestamps.push(this.lastRequestTime);
    }

    /**
     * Add random jitter to avoid detection patterns
     * @param {number} baseDelay - Base delay in ms
     * @returns {Promise<void>}
     */
    async addJitter(baseDelay = 500) {
        const jitter = Math.random() * baseDelay;
        await this.sleep(jitter);
    }

    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get rate limiter stats
     */
    getStats() {
        return {
            lastRequestTime: this.lastRequestTime ? new Date(this.lastRequestTime).toISOString() : null,
            requestsLastMinute: this.requestTimestamps.length,
            maxRequestsPerMinute: MAX_REQUESTS_PER_MINUTE,
            minDelayMs: MIN_DELAY_MS,
            isThrottled: this.isThrottled,
            throttleUntil: this.isThrottled ? new Date(this.throttleUntil).toISOString() : null
        };
    }

    /**
     * Manual throttle (e.g., if we detect rate limiting from TikTok)
     */
    triggerCooldown(durationMs = BURST_COOLDOWN_MS) {
        console.log(`🛑 Manual cooldown triggered for ${durationMs / 1000}s`);
        this.isThrottled = true;
        this.throttleUntil = Date.now() + durationMs;
    }
}

// Singleton instance
const rateLimiter = new RateLimiter();

module.exports = rateLimiter;
