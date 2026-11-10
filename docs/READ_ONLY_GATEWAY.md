# Teammate MCP gateway: prototype and deployment checklist

This branch implements a separate, project-scoped read-only MCP gateway. It is not deployed or proven to reach the Sites-managed D1 database. Do not point users at it until the project owner confirms and tests the hosting and authentication boundaries.

The signed-in Sites worker issues a random personal credential, stores only its SHA-256 digest, and returns the plaintext once. Credentials expire after 30 days and can be revoked by their owner; removing a member also revokes that member's credentials for the project. The gateway checks credential validity and current membership for each request, never accepts Sites identity headers, and exposes only `list_projects` and a stateless `get_team_context`. Unlike the existing hosted tool, this read does not persist a handoff. It returns only current approved context. It does not support preview, proposals, or review.

## Deployment feasibility gate

1. The owner must confirm whether a separately deployed Cloudflare Worker can be bound to the **same** D1 database that Sites provisions, without exposing the existing Sites endpoint or weakening its authentication. This is not established by the repository. If it cannot, stop: use an owner-approved internal service/API with equivalent authenticated access, or retain manual handoffs. Do not use a duplicate database and call it live context.
2. Review the security model and obtain a suitable HTTPS deployment and operational controls, including rate limiting, monitoring, credential rotation and a plan for compromised credentials. The gateway is an unaudited prototype and does not include edge rate limiting. Do not trust client-provided identity headers or share the owner's credentials.
3. Apply the append-only `0002_gateway_credentials.sql` migration using the deployment's normal owner-controlled migration process. Back up data and validate on a non-production environment first. Deploy `worker/gateway.js` separately with its `DB` binding referencing the verified shared database; `npm run build:gateway` creates `dist/gateway/index.js`. Do not route it through the existing Sites gate and assume a bearer token bypasses that gate.
4. Set the site worker's `GATEWAY_URL` binding to the separately deployed HTTPS gateway URL ending in `/mcp`, using the platform's supported configuration. Confirm that Sites supports such a binding; otherwise adapt configuration safely. The credential UI is hidden unless this is configured. Deploying or changing bindings requires the owner's access and agreement.
5. In a staging project with fictional data, use two member accounts: issue a credential on **Connect to Codex**, verify it reads the same project and version as the website, then verify wrong-project access, expiry, revocation, removal and rejoining. Confirm no write tool is available. Verify the same workflow using the actual Codex desktop environment before involving real team data.

## Codex setup after owner deployment

In the website, choose the intended project, open **Connect to Codex**, and create a credential. Copy it to a secure local secret store immediately; it is displayed once. Do not send it in chat, commit it to Git, paste it into command arguments, or save it in a shared document. A project-specific bearer credential grants access to that project's approved context while active.

Codex supports remote HTTP MCP servers with `bearer_token_env_var` in its MCP configuration. Configure the separately deployed gateway URL and the **name** of an environment variable that is securely available to the Codex process. The method of supplying that variable to the desktop process is platform-dependent and must be verified; a shell-only export does not necessarily reach an already running desktop app. See https://learn.chatgpt.com/docs/extend/mcp?surface=cli. Do not put the credential itself in config.toml. Restart or create a new session as appropriate and check that `list_projects` shows the intended project and role; then ask for `get_team_context` and compare its version with the website.

For example, after the owner supplies the real URL, the non-secret configuration is:

```toml
[mcp_servers.crossville_team]
url = "https://YOUR-DEPLOYED-GATEWAY/mcp"
bearer_token_env_var = "CROSSVILLE_GATEWAY_TOKEN"
```

`editor` is the stored role name for Contributor. This gateway accepts `mode: "auto"` (or no mode); it does not implement `preview` or `confirm_handoff`.

If exposed, revoke it in the website immediately. Credentials cannot be recovered from storage; create a replacement. Expiration or member removal prevents access, even if a token is still held by an old session. No actual deployed gateway or teammate connection has yet been verified.
