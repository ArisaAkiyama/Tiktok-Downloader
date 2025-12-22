/**
 * TikDown Icon Generator
 * Creates extension icons in multiple sizes
 * Run: node create-icons.js
 */

const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.join(__dirname, 'extension', 'icons');
const SIZES = [16, 48, 128];

// TikTok-inspired SVG icon
function createSvgIcon(size) {
    return `
<svg width="${size}" height="${size}" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#25F4EE"/>
      <stop offset="50%" style="stop-color:#FE2C55"/>
      <stop offset="100%" style="stop-color:#000"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bg)"/>
  <path d="M64 32 L64 80 Q64 96 48 96 Q32 96 32 80 Q32 64 48 64" 
        fill="none" stroke="white" stroke-width="10" stroke-linecap="round"/>
  <path d="M64 32 Q80 32 88 24" 
        fill="none" stroke="white" stroke-width="10" stroke-linecap="round"/>
  <path d="M88 24 Q88 48 104 52" 
        fill="none" stroke="white" stroke-width="10" stroke-linecap="round"/>
  <path d="M80 100 L80 76 L96 88 Z" fill="white"/>
</svg>
`;
}

function createPlaceholderIcons() {
    // Create simple placeholder SVG icons
    if (!fs.existsSync(ICONS_DIR)) {
        fs.mkdirSync(ICONS_DIR, { recursive: true });
    }

    // Create SVG files as placeholders  
    for (const size of SIZES) {
        const svgContent = createSvgIcon(size);
        fs.writeFileSync(
            path.join(ICONS_DIR, `icon${size}.svg`),
            svgContent
        );
        console.log(`✅ Created icon${size}.svg (placeholder)`);
    }

    console.log('\n⚠️ SVG placeholders created. Install sharp and run again for PNG icons:');
    console.log('   npm install sharp');
    console.log('   node create-icons.js');
}

async function createIcons() {
    // Ensure icons directory exists
    if (!fs.existsSync(ICONS_DIR)) {
        fs.mkdirSync(ICONS_DIR, { recursive: true });
    }

    for (const size of SIZES) {
        const svgBuffer = Buffer.from(createSvgIcon(128));

        await sharp(svgBuffer)
            .resize(size, size)
            .png()
            .toFile(path.join(ICONS_DIR, `icon${size}.png`));

        console.log(`✅ Created icon${size}.png`);
    }

    console.log('\n🎉 All icons created successfully!');
}

// Check if sharp is available and run appropriate function
let sharp;
try {
    sharp = require('sharp');
    createIcons().catch(console.error);
} catch (e) {
    console.log('Sharp not installed. Creating placeholder icons...');
    createPlaceholderIcons();
}
