// The key of a one-click setup, made in the worker with Node's crypto: a one-time RSA key pair per
// run. Its public half is in the script, which encrypts the new token secret to it on the server
// (RSA-OAEP, SHA-256), so a terminal only ever shows ciphertext; the private half lives in this
// process only, and is wiped once used.
import { createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto'

export type OneTimeKey = {
  /** The public half, PEM (SPKI), for the script. */
  publicPem: string
  /** The secret the server encrypted to this key, from its base64; the key is wiped afterwards, used or not. */
  open(ciphertextBase64: string): string | null
  /** Wipes the private half without using it. */
  wipe(): void
}

/** A one-time RSA-3072 key pair for one run's result. */
export function oneTimeKey(): OneTimeKey {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 })
  let der: Buffer | null = privateKey.export({ format: 'der', type: 'pkcs8' })
  const publicPem = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString()
  const wipe = () => {
    der?.fill(0)
    der = null
  }
  return {
    publicPem,
    wipe,
    open(ciphertextBase64) {
      if (!der) return null
      try {
        const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
        const plain = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(ciphertextBase64, 'base64'))
        const text = plain.toString('utf8')
        plain.fill(0)
        return text
      } catch {
        return null
      } finally {
        wipe()
      }
    }
  }
}
