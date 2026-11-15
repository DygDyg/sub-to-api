import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
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
await mkdir(buildDir, { recursive: true })
await mkdir(outputDir, { recursive: true })

const esbuild = require('esbuild')
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
await copyFile(join(root, 'scripts', 'portable-start.bat'), join(outputDir, 'start.bat'))
await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(outputDir, 'THIRD_PARTY_NOTICES.md'))
await writeFile(join(outputDir, 'README.txt'), `SubToAPI
========

Запуск: start.bat
Интерфейс: http://127.0.0.1:8787
OpenAI API: http://127.0.0.1:8787/v1

Node.js устанавливать не нужно. Эту папку можно целиком отправить другому человеку.
Каждый запускает свой экземпляр и входит в свои подписки. Настройки и токены
создаются в папке settings рядом с программой. Эту папку не нужно отправлять
вместе с программой: в ней ключи входа.
`, 'utf8')
console.log(`Готово: ${outputDir}`)
