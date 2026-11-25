// Writes the harness pages (light and dark): the panel's index.html with a stand-in `orca` frame
// API that answers from data.json and keeps storage in memory.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = path.dirname(fileURLToPath(import.meta.url))
const [source, theme = 'light', target = dir] = process.argv.slice(2)
let html = fs.readFileSync(source, 'utf8')
const vars =
  theme === 'dark'
    ? '--orca-background:#18181b;--orca-foreground:#f4f4f5;--orca-border:#3f3f46;--orca-input:#52525b;--orca-muted:#27272a;--orca-muted-foreground:#a1a1aa;--orca-primary:#fafafa;--orca-primary-foreground:#18181b;--orca-card:#1f1f23;--orca-card-foreground:#f4f4f5;--orca-accent:#3f3f46;--orca-accent-foreground:#fafafa;--orca-popover:#27272a;--orca-ring:#60a5fa;--orca-destructive:#ef4444;--orca-radius:8px'
    : '--orca-background:#ffffff;--orca-foreground:#18181b;--orca-border:#e4e4e7;--orca-input:#d4d4d8;--orca-muted:#f4f4f5;--orca-muted-foreground:#71717a;--orca-primary:#18181b;--orca-primary-foreground:#fafafa;--orca-card:#ffffff;--orca-card-foreground:#18181b;--orca-accent:#f4f4f5;--orca-accent-foreground:#18181b;--orca-popover:#ffffff;--orca-ring:#2563eb;--orca-destructive:#dc2626;--orca-radius:8px'
const stub = `<script>
  document.documentElement.classList.add(${JSON.stringify(theme)});
  document.documentElement.style.cssText = ${JSON.stringify(vars)};
  const store = {}; const listeners = []; window.__store = store; window.__requests = [];
  const data = fetch('./data.json').then((r) => r.json());
  window.orca = {
    locale: 'en',
    shell: { openExternal: async (url) => { window.__opened = url; return { opened: true } } },
    plugin: {
      request: async (name, input) => {
        window.__requests.push([name, input]);
        const d = await data;
        if (name === 'estate.get') return d.estate;
        if (name === 'config.get') return d.config;
        if (name === 'connection.test') return { ok: true, version: '1.1.10', remotes: 5 };
        if (name === 'config.save') return d.config;
        if (name === 'orca.link') return { links: {} };
        if (name === 'orca.terminal') return { how: 'workspace', navigated: true, where: 'the example workspace' };
        throw Object.assign(new Error('unknown ' + name), { code: 'unknown_method' });
      }
    },
    storage: {
      get: async (k) => store[k] ?? null,
      set: async (k, v) => { store[k] = v; listeners.forEach((l) => l({ key: k })) },
      onDidChange: (l) => { listeners.push(l); return { dispose() {} } }
    }
  };
</script>`
html = html.replace('<script type="module" src="./main.ts"></script>', `${stub}\n    <script type="module" src="./app.js"></script>`)
fs.writeFileSync(path.join(target, theme === 'dark' ? 'dark.html' : 'index.html'), html)
console.log('ok', theme)
