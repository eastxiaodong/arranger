const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src', 'presentation', 'webview');
const DIST_DIR = path.join(__dirname, '..', 'dist', 'presentation', 'webview');
const FILES = ['minimal-panel.html'];

fs.mkdirSync(DIST_DIR, { recursive: true });
FILES.forEach((file) => {
  const src = path.join(SRC_DIR, file);
  const dest = path.join(DIST_DIR, file);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-webview-assets] Missing source file: ${src}`);
    return;
  }
  fs.copyFileSync(src, dest);
  console.log(`[copy-webview-assets] Copied ${file}`);
});
