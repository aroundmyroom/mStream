# mStream v2 TODO

## Upload Feature (server: `noUpload: false`)

The upload endpoint (`POST /api/v1/file-explorer/upload`) is fully functional on the server.
In the classic GUI it works via drag-and-drop only, while inside the File Explorer view.
The v2 GUI has no upload support at all yet.

### Tasks

- [ ] Check server config on login/session — fetch `noUpload` status from `/api/v1/admin/about` or similar and store in app state
- [ ] Add an **Upload** button to the File Explorer / Library browser in v2, visible only when `noUpload === false`
- [ ] Implement drag-and-drop onto the file list area as an alternative to the button
- [ ] Show a progress bar during upload (reuse the Dropzone or fetch-based approach)
- [ ] Show success/error toast when upload completes
- [ ] Refresh the file list after a successful upload so the new files appear immediately
- [ ] Hide/disable the upload UI entirely when `noUpload === true` (respect admin setting)
- [ ] Ensure the upload target directory is the currently browsed vpath directory (pass as `data-location` header, URI-encoded)

---

## Admin Area — GUIv2

The admin panel (`webapp/admin/`) is the original unchanged UI from the upstream project.
It needs to be redesigned/integrated into the GUIv2 look and feel.

### Tasks

- [ ] Audit all existing admin panel features (scan controls, user management, transcode settings, db params)
- [ ] Redesign admin panel to match the GUIv2 dark-mode / CSS variable theme
- [ ] Integrate admin access into the GUIv2 sidebar (currently requires navigating to `/admin` separately)
- [ ] Ensure admin-only UI elements are hidden from non-admin users based on the ping/login response
- [ ] Replace or restyle all legacy CSS (materialize / foundation) in admin with GUIv2 variables
- [ ] Test all admin API calls still work after any restructuring

