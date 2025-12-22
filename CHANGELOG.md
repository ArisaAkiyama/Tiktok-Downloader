# Changelog

All notable changes to TikDown will be documented in this file.

## [1.0.0] - 2025-12-20

### Added
- 🎬 Initial release of TikDown TikTok Downloader
- Video download with quality options
- Audio/music extraction
- Thumbnail/cover image extraction
- Video metadata (likes, comments, shares, plays)
- Caption and hashtag extraction
- Support for multiple TikTok URL formats:
  - Standard: `tiktok.com/@user/video/id`
  - Short: `vm.tiktok.com/code`
  - Mobile: `m.tiktok.com/v/id`
  - Web app: `tiktok.com/t/code`
- Chrome extension with popup UI
- Settings page for server configuration
- Batch download functionality
- Download queue with parallel processing
- Rate limiting to prevent bans
- Error recovery and diagnostics
- Browser pool for faster subsequent requests

### Technical Features
- Express.js backend server
- Puppeteer + Stealth plugin for scraping
- Browser keep-alive for performance
- Memory management (auto-restart on high usage)
- Diagnostic logging for debugging
