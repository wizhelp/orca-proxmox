// A read-only Proxmox API client: token auth, `{ data }` unwrapping and error mapping. The same
// client serves PDM, PVE and PBS; only the Authorization scheme differs between them.
import type { ConnectionConfig, SourceError, SourceKind } from '../model'
import { probeFingerprint, TransportError, type Transport } from './http'

/**
 * Token header per product. PVE separates token id and secret with `=`; PBS and PDM with `:`.
 * https://pdm.proxmox.com/docs/access-control.html ("API Tokens").
 */
const AUTH_SCHEMES: Record<SourceKind, (tokenId: string, secret: string) => string> = {
  pdm: (id, secret) => `PDMAPIToken=${id}:${secret}`,
  pve: (id, secret) => `PVEAPIToken=${id}=${secret}`,
  pbs: (id, secret) => `PBSAPIToken=${id}:${secret}`
}

export class ApiError extends Error {
  constructor(readonly info: SourceError) {
    super(info.message)
    this.name = 'ApiError'
  }
}

export type ClientOptions = {
  connection: ConnectionConfig
  secret: string
  transport: Transport
  timeoutMs?: number
  /** Probe the presented certificate on TLS errors (off in tests that use a fake transport). */
  probe?: (url: URL) => Promise<string | null>
}

export type Query = Record<string, string | number | boolean | undefined>

/** `https://h:8443/`, `https://h:8443/api2/json` -> `https://h:8443`. Throws on anything else. */
export function normalizeBaseUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new ApiError({ kind: 'invalid-config', message: `"${input}" is not a URL` })
  }
  if (url.protocol !== 'https:') {
    throw new ApiError({ kind: 'invalid-config', message: 'The base URL must start with https://' })
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ApiError({ kind: 'invalid-config', message: 'The base URL must not carry credentials, a query or a fragment' })
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api2\/json$/, '')
  return `${url.origin}${path}`
}

export class ProxmoxClient {
  readonly baseUrl: string
  private readonly authorization: string

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.connection.baseUrl)
    this.authorization = AUTH_SCHEMES[options.connection.kind](options.connection.tokenId, options.secret)
  }

  /** GET `/api2/json<path>` and answer its `data`. */
  async get<T>(path: string, query: Query = {}, signal?: AbortSignal): Promise<T> {
    // Cancelled before it started (queued behind others when the connection changed): not sent.
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new ApiError({ kind: 'timeout', message: 'The request was cancelled' })
    const url = new URL(`${this.baseUrl}/api2/json${path}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    let response
    try {
      response = await this.options.transport({
        method: 'GET',
        url,
        headers: { Authorization: this.authorization, Accept: 'application/json' },
        fingerprint: this.options.connection.fingerprint || undefined,
        timeoutMs: this.options.timeoutMs ?? 15000,
        signal
      })
    } catch (error) {
      throw await this.transportFailure(error, url)
    }
    if (response.status === 401) {
      throw new ApiError({
        kind: 'auth',
        status: 401,
        message: 'The API token was rejected (401)',
        hint: 'Check the token ID (user@realm!name) and secret, and that the token has not expired or been removed.'
      })
    }
    if (response.status === 403) {
      throw new ApiError({
        kind: 'forbidden',
        status: 403,
        message: `The token may not read ${path} (403)`,
        hint: 'Give the token (and its user) the Auditor role on /resource, or on each remote.'
      })
    }
    if (response.status < 200 || response.status >= 300) {
      // Written here, never the server's body: a proxy can echo request headers in its error
      // page, and the request carries the token.
      throw new ApiError({
        kind: 'http',
        status: response.status,
        message: `${path} answered HTTP ${response.status}${statusText(response.status)}`,
        ...(response.status >= 500 ? { hint: 'PDM or the remote behind it reported an error; PDM’s own task and system logs say more.' } : {})
      })
    }
    return parseData<T>(response.body, response.contentType, path)
  }

  private async transportFailure(error: unknown, url: URL): Promise<ApiError> {
    if (!(error instanceof TransportError)) {
      return new ApiError({ kind: 'unreachable', message: error instanceof Error ? error.message : String(error) })
    }
    const info: SourceError = { kind: error.kind, message: error.message }
    if (error.kind === 'fingerprint-mismatch') {
      info.presentedFingerprint = error.presentedFingerprint
      info.hint =
        'The server presented a different certificate. If it was renewed on purpose, compare the new fingerprint with the one shown in Proxmox and pin it; otherwise do not connect.'
    } else if (error.kind === 'tls') {
      const probe = this.options.probe ?? probeFingerprint
      info.presentedFingerprint = (await probe(url).catch(() => null)) ?? undefined
      info.hint =
        'Proxmox uses a self-signed certificate by default. Pin its SHA-256 fingerprint (shown under Certificates in Proxmox) after checking it matches.'
    } else if (error.kind === 'unreachable' || error.kind === 'timeout') {
      info.hint = 'Check the URL and port (PDM listens on 8443) and that this machine can reach it.'
    }
    return new ApiError(info)
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: 'bad request',
  404: 'not found: an older PDM, or the item is gone',
  408: 'request timeout',
  429: 'too many requests',
  500: 'internal error',
  501: 'not implemented by this PDM',
  502: 'bad gateway',
  503: 'unavailable',
  504: 'gateway timeout'
}

function statusText(status: number): string {
  return STATUS_TEXT[status] ? ` (${STATUS_TEXT[status]})` : ''
}

/** `{ "data": ... }`, or a JSON text sequence (RFC 7464) from a streaming endpoint. */
export function parseData<T>(body: string, contentType: string, path: string): T {
  try {
    if (contentType.includes('application/json-seq')) {
      return body
        .split('\x1e')
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => JSON.parse(record)) as T
    }
    const parsed = JSON.parse(body) as { data?: unknown }
    if (parsed === null || typeof parsed !== 'object' || !('data' in parsed)) {
      throw new Error('no data field')
    }
    return parsed.data as T
  } catch (error) {
    throw new ApiError({
      kind: 'protocol',
      message: `${path} did not answer Proxmox JSON (${error instanceof Error ? error.message : 'bad body'})`,
      hint: 'Is the base URL a Proxmox Datacenter Manager?'
    })
  }
}

/** Runs `tasks` with at most `limit` at once, keeping their order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index])
    }
  })
  await Promise.all(workers)
  return results
}
