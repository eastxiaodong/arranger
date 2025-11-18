const fs = require('fs');
const path = require('path');

// 复制 WebView 资源
function copyWebviewAssets() {
  const SRC_DIR = path.join(__dirname, '..', 'src', 'presentation', 'webview');
  const DIST_DIR = path.join(__dirname, '..', 'dist', 'presentation', 'webview');
  const FILES = ['minimal-panel.html'];

  fs.mkdirSync(DIST_DIR, { recursive: true });
  FILES.forEach((file) => {
    const src = path.join(SRC_DIR, file);
    const dest = path.join(DIST_DIR, file);
    if (!fs.existsSync(src)) {
      console.warn(`[copy-assets] Missing source file: ${src}`);
      return;
    }
    fs.copyFileSync(src, dest);
    console.log(`[copy-assets] Copied webview: ${file}`);
  });
}

// 复制 WASM 文件和 sql.js 文件
function copyWasmAssets() {
  const SQL_JS_SRC = path.join(__dirname, '..', 'node_modules', 'sql.js');
  const SQL_JS_DEST = path.join(__dirname, '..', 'dist', 'node_modules', 'sql.js');
  const WASM_SRC = path.join(SQL_JS_SRC, 'dist');
  const WASM_DEST = path.join(SQL_JS_DEST, 'dist');
  const WASM_FILES = ['sql-wasm.wasm', 'sql-wasm-debug.wasm', 'sql-wasm.js', 'sql-wasm-debug.js'];

  // 复制 package.json
  fs.mkdirSync(SQL_JS_DEST, { recursive: true });
  const pkgSrc = path.join(SQL_JS_SRC, 'package.json');
  const pkgDest = path.join(SQL_JS_DEST, 'package.json');
  if (fs.existsSync(pkgSrc)) {
    fs.copyFileSync(pkgSrc, pkgDest);
    console.log(`[copy-assets] Copied: package.json`);
  }

  // 复制 WASM 和 JS 文件
  fs.mkdirSync(WASM_DEST, { recursive: true });
  WASM_FILES.forEach((file) => {
    const src = path.join(WASM_SRC, file);
    const dest = path.join(WASM_DEST, file);
    if (!fs.existsSync(src)) {
      console.warn(`[copy-assets] Missing file: ${src}`);
      return;
    }
    fs.copyFileSync(src, dest);
    console.log(`[copy-assets] Copied: ${file}`);
  });
}

// 执行复制
try {
  copyWebviewAssets();
  copyWasmAssets();
  console.log('[copy-assets] All assets copied successfully');
} catch (error) {
  console.error('[copy-assets] Error copying assets:', error);
  process.exit(1);
}
