# TikDown - TikTok Video & Photo Downloader

[![GitHub](https://img.shields.io/badge/GitHub-ArisaAkiyama-blue?logo=github)](https://github.com/ArisaAkiyama/Tiktok-Downloader)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js)](https://nodejs.org/)

Download videos, photos, and audio from TikTok with ease. Built with Express.js + Puppeteer backend and Chrome extension.

## ✨ Features

- 🎬 **Download Videos** - Download TikTok videos in original quality
- 📸 **Carousel Photos** - Download all photos from TikTok slideshow/carousel posts (unlimited photos)
- 💾 **Download All** - One-click button to download entire photo carousel
- 🎵 **Extract Audio** - Download just the music/audio track
- 🖼️ **Thumbnails** - Get video cover images
- 📊 **Video Info** - View likes, comments, shares, and caption
- 🌐 **Multiple URL Formats** - Support for various TikTok URL types
- 💾 **Save to Folder** - Organize downloads by username
- 🔄 **Batch Download** - Download multiple items at once

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd ProjectDownloaderTT
npm install
```

### 2. Start the Server

```bash
npm start
```

Server will run at `http://localhost:3000`

### 3. Install Browser Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `extension` folder

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/download` | POST | Extract media from TikTok URL |
| `/api/proxy` | GET | Proxy for CORS bypass |
| `/api/save` | POST | Save media to folder |
| `/api/batch-save` | POST | Batch download to folder |
| `/api/batch-status/:jobId` | GET | Check batch job status |
| `/api/health` | GET | Server health check |

### Example Request

```bash
curl -X POST http://localhost:3000/api/download \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.tiktok.com/@username/video/1234567890"}'
```

### Example Response

```json
{
  "success": true,
  "media": [
    {
      "type": "video",
      "url": "https://...",
      "quality": "original",
      "hasWatermark": false,
      "thumbnail": "https://..."
    },
    {
      "type": "audio",
      "url": "https://...",
      "title": "Song Title",
      "author": "Artist Name"
    }
  ],
  "count": 2,
  "username": "creator_name",
  "caption": "Video caption...",
  "hashtags": ["fyp", "viral"],
  "stats": {
    "likes": 12345,
    "comments": 678,
    "shares": 90,
    "plays": 100000
  }
}
```

## 🔗 Supported URL Formats

- `https://www.tiktok.com/@username/video/1234567890`
- `https://www.tiktok.com/@username/photo/1234567890` (carousel)
- `https://vm.tiktok.com/ABC123/`
- `https://m.tiktok.com/v/1234567890`
- `https://tiktok.com/t/ABC123/`

## 📁 Project Structure

```
ProjectDownloaderTT/
├── server.js              # Express server
├── scraper.js             # TikTok extraction logic
├── browser-manager.js     # Puppeteer browser pool
├── rate-limiter.js        # Rate limiting
├── download-queue.js      # Parallel downloads
├── error-recovery.js      # Error handling & diagnostics
├── package.json
├── .env                   # Environment config
├── extension/
│   ├── manifest.json      # Extension manifest
│   ├── background.js      # Service worker
│   ├── popup/             # Extension popup UI
│   │   ├── popup.html
│   │   ├── popup.css
│   │   ├── popup.js
│   │   ├── settings.html
│   │   ├── settings.css
│   │   └── settings.js
│   ├── content/           # Content scripts
│   │   └── page-capture.js
│   └── icons/
└── public/                # Web UI (optional)
```

## ⚙️ Configuration

Create a `.env` file:

```env
PORT=3000
HEADLESS=true
DOWNLOAD_PATH=D:/Downloads/TikTok
TIMEOUT=60000
```

## 🔧 Troubleshooting

### Server not connecting
- Make sure the server is running (`npm start`)
- Check if port 3000 is available
- Verify the server URL in extension settings

### Video not found
- The video may be private or deleted
- Try refreshing the TikTok page and copying URL again
- Some videos may be region-restricted

### Rate limiting
- The server automatically handles rate limiting
- Wait a few minutes if you see rate limit errors
- Don't make too many requests in quick succession

## 📝 License

MIT License

## 👤 Author

Made with ❤️ by [ArisaAkiyama](https://github.com/ArisaAkiyama)

## ⭐ Support

If you find this project helpful, please give it a star on [GitHub](https://github.com/ArisaAkiyama/Tiktok-Downloader)!
