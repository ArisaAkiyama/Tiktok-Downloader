# Changelog

All notable changes to TikDown will be documented in this file.

## [1.2.0] - 2025-12-24

### Added
- 💾 **Download All Button** - One-click download for all carousel photos
- 🍪 **Cookie Auto-Refresh** - Automatically syncs TikTok cookies from browser before each download
- 🔍 **Auto-detect on Page** - Automatically detects video/photo when browsing TikTok, shows badge indicator
- Progress indicator on button showing download progress (e.g. ⏳ 3/18)
- Support for carousels with unlimited photos (tested up to 18+)

### Fixed
- 🔧 **Carousel Extraction Reliability** - Fixed issue where browser pool cache interfered with photo capture
- Photo stories now use fresh browser instance for reliable network interception
- Fixed "Mengekstrak video..." text to "Mengekstrak media..." for photo content

### Improved
- 🖼️ **Larger Thumbnail Preview** - Preview popup enlarged from 320x400 to 450x600 with pop-in animation
- Enhanced thumbnail hover effect with pink glow border
- More robust photomode image detection
- Cleaner console output (removed verbose debug logs)
- Better deduplication of carousel images

---

## [1.1.0] - 2025-12-22

### Added
- 📸 **Carousel Photos Support** - Download all photos from TikTok slideshow/carousel posts
- Automatic detection of photo vs video posts
- Multi-photo extraction using Performance API for accurate URL capture
- Slide navigation automation to capture all images in carousel

### Improved
- Enhanced page-capture.js for better photo detection
- Better error handling for carousel posts
- Updated scraper.js with carousel-specific logic

---

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
