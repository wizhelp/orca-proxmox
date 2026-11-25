// Serves the map harness on 127.0.0.1 for a browser check.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html' }
http
  .createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0])
    const file = path.join(dir, name === '/' ? 'index.html' : name)
    fs.readFile(file, (error, body) => {
      if (error) {
        res.statusCode = 404
        return res.end()
      }
      res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream')
      res.end(body)
    })
  })
  .listen(47913, '127.0.0.1', () => console.log('serving'))
