// Local QA only: trusted test identities are injected here, outside the published Worker.
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import worker from '../dist/server/index.js';
import { localD1 } from './d1-local.js';
mkdirSync(new URL('../.data/', import.meta.url), { recursive: true });
const db = localD1(new URL('../.data/team-preview.sqlite', import.meta.url).pathname);
const actors = { owner: ['Test owner', 'owner@example.test'], colleague: ['Test colleague', 'colleague@example.test'], professor: ['Test professor', 'professor@example.test'] };
const port = Number(process.env.CROSSVILLE_TEAM_PORT || 4318);
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/_qa/identity' && actors[url.searchParams.get('user')]) {
      res.writeHead(303, { 'Set-Cookie': `qa-user=${url.searchParams.get('user')}; Path=/; SameSite=Strict; HttpOnly`, Location: '/' }); res.end(); return;
    }
    const who = req.headers.cookie?.match(/(?:^|; )qa-user=([^;]+)/)?.[1] || 'owner';
    const actor = actors[who] || actors.owner;
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 33000) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    const headers = new Headers(req.headers);
    headers.set('oai-authenticated-user-id', who); headers.set('oai-authenticated-user-email', actor[1]); headers.set('oai-authenticated-user-full-name', actor[0]);
    const request = new Request(url, { method: req.method, headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
    const response = await worker.fetch(request, { DB: db.DB, ...(process.env.CROSSVILLE_QA_GATEWAY ? { GATEWAY_URL: 'https://gateway.example.test/mcp' } : {}) });
    const responseHeaders = Object.fromEntries(response.headers);
    let body = Buffer.from(await response.arrayBuffer());
    if (response.headers.get('Content-Type')?.startsWith('text/html')) {
      body = Buffer.from(body.toString().replace('<body>', `<body><div class="qa-bar">Local QA · fictional identities: ${Object.entries(actors).map(([key, value]) => `<a href="/_qa/identity?user=${key}">${value[0]}</a>`).join(' · ')}</div>`));
    }
    res.writeHead(response.status, responseHeaders); res.end(body);
  } catch (error) { console.error(error.message); res.writeHead(500).end('Local QA failed.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Crossville team QA: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(); }));
