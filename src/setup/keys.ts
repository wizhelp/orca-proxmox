// The keys of a one-click setup, made in the worker with Node's crypto:
// - the tunnel's own SSH key (Ed25519), written by hand in OpenSSH's private key format so ssh
//   reads it on every platform; only its public half goes into the server-side script;
// - a one-time RSA key pair per run: its public half is in the script, which encrypts the new
//   token secret to it on the server (RSA-OAEP, SHA-256), so a terminal only ever shows
//   ciphertext; the private half lives in this process only, and is wiped once used.
import { createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, constants, randomBytes } from 'node:crypto'

const string = (b: Buffer) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(b.length)
  return Buffer.concat([len, b])
}
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

export type TunnelKey = {
  /** `ssh-ed25519 AAAA… <comment>`, for authorized_keys. */
  publicLine: string
  /** The private key in OpenSSH's format (no passphrase): only ever sealed, or in a file ssh reads at once. */
  privatePem: string
}

/** A new Ed25519 key for the tunnel account, with `comment` on its public line. */
export function newTunnelKey(comment: string): TunnelKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url')
  const type = Buffer.from('ssh-ed25519')
  const blob = Buffer.concat([string(type), string(pub)])
  const check = randomBytes(4).readUInt32BE()
  let secret = Buffer.concat([u32(check), u32(check), string(type), string(pub), string(Buffer.concat([seed, pub])), string(Buffer.from(comment))])
  // Padded with 1, 2, 3… to the cipher's block size (8 for "none").
  const pad = (8 - (secret.length % 8)) % 8
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))])
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), string(Buffer.from('none')), string(Buffer.from('none')), string(Buffer.alloc(0)), u32(1), string(blob), string(secret)])
  const lines = body.toString('base64').match(/.{1,70}/g)!.join('\n')
  seed.fill(0)
  secret.fill(0)
  return { publicLine: `ssh-ed25519 ${blob.toString('base64')} ${comment}`, privatePem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n` }
}

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
