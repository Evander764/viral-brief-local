#!/usr/bin/env node
/**
 * Build a lightweight macOS .app bundle.
 *
 * The app is a small launcher around the existing local Node service. It keeps
 * user data outside the bundle under ~/Library/Application Support/Viral Brief,
 * so app upgrades do not overwrite the local database or encrypted API key.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const appName = 'Viral Brief';
const productSlug = 'viral-brief-local';
const versionTag = `${pkg.version}-${stamp}`;
const distDir = join(ROOT, 'dist');
const macDir = join(distDir, 'mac');
const releasesDir = join(distDir, 'releases');
const appBundle = join(macDir, `${appName}.app`);
const contentsDir = join(appBundle, 'Contents');
const macosDir = join(contentsDir, 'MacOS');
const resourcesDir = join(contentsDir, 'Resources');
const bundledAppDir = join(resourcesDir, 'app');

const excludes = new Set([
  '.git',
  '.DS_Store',
  'data',
  'dist',
  'node_modules',
]);

function shouldCopy(src) {
  const rel = relative(ROOT, src);
  const [top] = rel.split('/');
  return rel && !excludes.has(top) && !rel.endsWith('.log');
}

function copyProject() {
  mkdirSync(bundledAppDir, { recursive: true });
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'README.md', '.env.example', '.gitignore', 'package.json']) {
    const src = join(ROOT, name);
    if (existsSync(src)) cpSync(src, join(bundledAppDir, name), { recursive: true });
  }
  for (const name of ['extension', 'scripts', 'server', 'test', 'web']) {
    const src = join(ROOT, name);
    if (existsSync(src) && shouldCopy(src)) cpSync(src, join(bundledAppDir, name), { recursive: true });
  }
}

function writeInfoPlist() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>ViralBrief</string>
  <key>CFBundleIdentifier</key>
  <string>local.viralbrief.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${pkg.version}</string>
  <key>CFBundleVersion</key>
  <string>${stamp}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
  writeFileSync(join(contentsDir, 'Info.plist'), plist);
}

function writeLauncher() {
  const launcher = `#!/bin/zsh
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
APP_SUPPORT_DIR="$HOME/Library/Application Support/Viral Brief"
LOG_DIR="$HOME/Library/Logs/Viral Brief"
PORT="\${VB_PORT:-8787}"
URL="http://127.0.0.1:\${PORT}"

mkdir -p "$APP_SUPPORT_DIR" "$LOG_DIR"
export VB_DATA_DIR="\${VB_DATA_DIR:-$APP_SUPPORT_DIR}"
export VB_OPEN_BROWSER="\${VB_OPEN_BROWSER:-true}"

if command -v curl >/dev/null 2>&1 && curl -fsS "$URL/api/health" >/dev/null 2>&1; then
  open "$URL"
  exit 0
fi

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [[ -z "$NODE_BIN" ]]; then
  osascript -e 'display alert "Viral Brief 需要 Node.js" message "请先安装 Node.js 22.5 或更高版本，然后重新打开应用。" as critical'
  exit 1
fi

NODE_OK="$("$NODE_BIN" -e 'const [M,m]=process.versions.node.split(".").map(Number); process.stdout.write(M>22||M===22&&m>=5?"1":"0")')"
if [[ "$NODE_OK" != "1" ]]; then
  NODE_VER="$("$NODE_BIN" -v)"
  osascript -e "display alert \\"Node.js 版本过低\\" message \\"当前版本：$NODE_VER。Viral Brief 需要 Node.js 22.5 或更高版本。\\" as critical"
  exit 1
fi

cd "$APP_ROOT"
LOG_FILE="$LOG_DIR/app-$(date +%Y%m%d).log"
exec "$NODE_BIN" --disable-warning=ExperimentalWarning server/index.js >> "$LOG_FILE" 2>&1
`;
  const launcherPath = join(macosDir, 'ViralBrief');
  writeFileSync(launcherPath, launcher);
  chmodSync(launcherPath, 0o755);
}

function writeReadme() {
  const text = `Viral Brief for macOS

版本：${pkg.version}
打包时间：${new Date().toISOString()}

打开方式：
1. 双击 Viral Brief.app。
2. 应用会启动本地服务并打开 http://127.0.0.1:8787。
3. 本地数据保存在 ~/Library/Application Support/Viral Brief。
4. 日志保存在 ~/Library/Logs/Viral Brief。

运行要求：
- macOS 12 或更高版本。
- Node.js 22.5 或更高版本。

安全说明：
- API Key、数据库、截图和导出文件都不会写入应用包。
- 服务仍只监听 127.0.0.1。
`;
  writeFileSync(join(resourcesDir, 'README.txt'), text);
}

function makeArchives() {
  const appZip = join(releasesDir, `${appName}-${versionTag}-mac.zip`);
  const sourceArchive = join(releasesDir, `${productSlug}-${versionTag}-source.tar.gz`);

  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, appZip]);
  execFileSync('tar', [
    '--exclude', './data',
    '--exclude', './dist',
    '--exclude', './node_modules',
    '--exclude', './.git',
    '--exclude', './*.log',
    '-czf',
    sourceArchive,
    '.',
  ], { cwd: ROOT });

  const manifest = [
    `version=${pkg.version}`,
    `stamp=${stamp}`,
    `app_bundle=${appBundle}`,
    `app_zip=${appZip}`,
    `source_archive=${sourceArchive}`,
    'data_excluded=true',
    'node_modules_excluded=true',
  ].join('\n') + '\n';
  writeFileSync(join(releasesDir, `${productSlug}-${versionTag}-manifest.txt`), manifest);

  return { appBundle, appZip, sourceArchive };
}

rmSync(appBundle, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });
mkdirSync(releasesDir, { recursive: true });

copyProject();
writeInfoPlist();
writeLauncher();
writeReadme();
const outputs = makeArchives();

console.log(JSON.stringify(outputs, null, 2));
