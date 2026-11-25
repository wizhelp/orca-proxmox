A throwaway self-signed certificate for `localhost` / `127.0.0.1`, used only by
`test/http.test.ts` to run a loopback HTTPS server and check certificate pinning. The key
protects nothing; regenerate with:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 \
  -subj "/O=proxmox-visualizer tests/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout server.key -out server.crt
```
