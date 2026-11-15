import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : readPackageVersion()

function readPackageVersion() {
  try {
    return createRequire(import.meta.url)('../package.json').version
  } catch {
    try {
      return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version
    } catch {
      return 'dev'
    }
  }
}
