import { createHash, randomBytes } from 'node:crypto'

export function base64url(buffer) {
  return buffer.toString('base64url')
}

export function createPkce() {
  const verifier = base64url(randomBytes(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

export function randomToken(bytes = 32) {
  return base64url(randomBytes(bytes))
}
