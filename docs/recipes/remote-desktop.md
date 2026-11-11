# Recipe: Remote Desktop to a Being's Box

The supported way to open a Being's desktop from the owner's laptop is the desktop skill: [`skills/desktop/`](../../skills/desktop/)
(`<being>-desktop` on the laptop, GNOME Remote Desktop and the firewall rule on the box, LAN first and the tunnel
otherwise). Use that instead of hand-made RDP or VNC setups.

Things that recipe covers and ad-hoc setups usually miss:

- **Cleanup.** Closing the viewer must end the session, and an abandoned session (viewer gone for a while) must be
  reaped, but never one that another viewer is still using. The skill ships the session-end script and reaper timer.
- **No password in chat.** The RDP password lives in a 0600 file on the laptop, read by the launcher.
- **Access before hostname.** The desktop hostname gets its access policy before it resolves (see the tunnel skill).
- **Sleep.** If the laptop sleeps the window freezes; close and reopen. Each open is a fresh login and takes ~30-60 s.

Remove any older desktop tools (VNC servers, browser desktops, third-party remote tools) once the skill works, so the box
has one remote-entry path to secure and audit.
