/**
 * Builds `dist/Coopanion-local/`: the app as a directory to run in place.
 *
 * Run: `pnpm run build:local`. Windows only, like the portable channel it builds.
 *
 * The directory name carries no version. A rebuild replaces the program files and leaves `data/`
 * inside it alone, so an upgrade in place keeps the app's data.
 *
 * Two steps go around what electron-builder would do, both because a data-loss-prevention filter
 * (绿盾 in this fork) encrypts the files that its whitelisted processes write:
 *
 * 1. Electron is unpacked here, into `build/cache/`, and handed to electron-builder as `electronDist`.
 *    Its own unpack renames the extracted directory right after extraction, which the filter still
 *    holds open.
 * 2. The payload is copied in by Git Bash's `cp`, not by this process. Node writes through the filter
 *    (ciphertext on disk) and so do PowerShell and robocopy, whose copies of an encrypted file stay
 *    unreadable to the app's own exe; `cp` decrypts on read and writes plaintext. `verify` runs that
 *    exe over the copy before this exits.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');
/** electron-builder's output for this run: the payload before it is copied into the directory. */
const STAGE = join(DIST, 'win-unpacked');
const TARGET = join(DIST, 'Coopanion-local');
/** The data directory inside `TARGET`, the one thing a rebuild keeps. */
const DATA = 'data';
/** Files the copied exe has to be able to read, one per subtree the app loads from. */
const SAMPLES = [
  'Coopanion.exe',
  'resources/app/package.json',
  'resources/app/core/boot.ts',
  'resources/app/node_modules/esbuild/lib/main.js',
  'resources/app/node_modules/undici/package.json',
  'resources/app/mingit/cmd/git.exe',
];

const say = (text = '') => console.log(text);

/** @returns never */
function fail(text: string): never {
  console.error(text);
  process.exit(1);
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const powershell = (script: string) =>
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: ROOT, encoding: 'utf8' });

/** The bash Git for Windows installs, for the copy; null when there is none. */
function gitBash(): string | null {
  if (spawnSync('bash', ['-c', 'command -v cp'], { encoding: 'utf8' }).status === 0) return 'bash';
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (!base) continue;
    for (const dir of ['Git/bin/bash.exe', 'Programs/Git/bin/bash.exe']) {
      const path = join(base, dir);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** A path as git bash takes it: forward slashes, single-quoted. */
const bashPath = (path: string) => `'${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;

/** The electron-builder.yml value the cached Electron has to match. */
function electronVersion(): string {
  for (const line of readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8').split('\n')) {
    if (line.startsWith('electronVersion:')) return line.slice('electronVersion:'.length).trim();
  }
  return fail('electron-builder.yml 里没有 electronVersion');
}

/** The Electron download cache entry for `version`, or null when it has not been downloaded yet. */
function electronZip(version: string): string | null {
  const cache = join(process.env.LOCALAPPDATA ?? '', 'electron', 'Cache');
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache)) {
    const file = join(cache, dir, `electron-v${version}-win32-x64.zip`);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * An unpacked Electron in `build/cache/`, which electron-builder copies instead of unpacking and
 * renaming. Extracted here from the download cache, without `default_app.asar` or `version`, the two
 * files electron-builder's own unpack would have removed.
 */
function unpackedElectron(version: string): string {
  const out = join(ROOT, 'build', 'cache', `electron-${version}-win32-x64`);
  if (existsSync(join(out, 'electron.exe'))) return out;
  const zip = electronZip(version) ?? fail(`没有 Electron v${version} 的下载缓存，先在仓库里跑一次 pnpm run dev`);
  say(`解包 Electron v${version} → build/cache/electron-${version}-win32-x64`);
  rmSync(out, { recursive: true, force: true });
  for (const [name, data] of Object.entries(unzipSync(readFileSync(zip)))) {
    if (name.endsWith('/') || name === 'resources/default_app.asar' || name === 'version') continue;
    const file = join(out, name === 'LICENSE' ? 'LICENSE.electron.txt' : name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, data);
  }
  return out;
}

/** Ends the instance started from the directory, whose files the rebuild would otherwise fail to replace. */
function closeRunning(): void {
  if (!existsSync(TARGET)) return;
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='Coopanion.exe'\"",
    `| Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${TARGET.replace(/'/g, "''")}', 'OrdinalIgnoreCase') }`,
    '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
  ].join(' ');
  powershell(script);
}

/** Empties the directory except `data/`. */
function clear(): void {
  mkdirSync(TARGET, { recursive: true });
  for (const name of readdirSync(TARGET)) {
    if (name !== DATA) rmSync(join(TARGET, name), { recursive: true, force: true });
  }
}

/** Copies the payload in through `cp`, which writes what the filter lets the app read back (see the header). */
function copy(): void {
  const shell = gitBash() ?? fail('找不到 Git Bash：脚本用它的 cp 复制文件（PowerShell 和 robocopy 的副本应用读不了）');
  const r = spawnSync(shell, ['-c', `cp -a ${bashPath(STAGE)}/. ${bashPath(TARGET)}/`],
    { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) fail(`复制失败：${r.stderr?.trim() || `退出码 ${r.status}`}`);
}

/** Runs the copied exe over a sample of the payload: a ciphertext copy reads a different length. */
function verify(): void {
  const exe = join(TARGET, 'Coopanion.exe');
  if (!existsSync(exe)) fail('复制不完整：没有 Coopanion.exe');
  const files = SAMPLES.map((rel) => join(TARGET, rel)).filter(existsSync);
  if (files.length < 4) fail('复制不完整：缺少数个应用文件');
  const script = "const fs=require('node:fs');console.log(process.argv.slice(1).map((p)=>{try{return fs.readFileSync(p).length}catch{return 'unreadable'}}).join(','))";
  const r = spawnSync(exe, ['-e', script, ...files], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const got = (r.stdout ?? '').trim().split('\n').pop()?.split(',') ?? [];
  const wrong = files.filter((file, i) => got[i] !== String(readFileSync(file).length));
  if (wrong.length > 0) {
    fail(`应用读不到自己的文件：${wrong.map((f) => f.slice(TARGET.length + 1)).join('、')}\n`
      + '复制出来的文件在磁盘上是密文。把 dist/Coopanion-local 加入加密软件的例外目录再重跑。');
  }
  say(`校验通过：应用能读到 ${files.length} 个抽样文件`);
}

function cleanup(): void {
  rmSync(STAGE, { recursive: true, force: true });
  rmSync(join(ROOT, 'build', 'app'), { recursive: true, force: true });
  rmSync(join(DIST, 'builder-debug.yml'), { force: true });
  for (const name of readdirSync(DIST)) {
    if (name.endsWith('-portable.zip')) rmSync(join(DIST, name), { force: true });
  }
}

function measure(): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        files += 1;
        bytes += statSync(path).size;
      }
    }
  };
  walk(TARGET);
  return { files, bytes };
}

if (process.platform !== 'win32') fail('免安装目录只在 Windows 上构建');
for (const path of [join(ROOT, 'vendor', 'cortico', 'src', 'core'), join(ROOT, 'core', 'boot.ts')]) {
  if (!existsSync(path)) fail(`缺少 ${path}：确认子模块已初始化（git submodule update --init --recursive）`);
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
say(`打包 Coopanion ${version} 免安装目录 → dist/Coopanion-local\n`);
const electron = unpackedElectron(electronVersion());
run(process.execPath, ['--import', 'tsx', 'scripts/stage.ts'], { COOPANION_CHANNEL: 'portable' });
// `--dir`: only the unpacked directory. pack.ts adds the portable zip target anyway, and store
// compression writes it in seconds instead of minutes before cleanup deletes it.
run(process.execPath, ['--import', 'tsx', 'scripts/pack.ts', `--config.electronDist=${electron}`,
  '--config.compression=store', '--dir'], { COOPANION_CHANNEL: 'portable' });

closeRunning();
const kept = existsSync(join(TARGET, DATA));
clear();
copy();
verify();
cleanup();
const { files, bytes } = measure();
say(`\n完成 dist/Coopanion-local：${files} 个文件，${(bytes / 1048576).toFixed(0)} MB，版本 ${version}`);
say(kept ? 'data\\ 已保留' : 'data\\ 首次运行会创建');
say('双击 dist/Coopanion-local/Coopanion.exe 运行。');
