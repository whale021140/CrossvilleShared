import { AppError, currentItems, digest, id, text } from '../src/domain.js';
import { createFixture } from '../src/fixture.js';
import { ContextService } from '../src/service.js';
import { MemoryStore } from '../src/memory-store.js';

export const roles = ['owner', 'reviewer', 'editor', 'viewer'];
const now = () => new Date().toISOString();
const fail = () => { throw new AppError('This project is not available to your account.', 'NOT_FOUND', 404); };
export function identity(request) {
  const userId = request.headers.get('oai-authenticated-user-id');
  if (!userId) throw new AppError('Sign in to open CrossvilleShared.', 'UNAUTHENTICATED', 401);
  const email = (request.headers.get('oai-authenticated-user-email') || '').trim().toLowerCase();
  let name = request.headers.get('oai-authenticated-user-full-name') || email || 'Member';
  try { name = decodeURIComponent(name); } catch { /* Some clients send the name without encoding. */ }
  return { id: userId, email, name: name.slice(0, 160) };
}
function verifiedEmail(actor) {
  if (!actor.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor.email)) throw new AppError('A verified sign-in email is required for this action.', 'EMAIL_REQUIRED', 403);
}

export class Collaboration {
  constructor(db, actor) {
    if (!db) throw new AppError('The shared database is unavailable.', 'STORAGE_UNAVAILABLE', 503);
    this.db = db; this.actor = actor;
  }
  sql(query, ...args) { return this.db.prepare(query).bind(...args); }
  async settings() {
    await this.sql('INSERT OR IGNORE INTO cv_user_settings (user_id, csrf_token) VALUES (?, ?)', this.actor.id, id() + id()).run();
    return this.sql('SELECT * FROM cv_user_settings WHERE user_id = ?', this.actor.id).first();
  }
  async projects() {
    const result = await this.sql('SELECT p.id, p.name, p.created_at AS createdAt, m.role FROM cv_projects p JOIN cv_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.created_at, p.id', this.actor.id).all();
    return result.results;
  }
  async membership(projectId, owner = false) {
    const member = await this.sql('SELECT m.*, p.access_revision FROM cv_members m JOIN cv_projects p ON p.id = m.project_id WHERE m.project_id = ? AND m.user_id = ?', projectId, this.actor.id).first();
    if (!member) fail();
    if (owner && member.role !== 'owner') throw new AppError('Only a project owner can manage the team.', 'FORBIDDEN', 403);
    return member;
  }
  async choose(projectId) {
    const settings = await this.settings();
    const projects = await this.projects();
    const selected = projectId || projects.find(p => p.id === settings.active_project_id)?.id || projects[0]?.id;
    if (projectId && !projects.some(p => p.id === projectId)) fail();
    return { projects, selected, settings };
  }
  async select(projectId) {
    await this.membership(projectId); await this.settings();
    await this.sql('UPDATE cv_user_settings SET active_project_id = ? WHERE user_id = ?', projectId, this.actor.id).run();
    return { projectId };
  }
  async issueGatewayCredential(projectId) {
    await this.membership(projectId);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = 'cv_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const credentialId = id(), createdAt = now(), expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    const result = await this.sql(`INSERT INTO cv_gateway_credentials (id, user_id, project_id, token_hash, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cv_members WHERE user_id = ? AND project_id = ?)`, credentialId, this.actor.id, projectId, digest(token), createdAt, expiresAt, this.actor.id, projectId).run();
    if (!result.meta.changes) fail();
    return { id: credentialId, token, projectId, expiresAt };
  }
  async revokeGatewayCredential(credentialId) {
    const result = await this.sql('UPDATE cv_gateway_credentials SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), credentialId, this.actor.id).run();
    if (!result.meta.changes) fail();
    return { revoked: true };
  }
  async gatewayCredentials(projectId) {
    await this.membership(projectId);
    const result = await this.sql('SELECT id, project_id AS projectId, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt FROM cv_gateway_credentials WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC', projectId, this.actor.id).all();
    return { credentials: result.results };
  }
  async create({ name, goal, sample = false }) {
    verifiedEmail(this.actor); name = text(name, 'Project name', 100); goal = text(goal, 'Project goal', 4000);
    if (typeof sample !== 'boolean') throw new AppError('Choose whether to include sample data.');
    const projectId = id(), createdAt = now();
    const brief = { id: id(), kind: 'brief', title: 'Project goal', text: goal, claimKey: 'project.goal', strength: 'default', status: 'approved', revision: 1, tags: ['project', 'goal'], source: { author: this.actor.name, label: 'Project created by owner', type: 'project_creation' } };
    const state = sample ? createFixture() : { schemaVersion: 1, items: [brief], handoffs: [], drafts: [], proposals: [], events: [], snapshots: [] };
    state.project = { id: projectId, name, version: sample ? 2 : 1, demo: sample };
    state.events = [{ id: id(), type: 'workspace_created', summary: sample ? 'Project created with clearly labeled fictional sample data.' : 'Project created with the owner’s project goal.', at: createdAt, version: state.project.version, actorId: this.actor.id }];
    state.snapshots = [{ version: state.project.version, items: structuredClone(currentItems(state)) }];
    await this.settings();
    await this.db.batch([
      this.sql('INSERT INTO cv_projects (id, name, created_at) VALUES (?, ?, ?)', projectId, name, createdAt),
      this.sql('INSERT INTO cv_members (project_id, user_id, email, display_name, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)', projectId, this.actor.id, this.actor.email, this.actor.name, 'owner', createdAt),
      this.sql('INSERT INTO hosted_workspace (id, data, revision) VALUES (?, ?, 0)', projectId, JSON.stringify(state)),
      this.sql('UPDATE cv_user_settings SET active_project_id = ? WHERE user_id = ?', projectId, this.actor.id)
    ]);
    return { project: state.project };
  }
  async run(projectId, operation) {
    const member = await this.membership(projectId);
    const row = await this.sql('SELECT data, revision FROM hosted_workspace WHERE id = ?', projectId).first();
    if (!row) fail();
    const store = new MemoryStore(JSON.parse(row.data));
    const service = new ContextService(store, { ...this.actor, role: member.role }, { hosted: true });
    const result = await operation(service);
    if (store.dirty) {
      const saved = await this.sql(`UPDATE hosted_workspace SET data = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND EXISTS (
        SELECT 1 FROM cv_projects p JOIN cv_members m ON m.project_id = p.id WHERE p.id = ? AND p.access_revision = ? AND m.user_id = ? AND m.role = ?
      )`, JSON.stringify(store.state), projectId, row.revision, projectId, member.access_revision, this.actor.id, member.role).run();
      if (saved.meta.changes !== 1) throw new AppError('The project or your access changed. Refresh and review before retrying.', 'STALE_CONTEXT', 409);
    } else await this.membership(projectId);
    return result;
  }
  async workspace(projectId) {
    const { selected, projects } = await this.choose(projectId);
    const base = { mode: 'hosted_team', hosted: true, projects, actor: { ...this.actor, role: null }, project: null, items: [], proposals: [], drafts: [], handoffs: [], events: [] };
    if (!selected) return base;
    const workspace = await this.run(selected, service => service.workspace());
    return { ...workspace, mode: 'hosted_team', hosted: true, liveConnected: true, projects, capabilities: { ...workspace.capabilities, sharedBackend: 'Shared hosted project', approval: 'Project owners and reviewers; roles checked by the server' } };
  }
  async team(projectId) {
    const member = await this.membership(projectId);
    const members = await this.sql('SELECT user_id AS id, display_name AS name, email, role, joined_at AS joinedAt FROM cv_members WHERE project_id = ? ORDER BY joined_at', projectId).all();
    const invitations = member.role === 'owner' ? (await this.sql('SELECT * FROM cv_invitations WHERE project_id = ? ORDER BY created_at DESC', projectId).all()).results : [];
    return { members: members.results, invitations, siteAccessRequired: true };
  }
  async invite(projectId, { email, role = 'editor' }) {
    await this.membership(projectId, true);
    email = text(email, 'Email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Enter a valid sign-in email.');
    if (!['reviewer', 'editor', 'viewer'].includes(role)) throw new AppError('Choose contributor, reviewer or viewer.');
    const existing = await this.sql('SELECT 1 AS present FROM cv_members WHERE project_id = ? AND email = ?', projectId, email).first();
    if (existing) throw new AppError('That account is already a member. Change its role below.', 'ALREADY_MEMBER', 409);
    const invitation = { id: id(), projectId, email, role, createdAt: now(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
    const result = await this.sql(`INSERT INTO cv_invitations (id, project_id, email, role, created_by, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cv_members WHERE project_id = ? AND user_id = ? AND role = 'owner')`, invitation.id, projectId, email, role, this.actor.id, invitation.createdAt, invitation.expiresAt, projectId, this.actor.id).run();
    if (result.meta.changes !== 1) throw new AppError('Your project role changed. Refresh before trying again.', 'FORBIDDEN', 403);
    return invitation;
  }
  async invitation(invitationId) {
    verifiedEmail(this.actor);
    const invitation = await this.sql('SELECT i.*, p.name AS project_name FROM cv_invitations i JOIN cv_projects p ON p.id = i.project_id WHERE i.id = ? AND i.email = ?', invitationId, this.actor.email).first();
    if (!invitation) throw new AppError('This invitation is unavailable. Sign in with the exact email invited by the project owner.', 'INVITATION_UNAVAILABLE', 404);
    if (invitation.revoked_at || invitation.expires_at <= now()) throw new AppError('This invitation has expired or was revoked. Ask the owner for a new one.', 'INVITATION_EXPIRED', 410);
    if (invitation.accepted_by && invitation.accepted_by !== this.actor.id) throw new AppError('This invitation has already been used.', 'INVITATION_USED', 409);
    return { id: invitation.id, projectId: invitation.project_id, projectName: invitation.project_name, email: invitation.email, role: invitation.role, expiresAt: invitation.expires_at, accepted: !!invitation.accepted_by };
  }
  async accept(invitationId) {
    const invitation = await this.invitation(invitationId);
    if (invitation.accepted) { await this.membership(invitation.projectId); await this.select(invitation.projectId); return { projectId: invitation.projectId, accepted: true }; }
    const at = now();
    await this.settings();
    const results = await this.db.batch([
      this.sql(`INSERT OR IGNORE INTO cv_members (project_id, user_id, email, display_name, role, joined_at)
        SELECT project_id, ?, email, ?, role, ? FROM cv_invitations WHERE id = ? AND email = ? AND revoked_at IS NULL AND expires_at > ? AND accepted_by IS NULL`, this.actor.id, this.actor.name, at, invitationId, this.actor.email, at),
      this.sql(`UPDATE cv_invitations SET accepted_by = ?, accepted_at = COALESCE(accepted_at, ?) WHERE id = ? AND email = ? AND revoked_at IS NULL AND expires_at > ? AND (accepted_by IS NULL OR accepted_by = ?) AND EXISTS (SELECT 1 FROM cv_members WHERE project_id = cv_invitations.project_id AND user_id = ?)`, this.actor.id, at, invitationId, this.actor.email, at, this.actor.id, this.actor.id),
      this.sql('UPDATE cv_projects SET access_revision = access_revision + 1 WHERE id = ?', invitation.projectId)
    ]);
    if (results[1].meta.changes !== 1) throw new AppError('The invitation changed. Ask the owner for a new one.', 'INVITATION_UNAVAILABLE', 409);
    await this.select(invitation.projectId);
    return { projectId: invitation.projectId, accepted: true };
  }
  async revoke(projectId, invitationId) {
    await this.membership(projectId, true);
    const result = await this.sql(`UPDATE cv_invitations SET revoked_at = ? WHERE id = ? AND project_id = ? AND accepted_by IS NULL AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM cv_members WHERE project_id = ? AND user_id = ? AND role = 'owner')`, now(), invitationId, projectId, projectId, this.actor.id).run();
    if (!result.meta.changes) throw new AppError('That pending invitation is no longer available.', 'NOT_FOUND', 404);
    return { revoked: true };
  }
  async changeMember(projectId, { memberId, role, remove = false }) {
    await this.membership(projectId, true);
    if (typeof remove !== 'boolean') throw new AppError('Choose whether to remove the member.');
    if (!remove && !roles.includes(role)) throw new AppError('Choose a valid member role.');
    memberId = text(memberId, 'Member', 200);
    const ownerGuard = `EXISTS (SELECT 1 FROM cv_members actor WHERE actor.project_id = ? AND actor.user_id = ? AND actor.role = 'owner')`;
    const lastOwnerGuard = `(role <> 'owner' OR (SELECT COUNT(*) FROM cv_members owners WHERE owners.project_id = ? AND owners.role = 'owner') > 1)`;
    const query = remove ? `DELETE FROM cv_members WHERE project_id = ? AND user_id = ? AND ${ownerGuard} AND ${lastOwnerGuard}` : `UPDATE cv_members SET role = ? WHERE project_id = ? AND user_id = ? AND ${ownerGuard} ${role === 'owner' ? '' : `AND ${lastOwnerGuard}`}`;
    const args = remove ? [projectId, memberId, projectId, this.actor.id, projectId] : [role, projectId, memberId, projectId, this.actor.id, ...(role === 'owner' ? [] : [projectId])];
    const results = await this.db.batch([
      this.sql(`UPDATE cv_projects SET access_revision = access_revision + 1 WHERE id = ? AND ${ownerGuard}`, projectId, projectId, this.actor.id),
      ...(remove ? [this.sql(`UPDATE cv_invitations SET revoked_at = ? WHERE project_id = ? AND accepted_by IS NULL AND revoked_at IS NULL AND email = (SELECT email FROM cv_members WHERE project_id = ? AND user_id = ?) AND ${ownerGuard}`, now(), projectId, projectId, memberId, projectId, this.actor.id)] : []),
      ...(remove ? [this.sql(`UPDATE cv_gateway_credentials SET revoked_at = ? WHERE project_id = ? AND user_id = ? AND revoked_at IS NULL AND ${ownerGuard} AND EXISTS (SELECT 1 FROM cv_members target WHERE target.project_id = ? AND target.user_id = ? AND (target.role <> 'owner' OR (SELECT COUNT(*) FROM cv_members owners WHERE owners.project_id = ? AND owners.role = 'owner') > 1))`, now(), projectId, memberId, projectId, this.actor.id, projectId, memberId, projectId)] : []),
      this.sql(query, ...args)
    ]);
    if (results.at(-1).meta.changes !== 1) throw new AppError('Keep at least one owner. The member may also have changed; refresh and try again.', 'MEMBER_CHANGE_CONFLICT', 409);
    return { changed: true };
  }
}
