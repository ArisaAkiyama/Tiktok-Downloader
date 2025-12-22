/**
 * TikTok Cookie Export Helper
 * 
 * Cara mendapatkan cookies TikTok:
 * 
 * 1. Install extension "EditThisCookie" atau "Cookie-Editor" di browser
 * 2. Login ke TikTok di browser
 * 3. Buka halaman TikTok manapun
 * 4. Klik icon extension cookies
 * 5. Export/Copy semua cookies
 * 6. Paste ke file cookies.json
 * 
 * ATAU gunakan script ini di console browser:
 * 
 * Buka TikTok.com, tekan F12, buka tab Console, paste kode berikut:
 */

const exportScript = `
// Jalankan di console browser TikTok (F12 -> Console)
const cookies = document.cookie.split(';').map(c => {
    const [name, value] = c.trim().split('=');
    return {
        name: name,
        value: value || '',
        domain: '.tiktok.com',
        path: '/',
        httpOnly: false,
        secure: true
    };
});

// Copy ke clipboard
copy(JSON.stringify(cookies, null, 2));
console.log('✅ Cookies copied to clipboard! Paste ke cookies.json');
`;

console.log('='.repeat(50));
console.log('TikTok Cookie Export Helper');
console.log('='.repeat(50));
console.log('');
console.log('Cara 1: Menggunakan Browser Extension');
console.log('-'.repeat(50));
console.log('1. Install "EditThisCookie" atau "Cookie-Editor" extension');
console.log('2. Login ke TikTok di browser');
console.log('3. Klik icon extension');
console.log('4. Export cookies sebagai JSON');
console.log('5. Simpan ke cookies.json');
console.log('');
console.log('Cara 2: Menggunakan Console Browser');
console.log('-'.repeat(50));
console.log('1. Buka TikTok.com dan login');
console.log('2. Tekan F12 untuk buka DevTools');
console.log('3. Pilih tab "Console"');
console.log('4. Paste script berikut dan tekan Enter:');
console.log('');
console.log(exportScript);
console.log('');
console.log('5. Cookies otomatis ter-copy ke clipboard');
console.log('6. Buat file cookies.json dan paste isinya');
console.log('');
console.log('='.repeat(50));
console.log('Cookies penting untuk TikTok:');
console.log('- sessionid (wajib)');
console.log('- sid_tt (wajib)');
console.log('- tt_chain_token');
console.log('- passport_csrf_token');
console.log('='.repeat(50));
