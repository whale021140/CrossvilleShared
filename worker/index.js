import assets from 'virtual:assets';
import { AppError } from '../src/domain.js';
import { callTool } from '../src/tools.js';
import { Collaboration, identity } from './collaboration.js';
import { mcp } from './mcp.js';

const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
async function input(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new AppError('Expected a JSON request.');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('Expected a JSON body.');
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length; if (size > 32000) { await reader.cancel(); throw new AppError('The request is too large.', 'TOO_LARGE', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AppError('The request was not valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('Expected a JSON object.');
  return body;
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json(403, { error: 'Use CrossvilleShared from its own page.', code: 'FORBIDDEN' });
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') return json(405, { error: 'Use JSON-RPC POST requests.', code: 'METHOD_NOT_ALLOWED' });
        const response = await mcp(await input(request), request, env);
        return response ? json(200, response) : new Response(null, { status: 202, headers });
      }
      // These identity headers are supplied and authenticated by Sites, never by browser input.
      const actor = identity(request);
      if (request.method === 'GET' && assets[url.pathname] && url.pathname !== '/') return new Response(assets[url.pathname].body, { headers: { ...headers, 'Content-Type': assets[url.pathname].type } });
      const team = new Collaboration(env.DB, actor);
      if (request.method === 'GET' && url.pathname === '/') {
        const session = await team.settings();
        const html = assets['/'].body.replace('__SESSION__', session.csrf_token)
          .replace('Local prototype · fictional project data', 'CrossvilleShared · private team pilot')
          .replace('No live team or personal chats connected', 'Shared context · personal chats stay private')
          .replace('Your local workspace', 'Your team workspace');
        return new Response(html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (request.method === 'GET' && url.pathname === '/healthz') return json(200, { status: 'ok', mode: 'hosted_team' });
      if (request.method === 'GET' && url.pathname === '/api/workspace') return json(200, await team.workspace(url.searchParams.get('projectId')));
      if (request.method === 'GET' && url.pathname === '/api/team') return json(200, await team.team(url.searchParams.get('projectId')));
      if (request.method === 'GET' && url.pathname === '/api/gateway/credentials') return json(200, await team.gatewayCredentials(url.searchParams.get('projectId')));
      if (request.method === 'GET' && url.pathname.startsWith('/api/invitations/')) return json(200, await team.invitation(url.pathname.split('/').at(-1)));
      if (request.method === 'GET' && url.pathname === '/api/connection') return json(200, {
        hosted: true, sharedBackend: true, endpoint: `${url.origin}/mcp`, gatewayEndpoint: /^https:\/\/[^\s]+\/mcp$/.test(env.GATEWAY_URL || '') ? env.GATEWAY_URL : null, repositoryUrl: 'https://github.com/kartika6/CrossvilleShared/tree/feature/team-collaboration',
        message: 'Install the CrossvilleShared personal plugin created by Sites. Its tools use the same hosted projects and membership as this page. Your LLM retrieves context directly; copy and download are optional.'
      });
      if (request.method !== 'POST') return json(404, { error: 'This page was not found.', code: 'NOT_FOUND' });
      const session = await team.settings();
      if (request.headers.get('X-Crossville-Session') !== session.csrf_token) return json(403, { error: 'Refresh this page before trying again.', code: 'SESSION_EXPIRED' });
      const body = await input(request);
      const projectId = body.projectId;
      const actions = {
        '/api/projects/create': () => team.create(body), '/api/projects/select': () => team.select(projectId),
        '/api/team/invite': () => team.invite(projectId, body), '/api/team/revoke': () => team.revoke(projectId, body.invitationId),
        '/api/team/member': () => team.changeMember(projectId, body), '/api/invitations/accept': () => team.accept(body.invitationId),
        '/api/gateway/credentials': () => team.issueGatewayCredential(projectId), '/api/gateway/revoke': () => team.revokeGatewayCredential(body.credentialId)
      };
      const serviceActions = {
        '/api/handoffs': service => service.prepareHandoff(body), '/api/handoffs/confirm': service => service.confirmHandoff(body), '/api/handoffs/cancel': service => service.cancelHandoff(body),
        '/api/proposals/prepare': service => service.prepareProposal(body), '/api/proposals/submit': service => service.submitProposal(body), '/api/proposals/review': service => service.reviewProposal(body),
        '/api/tools/call': service => callTool(service, body.name, body.arguments)
      };
      if (actions[url.pathname]) return json(200, await actions[url.pathname]());
      if (!serviceActions[url.pathname]) return json(404, { error: 'This action was not found.', code: 'NOT_FOUND' });
      const { selected } = await team.choose(projectId);
      if (!selected) throw new AppError('Create or join a project first.', 'PROJECT_REQUIRED', 409);
      return json(200, await team.run(selected, serviceActions[url.pathname]));
    } catch (error) {
      if (!error.status) console.error('CrossvilleShared worker error', error.message);
      return json(error.status || 500, { error: error.status ? error.message : 'CrossvilleShared could not finish this request. Refresh and try again.', code: error.code || 'INTERNAL_ERROR' });
    }
  }
};
