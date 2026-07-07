// One-time utility: rasterizes public/icons/icon-source.svg (the LTA logo on the app's
// dark background) into every PNG size needed for the web app manifest, iOS home-screen
// icons, and the browser tab favicon. Uses sharp (already a project dependency) -- free,
// no external service. Re-run any time icon-source.svg changes.
//
// Usage: node scripts/generate-pwa-icons.js

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ICON_DIR = path.join(__dirname, '..', 'public', 'icons');
const SOURCE_SVG = path.join(ICON_DIR, 'icon-source.svg');

// [filename, pixel size]. 192/512 are the manifest.json baseline sizes every PWA needs;
// 180 is what iOS specifically looks for (apple-touch-icon); 32 is a standard favicon size.
const TARGETS = [
    ['icon-512.png', 512],
    ['icon-192.png', 192],
    ['apple-touch-icon.png', 180],
    ['favicon-32.png', 32],
];

async function main() {
    const svgBuffer = fs.readFileSync(SOURCE_SVG);
    for (const [filename, size] of TARGETS) {
        await sharp(svgBuffer, { density: 384 }) // high density so small raster targets aren't blurry when downscaled from the vector source
            .resize(size, size)
            .png()
            .toFile(path.join(ICON_DIR, filename));
        console.log(`Generated ${filename} (${size}x${size})`);
    }
    console.log('\nDone.');
}

main().catch(err => {
    console.error('Icon generation failed:', err);
    process.exit(1);
});
