import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'dist')
const outputDir = join(root, 'release', 'SubToAPI')
const executable = join(outputDir, 'sub-to-api.exe')
const require = createRequire(import.meta.url)

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} завершился с кодом ${result.status ?? 1}`)
}

await rm(buildDir, { recursive: true, force: true })
await rm(outputDir, { recursive: true, force: true })
await mkdir(buildDir, { recursive: true })
await mkdir(outputDir, { recursive: true })

const esbuild = require('esbuild')
const version = await archiveVersion()
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/cli.js'],
  outfile: join(buildDir, 'app.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node:sea'],
  legalComments: 'none',
  define: { __APP_VERSION__: JSON.stringify(version) },
})

const config = {
  main: 'dist/app.cjs',
  output: 'dist/sea.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  assets: {
    'index.html': 'web/index.html',
    'app.js': 'web/app.js',
    'icon.png': 'web/icon.png',
    'providers/antigravity.png': 'web/providers/antigravity.png',
    'providers/claude.png': 'web/providers/claude.png',
    'providers/codex.png': 'web/providers/codex.png',
    'providers/copilot.png': 'web/providers/copilot.png',
    'providers/grok.png': 'web/providers/grok.png',
    'providers/grokbot.png': 'web/providers/grokbot.png',
    'bootstrap.min.css': 'web/bootstrap.min.css',
  },
}
await writeFile(join(root, 'sea-config.json'), JSON.stringify(config, null, 2))
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'])
await copyFile(process.execPath, executable)
await chmod(executable, 0o755).catch(() => undefined)

const postject = require.resolve('postject/dist/cli.js')
run(process.execPath, [
  postject,
  executable,
  'NODE_SEA_BLOB',
  join(buildDir, 'sea.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--overwrite',
])

run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'set-exe-icon.ps1'), '-Exe', executable, '-Icon', join(root, 'assets', 'icon.ico')])
await hideConsole(executable)
const updater = join(outputDir, 'updater.exe')
run(findCsc(), ['/nologo', '/target:winexe', '/optimize+', `/out:${updater}`, join(root, 'scripts', 'updater.cs')])
await copyFile(join(root, 'scripts', 'tray.ps1'), join(outputDir, 'tray.ps1'))
await copyFile(join(root, 'scripts', 'update.ps1'), join(outputDir, 'update.ps1'))
await copyFile(join(root, 'assets', 'icon.ico'), join(outputDir, 'icon.ico'))
await copyFile(join(root, 'scripts', 'portable-start.bat'), join(outputDir, 'start.bat'))
await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(outputDir, 'THIRD_PARTY_NOTICES.md'))
await writeFile(join(outputDir, 'README.txt'), `SubToAPI ${version}
========

Запуск: start.bat
Интерфейс: http://127.0.0.1:8787
OpenAI API: http://127.0.0.1:8787/v1

Параметры запуска (для start.bat и sub-to-api.exe):
  --console   показать окно консоли с логом сервера; закрытие окна останавливает сервер
  --no-tray   не создавать иконку в трее
Пример: start.bat --console --no-tray
Node.js устанавливать не нужно. Эту папку можно целиком отправить другому человеку.
Каждый запускает свой экземпляр и входит в свои подписки. Настройки и токены
создаются в папке settings рядом с программой. Эту папку не нужно отправлять
вместе с программой: в ней ключи входа.
Обновления применяет updater.exe; ход обновления записывается в settings\\update.log.
`, 'utf8')
const archive = await zipPortable(version)
const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(join(root, 'release', 'SHA256SUMS.txt'), `${archiveHash}  ${basename(archive)}\n`, 'utf8')
await writeFile(join(root, 'release', 'RELEASE_NOTES.txt'), `Портативная сборка Windows ${version}.

Распакуйте архив и запустите start.bat. Node.js устанавливать не нужно.
Папка settings в архив не входит: токены создаются локально при первом запуске.
Начиная с этой версии программа сама сообщает о новых релизах и обновляется по кнопке в интерфейсе.
`, 'utf8')
console.log(`Готово: ${outputDir}`)
console.log(`Архив: ${archive}`)

function findCsc() {
  const windows = process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  const compiler = candidates.find(existsSync)
  if (!compiler) throw new Error('Не найден системный компилятор C# csc.exe')
  return compiler
}

async function hideConsole(exe) {
  const bytes = await readFile(exe)
  const pe = bytes.readUInt32LE(0x3c)
  if (bytes.readUInt32LE(pe) !== 0x4550) throw new Error('sub-to-api.exe is not a PE file')
  const magic = bytes.readUInt16LE(pe + 24)
  if (magic !== 0x20b && magic !== 0x10b) throw new Error('Unknown PE optional header')
  bytes.writeUInt16LE(2, pe + 24 + 68)
  await writeFile(exe, bytes)
}

async function archiveVersion() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const tagged = process.env.SUB_TO_API_VERSION?.trim().replace(/^v/, '')
  if (tagged && tagged !== pkg.version) {
    throw new Error(`Тег v${tagged} не совпадает с версией package.json (${pkg.version})`)
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version)) throw new Error(`Некорректная версия: ${pkg.version}`)
  return pkg.version
}

async function zipPortable(version) {
  const stageRoot = join(root, 'release', '.stage')
  const stage = join(stageRoot, 'SubToAPI')
  const archive = join(root, 'release', `SubToAPI-${version}-win-x64.zip`)
  await rm(stageRoot, { recursive: true, force: true })
  await rm(archive, { force: true })
  await mkdir(stage, { recursive: true })
  for (const name of ['sub-to-api.exe', 'updater.exe', 'start.bat', 'tray.ps1', 'update.ps1', 'icon.ico', 'README.txt', 'THIRD_PARTY_NOTICES.md']) {
    await copyFile(join(outputDir, name), join(stage, name))
  }
  run('tar.exe', ['-a', '-c', '-f', archive, '-C', stageRoot, 'SubToAPI'])
  await rm(stageRoot, { recursive: true, force: true })
  return archive
}
