// Builds the browser harness into dev/harness/out: the panel bundled with esbuild, recorded data,
// and light and dark pages with a stand-in Orca frame API. Run `npm run harness`, then open
// http://127.0.0.1:47913/ (or /dark.html) to see and drag the panel without Orca or a server.
import { execFileSync } from 'node:child_process'
import { mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const out = join(here, 'out')
mkdirSync(out, { recursive: true })
const npx = (...args) => execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', ...args], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
npx('esbuild@0.24.0', 'src/ui/main.ts', '--bundle', '--format=esm', `--outfile=${join(out, 'app.js')}`)
npx('tsx@4.23.15', join(here, 'data.mts'), join(out, 'data.json'))
for (const theme of ['light', 'dark']) execFileSync(process.execPath, [join(here, 'pages.mjs'), join(root, 'src/ui/index.html'), theme, out], { stdio: 'inherit' })
copyFileSync(join(here, 'serve.mjs'), join(out, 'serve.mjs'))
copyFileSync(join(here, 'listing.html'), join(out, 'listing.html'))
