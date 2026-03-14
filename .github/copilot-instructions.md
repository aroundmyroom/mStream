# GitHub Copilot Instructions

- Do not suggest or create a commit unless the user explicitly asks for it
- Before starting any commit, always write change notes first — update `Changes-Velvet.md` with a summary of what changed and why
- **After every commit, always push to GitHub with `git push` — never leave commits local-only. The active tracking remote is `origin velvet-master`.**
- The server uses HTTPS — always use `https://` in URLs and code
- Restart the server with: `systemctl restart music.service`
- Active branch is `velvet-master`
- Admin UI lives in `webapp/admin/` — always use that for admin-related changes
- When creating a new release, bump the version in `package.json` first
- `sqlite3` CLI is not installed on this system; SQLite is accessed via the Node.js built-in `node:sqlite` module (`DatabaseSync`) — Node v22.22.0
- After editing `webapp/admin/index.js`, always validate with: `node --input-type=module < webapp/admin/index.js 2>&1 | grep -v "not defined" | head -5` — a clean result (only `not defined` browser refs) means no syntax errors
- **The Easter egg (`window.EGG`, `egg-canvas`, `egg-pixel`) must NEVER be mentioned in any changelog, release notes, commit message, documentation, or todo file. Treat it as invisible — fix or improve it silently without any reference to it in written records.**
- After implementing any user-facing feature, always update **all three** records: (1) `Changes-Velvet.md` changelog, (2) the relevant file under `docs/` (create one if needed), (3) `todo.md` — mark completed items with `[x]` and move them to the DONE section if appropriate.
