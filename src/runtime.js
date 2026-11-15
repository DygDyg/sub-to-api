import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_DIR } from './storage/store.js'

export const RUNTIME_PATH = join(APP_DIR, 'runtime.json')

/** @param {{pid: number, trayPid?: number, host: string, port: number, configuredPort: number}} runtime */
export async function writeRuntime(runtime) {
  await writeFile(RUNTIME_PATH, JSON.stringify(runtime, null, 2))
}

export async function clearRuntime() {
  await rm(RUNTIME_PATH, { force: true })
}
