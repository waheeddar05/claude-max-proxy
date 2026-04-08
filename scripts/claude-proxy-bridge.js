#!/usr/bin/env node
// Bridge proxy that flattens OpenAI content arrays to plain strings
// before forwarding to the Claude proxy at localhost:3456.
//
// Why: OpenClaw sends message content as structured arrays
//   [{"type":"text","text":"Hello"}]
// but the claude-max-api-proxy only handles plain string content.
// Without this bridge, the proxy receives "[object Object]" instead
// of the actual message text.
//
// Usage:
//   node claude-proxy-bridge.js
//   UPSTREAM_URL=http://localhost:3456 BRIDGE_PORT=3457 node claude-proxy-bridge.js

const http = require('http');

const UPSTREAM = process.env.UPSTREAM_URL || 'http://localhost:3456';
const PORT = process.env.BRIDGE_PORT || 3457;

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return String(content);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    // Flatten content arrays in messages for chat completions
    if (body && req.url.includes('/chat/completions')) {
      try {
        const parsed = JSON.parse(body);
        if (parsed.messages) {
          parsed.messages = parsed.messages.map(m => ({
            ...m,
            content: flattenContent(m.content)
          }));
        }
        body = JSON.stringify(parsed);
      } catch (e) { /* pass through unparseable bodies */ }
    }

    const url = new URL(req.url, UPSTREAM);
    const proxyReq = http.request(url, {
      method: req.method,
      headers: {
        ...req.headers,
        host: url.host,
        'content-length': Buffer.byteLength(body)
      }
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', e => {
      res.writeHead(502);
      res.end(JSON.stringify({ error: { message: e.message } }));
    });
    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Bridge proxy on :${PORT} -> ${UPSTREAM}`);
});
