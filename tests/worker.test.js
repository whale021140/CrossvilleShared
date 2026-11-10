import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
import { localD1 } from '../scripts/d1-local.js';

const accounts = {
  owner: { id: 'owner', email: 'owner@example.test' },
  editor: { id: 'editor', email: 'editor@example.test' },
  reviewer: { id: 'reviewer', email: 'reviewer@example.test' },
  viewer: { id: 'viewer', email: 'viewer@example.test' },
  outsider: { id: 'outsider', email: 'outsider@example.test' }
};
async function setup(t) {
  const db = localD1(); t.after(db.close);
  const tokens = {};
  const send = (who, path, body, extra = {}) => worker.fetch(new Request(`https://example.test${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'oai-authenticated-user-id': accounts[who].id, 'oai-authenticated-user-email': accounts[who].email, 'oai-authenticated-user-full-name': who, 'Content-Type': 'application/json', 'X-Crossville-Session': tokens[who] || '', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), { DB: db.DB });
  for (const who of Object.keys(accounts)) { const html = await (await send(who, '/')).text(); tokens[who] = html.match(/name="crossville-session" content="([a-f0-9-]+)"/)[1]; }
  async function ok(who, path, body) { const response = await send(who, path, body); const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; }
  const created = await ok('owner', '/api/projects/create', { name: 'Crossville sample', goal: 'Test the shared Crossville loop.', sample: true });
  const projectId = created.project.id;
  async function join(who, role) { const invitation = await ok('owner', '/api/team/invite', { projectId, email: accounts[who].email, role }); await ok(who, '/api/invitations/accept', { invitationId: invitation.id }); return invitation; }
  async function tool(who, name, args = {}) { const response = await send(who, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }); return (await response.json()).result; }
  return { ...db, send, ok, join, projectId, tool, tokens };
}

test('hosted identity, isolated project creation and per-user CSRF', async t => {
  const { send, ok, projectId, DB, tokens } = await setup(t);
  const anonymous = await worker.fetch(new Request('https://example.test/'), { DB }); assert.equal(anonymous.status, 401);
  assert.equal((await ok('outsider', '/api/workspace')).project, null);
  assert.equal((await send('outsider', '/api/workspace?projectId=' + projectId)).status, 404);
  assert.equal((await send('outsider', '/api/team?projectId=' + projectId)).status, 404);
  assert.equal((await send('owner', '/api/handoffs', { projectId, task: 'schedule' }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await send('owner', '/api/handoffs', { projectId, task: 'schedule' }, { 'X-Crossville-Session': tokens.editor })).status, 403);
  const own = await ok('outsider', '/api/projects/create', { name: 'Other project', goal: 'Separate context.' });
  assert.equal(own.project.demo, false);
  const workspace = await ok('outsider', '/api/workspace'); assert.equal(workspace.items.length, 1); assert.equal(workspace.project.version, 1); assert.equal(workspace.actor.role, 'owner');
  assert.equal((await ok('owner', '/api/workspace')).project.id, projectId);
});

test('members can issue and revoke their own project-scoped gateway credentials', async t => {
  const { ok, send, join, projectId, database } = await setup(t);
  await join('editor', 'editor');
  assert.equal((await send('outsider', '/api/gateway/credentials', { projectId })).status, 404);
  const issued = await ok('editor', '/api/gateway/credentials', { projectId });
  assert.match(issued.token, /^cv_[a-f0-9]{64}$/);
  assert.equal(database.prepare('SELECT token_hash FROM cv_gateway_credentials WHERE id = ?').get(issued.id).token_hash.includes(issued.token), false);
  assert.equal((await send('outsider', '/api/gateway/revoke', { credentialId: issued.id })).status, 404);
  await ok('editor', '/api/gateway/revoke', { credentialId: issued.id });
  assert.ok(database.prepare('SELECT revoked_at FROM cv_gateway_credentials WHERE id = ?').get(issued.id).revoked_at);
});

test('invitation email binding, roles, expiry, revoke and repeat acceptance', async t => {
  const { send, ok, join, projectId, database } = await setup(t);
  const invitation = await ok('owner', '/api/team/invite', { projectId, email: accounts.editor.email, role: 'editor' });
  assert.equal((await send('outsider', '/api/invitations/accept', { invitationId: invitation.id })).status, 404);
  await ok('editor', '/api/invitations/accept', { invitationId: invitation.id });
  await ok('editor', '/api/invitations/accept', { invitationId: invitation.id });
  assert.equal((await ok('editor', '/api/workspace')).actor.role, 'editor');
  assert.equal((await send('editor', '/api/team/invite', { projectId, email: accounts.viewer.email })).status, 403);
  assert.equal((await send('owner', '/api/team/invite', { projectId, email: accounts.viewer.email, role: 'owner' })).status, 400);
  const expired = await ok('owner', '/api/team/invite', { projectId, email: accounts.viewer.email });
  database.prepare('UPDATE cv_invitations SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expired.id);
  assert.equal((await send('viewer', '/api/invitations/accept', { invitationId: expired.id })).status, 410);
  const revoked = await ok('owner', '/api/team/invite', { projectId, email: accounts.viewer.email });
  await ok('owner', '/api/team/revoke', { projectId, invitationId: revoked.id });
  assert.equal((await send('viewer', '/api/invitations/accept', { invitationId: revoked.id })).status, 410);
  await join('reviewer', 'reviewer');
  assert.equal((await ok('reviewer', '/api/team?projectId=' + projectId)).invitations.length, 0);
});

test('website proposal → reviewer approval → MCP returns the same new context', async t => {
  const { ok, send, join, projectId, tool } = await setup(t);
  await join('editor', 'editor'); await join('reviewer', 'reviewer'); await join('viewer', 'viewer');
  const draft = await ok('editor', '/api/proposals/prepare', { projectId, title: 'One-week pilot', content: 'Use one week (7 days) for the Crossville pilot.', kind: 'decision', targetId: 'pilot-duration', sourceNote: 'Fictional test contribution.' });
  const otherWorkspace = await ok('reviewer', '/api/workspace'); assert.equal(otherWorkspace.drafts.length, 0);
  assert.equal((await send('reviewer', '/api/proposals/submit', { projectId, draftId: draft.id, confirmed: true })).status, 404);
  const preview = await tool('editor', 'get_team_context', { project_id: projectId, task: 'Plan pilot schedule', mode: 'preview' }); assert.equal(preview.isError, false);
  const packet = preview.structuredContent;
  assert.equal((await tool('reviewer', 'confirm_handoff', { project_id: projectId, packet_id: packet.id, selected_ids: packet.items.map(i => i.id) })).isError, true);
  const proposal = await ok('editor', '/api/proposals/submit', { projectId, draftId: draft.id, confirmed: true });
  assert.equal((await send('editor', '/api/proposals/review', { projectId, proposalId: proposal.id, outcome: 'approved' })).status, 403);
  assert.equal((await send('viewer', '/api/proposals/prepare', { projectId, title: 'No', content: 'Forbidden', kind: 'decision' })).status, 403);
  const result = await ok('reviewer', '/api/proposals/review', { projectId, proposalId: proposal.id, outcome: 'approved' }); assert.equal(result.project.version, 3);
  const latest = await tool('viewer', 'get_team_context', { project_id: projectId, task: 'Plan pilot schedule', mode: 'auto', known_version: 2 });
  assert.equal(latest.isError, false); assert.equal(latest.structuredContent.projectVersion, 3); assert(latest.structuredContent.text.includes('7 days')); assert.equal(latest.structuredContent.changes.status, 'updated');
  assert.equal(latest.structuredContent.items.find(i => i.id === 'pilot-duration').source.author, 'editor');
  const stale = await tool('editor', 'confirm_handoff', { project_id: projectId, packet_id: packet.id, selected_ids: packet.items.map(i => i.id) }); assert.equal(stale.structuredContent.code, 'STALE_CONTEXT');
  assert.equal((await ok('owner', '/api/workspace')).project.version, 3);
});

test('membership updates prevent escalation, last-owner removal and old invite reuse', async t => {
  const { send, ok, join, projectId, tool } = await setup(t);
  const invitation = await join('editor', 'editor');
  assert.equal((await send('editor', '/api/team/member', { projectId, memberId: 'editor', role: 'owner' })).status, 403);
  assert.equal((await send('owner', '/api/team/member', { projectId, memberId: 'owner', remove: true })).status, 409);
  assert.equal((await send('owner', '/api/team/member', { projectId, memberId: 'owner', role: 'editor' })).status, 409);
  await ok('owner', '/api/team/member', { projectId, memberId: 'editor', role: 'viewer' });
  assert.equal((await tool('editor', 'prepare_proposal', { project_id: projectId, title: 'No', content: 'Denied' })).structuredContent.code, 'FORBIDDEN');
  await ok('owner', '/api/team/member', { projectId, memberId: 'editor', remove: true });
  assert.equal((await send('editor', '/api/invitations/accept', { invitationId: invitation.id })).status, 404);
  assert.equal((await tool('editor', 'get_team_context', { project_id: projectId, task: 'schedule' })).structuredContent.code, 'NOT_FOUND');
});

test('MCP discovery works without private data, tool calls require identity and explicit multi-project selection', async t => {
  const { DB, send, ok, tool, projectId } = await setup(t);
  const call = method => worker.fetch(new Request('https://example.test/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) }), { DB });
  const catalog = await (await call('tools/list')).json(); assert.equal(catalog.result.tools.length, 7); assert(catalog.result.tools.every(t => t.inputSchema));
  const discover = await (await call('server/discover')).json(); assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
  const denied = await worker.fetch(new Request('https://example.test/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects' } }) }), { DB });
  assert.equal((await denied.json()).result.structuredContent.code, 'UNAUTHENTICATED');
  const projects = await tool('owner', 'list_projects'); assert.equal(projects.structuredContent.projects.length, 1);
  await ok('owner', '/api/projects/create', { name: 'Another project', goal: 'Another goal.' });
  assert.equal((await tool('owner', 'get_team_context', { task: 'schedule' })).structuredContent.code, 'PROJECT_REQUIRED');
  assert.equal((await tool('owner', 'get_team_context', { project_id: projectId, task: 'schedule' })).isError, false);
  const connection = await (await send('owner', '/api/connection')).json(); assert.equal(connection.sharedBackend, true);
});

test('actual MCP HTTP client discovers hosted tools and retrieves from D1', async t => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { DB, projectId } = await setup(t);
  const transport = new StreamableHTTPClientTransport(new URL('https://example.test/mcp'), {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      const headers = new Headers(request.headers);
      headers.set('oai-authenticated-user-id', 'owner'); headers.set('oai-authenticated-user-email', accounts.owner.email);
      return worker.fetch(new Request(request, { headers }), { DB });
    }
  });
  const client = new Client({ name: 'crossville-http-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 7);
  const result = await client.callTool({ name: 'get_team_context', arguments: { project_id: projectId, task: 'Pilot schedule', mode: 'auto' } });
  assert.equal(result.isError, false); assert.equal(result.structuredContent.projectVersion, 2); assert(result.structuredContent.text.includes('14 days'));
});

test('removing a member revokes unused invitations for that email', async t => {
  const { ok, send, projectId } = await setup(t);
  const a = await ok('owner', '/api/team/invite', { projectId, email: accounts.editor.email });
  const b = await ok('owner', '/api/team/invite', { projectId, email: accounts.editor.email });
  await ok('editor', '/api/invitations/accept', { invitationId: a.id });
  await ok('owner', '/api/team/member', { projectId, memberId: 'editor', remove: true });
  assert.equal((await send('editor', '/api/invitations/accept', { invitationId: b.id })).status, 410);
});

test('concurrent state or access changes prevent a stale packet write', async t => {
  const { DB, database, projectId, tokens } = await setup(t);
  for (const change of [() => database.prepare('UPDATE hosted_workspace SET revision = revision + 1 WHERE id = ?').run(projectId), () => database.prepare('UPDATE cv_projects SET access_revision = access_revision + 1 WHERE id = ?').run(projectId)]) {
    let raced = false;
    const racingDB = { ...DB, prepare(sql) {
      const statement = DB.prepare(sql);
      if (!sql.startsWith('UPDATE hosted_workspace')) return statement;
      return { bind(...args) { statement.bind(...args); return this; }, async run() { if (!raced) { raced = true; change(); } return statement.run(); } };
    } };
    const response = await worker.fetch(new Request('https://example.test/api/handoffs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'oai-authenticated-user-id': 'owner', 'X-Crossville-Session': tokens.owner }, body: JSON.stringify({ projectId, task: 'Pilot schedule', mode: 'auto' }) }), { DB: racingDB });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'STALE_CONTEXT');
  }
});
