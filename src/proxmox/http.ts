// HTTPS for the worker, with optional certificate pinning. Proxmox products ship self-signed
// certificates, so a person can pin the server's SHA-256 fingerprint instead of trusting a CA.
//
// With a pin, the TLS handshake completes and the fingerprint is compared BEFORE any HTTP bytes
// (and so the Authorization header) are written: the request is sent over the already-verified
// socket. Without a pin, Node's normal CA and hostname checks apply.
import * as http from 'node:http'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { normalizeFingerprint, type ErrorKind } from '../model'

export type HttpRequest = {
  method: 'GET'
  url: URL
  headers: Record<string, string>
  /** Pinned fingerprint (`AA:BB:...`); empty or absent uses the system CAs. */
  fingerprint?: string
  timeoutMs: number
  signal?: AbortSignal
}

export type HttpResponse = {
  status: number
  contentType: string
  body: string
}

/** Every request goes through one of these; tests swap in a recorded one. */
export type Transport = (request: HttpRequest) => Promise<HttpResponse>

export class TransportError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly presentedFingerprint?: string
  ) {
    super(message)
    this.name = 'TransportError'
  }
}

const MAX_BODY_BYTES = 32 * 1024 * 1024

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER'
])

function mapSocketError(error: NodeJS.ErrnoException, url: URL): TransportError {
  const code = error.code ?? ''
  if (TLS_ERROR_CODES.has(code)) {
    return new TransportError('tls', `TLS verification failed for ${url.host}: ${code}`)
  }
  if (code === 'ETIMEDOUT') return new TransportError('timeout', `Timed out connecting to ${url.host}`)
  return new TransportError('unreachable', `Cannot reach ${url.host}: ${code || error.message}`)
}

function connectOptions(url: URL): tls.ConnectionOptions {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return {
    host,
    port: Number(url.port || 443),
    // SNI must not be an IP address.
    servername: net.isIP(host) ? undefined : host,
    ALPNProtocols: ['http/1.1']
  }
}

/** Opens a TLS socket and resolves once it is verified: by the pin when given, else by CAs. */
function connect(url: URL, pin: string | null, signal: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ ...connectOptions(url), rejectUnauthorized: pin === null })
    const fail = (error: TransportError) => {
      socket.destroy()
      reject(error)
    }
    const onAbort = () => fail(new TransportError('timeout', `Timed out talking to ${url.host}`))
    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      fail(mapSocketError(error, url))
    })
    socket.once('secureConnect', () => {
      signal.removeEventListener('abort', onAbort)
      if (pin !== null) {
        const presented = normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? '')
        if (presented !== pin) {
          fail(
            new TransportError(
              'fingerprint-mismatch',
              `The certificate of ${url.host} does not match the pinned fingerprint`,
              presented ?? undefined
            )
          )
          return
        }
      }
      resolve(socket)
    })
  })
}

/**
 * Reads the fingerprint a server presents without verifying or sending anything, so a TLS error
 * can show the person what to compare and pin. Null when it cannot be read.
 */
export function probeFingerprint(url: URL, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = tls.connect({ ...connectOptions(url), rejectUnauthorized: false })
    const done = (value: string | null) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    socket.once('error', () => done(null))
    socket.once('secureConnect', () =>
      done(normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? ''))
    )
  })
}

/** The real transport: Node's TLS and HTTP/1.1, one connection per request. */
export const nodeTransport: Transport = async (request) => {
  const { url } = request
  if (url.protocol !== 'https:') {
    throw new TransportError('invalid-config', 'Only https:// URLs are allowed')
  }
  let pin: string | null = null
  if (request.fingerprint) {
    pin = normalizeFingerprint(request.fingerprint)
    if (pin === null) throw new TransportError('invalid-config', 'The pinned fingerprint is not a SHA-256 fingerprint')
  }

  // Already cancelled (a queued job after a connection change): no connection is opened at all.
  if (request.signal?.aborted) throw new TransportError('timeout', 'The request was cancelled')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs)
  const onOuterAbort = () => controller.abort()
  request.signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const socket = await connect(url, pin, controller.signal)
    // An agent that hands out only the verified socket. (`agent: false` with a `createConnection`
    // option is not enough: Node then builds its own agent, which opens a fresh plain TCP socket.)
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 })
    agent.createConnection = () => socket
    return await new Promise<HttpResponse>((resolve, reject) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port || 443,
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers: request.headers,
          agent
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
              req.destroy()
              reject(new TransportError('protocol', `The answer from ${url.host} is too large`))
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks).toString('utf8')
            })
          )
          res.on('error', (error) => reject(mapSocketError(error, url)))
        }
      )
      const onAbort = () => {
        req.destroy()
        reject(new TransportError('timeout', `Timed out waiting for ${url.host}`))
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      req.on('error', (error) => reject(mapSocketError(error, url)))
      req.on('close', () => controller.signal.removeEventListener('abort', onAbort))
      req.end()
    })
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onOuterAbort)
  }
}
