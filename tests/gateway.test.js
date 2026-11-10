import test from 'node:test';
import assert from 'node:assert/strict';
import { localD1 } from '../scripts/d1-local.js';
import { Collaboration } from '../worker/collaboration.js';

test('gateway restricts credentials to their member and project and performs no context writes', async t => {
  const { default: gateway } = await import('../worker/gateway.js');
  const db = localD1(); t.after(db.close);
  const owner = new Collaboration(db.DB, { id: 'owner', email: 'owner@example.test', name: 'Owner' });
  const member = new Collaboration(db.DB, { id: 'member', email: 'member@example.test', name: 'Member' });
  const { project } = await owner.create({ name: 'Pilot', goal: 'Approved project goal' });
  const invite = await owner.invite(project.id, { email: 'member@example.test' }); await member.accept(invite.id);
  const credential = await member.issueGatewayCredential(project.id);
  const send = async (token, method, params = {}) => {
    const response = await gateway.fetch(new Request('https://gateway.example.test/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'oai-authenticated-user-id': 'owner' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), { DB: db.DB });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await send('cv_invalid', 'tools/list')).status, 401);
  const catalog = await send(credential.token, 'tools/list');
  assert.deepEqual(catalog.body.result.tools.map(x => x.name), ['list_projects', 'get_team_context']);
  const listed = await send(credential.token, 'tools/call', { name: 'list_projects' });
  assert.equal(listed.body.result.structuredContent.projects[0].role, 'editor');
  const before = db.database.prepare('SELECT data, revision FROM hosted_workspace WHERE id = ?').get(project.id);
  const context = await send(credential.token, 'tools/call', { name: 'get_team_context', arguments: { project_id: project.id, task: 'Research' } });
  assert.equal(context.body.result.structuredContent.projectVersion, 1);
  assert.equal(context.body.result.structuredContent.items[0].text, 'Approved project goal');
  assert.deepEqual(db.database.prepare('SELECT data, revision FROM hosted_workspace WHERE id = ?').get(project.id), before);
  const denied = await send(credential.token, 'tools/call', { name: 'prepare_proposal', arguments: {} });
  assert.equal(denied.body.result.isError, true);
  const wrong = await send(credential.token, 'tools/call', { name: 'get_team_context', arguments: { project_id: 'another', task: 'Research' } });
  assert.equal(wrong.body.result.isError, true);
  await member.revokeGatewayCredential(credential.id);
  assert.equal((await send(credential.token, 'tools/list')).status, 401);
  const expired = await member.issueGatewayCredential(project.id);
  db.database.prepare('UPDATE cv_gateway_credentials SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expired.id);
  assert.equal((await send(expired.token, 'tools/list')).status, 401);
  const again = await member.issueGatewayCredential(project.id);
  await owner.changeMember(project.id, { memberId: 'member', remove: true });
  assert.equal((await send(again.token, 'tools/list')).status, 401);
  const reinvite = await owner.invite(project.id, { email: 'member@example.test' }); await member.accept(reinvite.id);
  assert.equal((await send(again.token, 'tools/list')).status, 401);
});

test('real MCP HTTP client can discover and read using a member credential', async t => {
  const { default: gateway } = await import('../worker/gateway.js');
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const db = localD1(); t.after(db.close);
  const owner = new Collaboration(db.DB, { id: 'owner', email: 'owner@example.test', name: 'Owner' });
  const { project } = await owner.create({ name: 'Pilot', goal: 'The approved goal' });
  const { token } = await owner.issueGatewayCredential(project.id);
  const transport = new StreamableHTTPClientTransport(new URL('https://gateway.example.test/mcp'), { fetch: (url, init) => {
    const request = new Request(url, init); const headers = new Headers(request.headers); headers.set('Authorization', `Bearer ${token}`);
    return gateway.fetch(new Request(request, { headers }), { DB: db.DB });
  } });
  const client = new Client({ name: 'test-client', version: '1' }); t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 2);
  const result = await client.callTool({ name: 'get_team_context', arguments: { task: 'Plan research' } });
  assert.equal(result.structuredContent.projectVersion, 1);
});
