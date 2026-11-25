// Certificate pinning against a loopback HTTPS server with a throwaway self-signed certificate.
// Nothing leaves this machine.
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as https from 'node:https'
import type { AddressInfo } from 'node:net'
import { after, before } from 'node:test'
import { assert, test } from 'orca/testing'
import { nodeTransport, probeFingerprint, TransportError } from '../src/proxmox/http'

const cert = readFileSync(new URL('./fixtures/tls/server.crt', import.meta.url), 'utf8')
const key = readFileSync(new URL('./fixtures/tls/server.key', import.meta.url), 'utf8')
const fingerprint = new X509Certificate(cert).fingerprint256
const WRONG = 'AA:'.repeat(31) + 'AA'

let server: https.Server
let base: string
const seen: { url?: string; authorization?: string }[] = []
/** Anything that reached the TLS port without TLS, e.g. a request written in plain text. */
let plaintext = 0

before(async () => {
  server = https.createServer({ key, cert }, (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization })
    if (req.url?.startsWith('/slow')) return // never answers
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: { ok: true } }))
  })
  server.on('tlsClientError', () => (plaintext += 1))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const request = (path: string, pin?: string, timeoutMs = 5000) =>
  nodeTransport({
    method: 'GET',
    url: new URL(`${base}${path}`),
    headers: { Authorization: 'PDMAPIToken=test@pdm!t:s3cret' },
    fingerprint: pin,
    timeoutMs
  })

async function rejection(promise: Promise<unknown>): Promise<TransportError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof TransportError, `expected a TransportError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the request to fail')
}

test('a matching pin connects to a self-signed server and sends the request', async () => {
  seen.length = 0
  const response = await request('/api2/json/version', fingerprint.toLowerCase().replace(/:/g, ''))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { data: { ok: true } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].authorization, 'PDMAPIToken=test@pdm!t:s3cret')
  assert.equal(plaintext, 0, 'the request must travel over the verified TLS socket')
})

test('a mismatched pin fails before any HTTP byte, so the token is never sent', async () => {
  seen.length = 0
  const error = await rejection(request('/api2/json/version', WRONG))
  assert.equal(error.kind, 'fingerprint-mismatch')
  assert.equal(error.presentedFingerprint, fingerprint)
  assert.equal(seen.length, 0)
})

test('without a pin a self-signed certificate is refused as a TLS error', async () => {
  seen.length = 0
  const error = await rejection(request('/api2/json/version'))
  assert.equal(error.kind, 'tls')
  assert.equal(seen.length, 0)
  assert.equal(await probeFingerprint(new URL(base)), fingerprint)
})

test('plain http and malformed pins are refused without connecting', async () => {
  const http = await rejection(
    nodeTransport({ method: 'GET', url: new URL('http://127.0.0.1:1/'), headers: {}, timeoutMs: 1000 })
  )
  assert.equal(http.kind, 'invalid-config')
  const pin = await rejection(request('/', 'not-a-fingerprint'))
  assert.equal(pin.kind, 'invalid-config')
})

test('a server that never answers times out', async () => {
  const error = await rejection(request('/slow', fingerprint, 300))
  assert.equal(error.kind, 'timeout')
})

test('a closed port is unreachable', async () => {
  const error = await rejection(
    nodeTransport({ method: 'GET', url: new URL('https://127.0.0.1:1/'), headers: {}, fingerprint, timeoutMs: 3000 })
  )
  assert.equal(error.kind, 'unreachable')
})
