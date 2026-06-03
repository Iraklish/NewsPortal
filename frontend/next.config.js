const os = require('os')

// Build the dev-origin allow list dynamically.
//
// Next.js warns/blocks cross-origin requests to /_next/* unless the request's
// Origin is in `allowedDevOrigins`. The Origin a browser sends is always the
// address it loaded the app from — i.e. one of THIS machine's own interface
// addresses (LAN IP, localhost, etc.). Enumerating them here allows access from
// any address that reaches this dev server (e.g. http://10.110.10.122:3000)
// without hand-maintaining a list, and silences the cross-origin warning.
//
// Note: Next 14's matcher requires exact host matches for IPs (wildcards like
// '*' don't match IP addresses and would flip the server into block mode), so a
// concrete, self-updating list is the correct "allow all my origins" approach.
// Override with ALLOWED_DEV_ORIGINS (comma-separated) if you need extra hosts.
function devOrigins() {
  const origins = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni && ni.address) origins.add(ni.address)
    }
  }
  const extra = (process.env.ALLOWED_DEV_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  for (const e of extra) origins.add(e)
  return Array.from(origins)
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: devOrigins(),
}

module.exports = nextConfig
