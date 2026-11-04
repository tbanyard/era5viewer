ERA5Viewer Connect 0.1.0 is a companion desktop launcher for the ERA5 Viewer.

- Prompts for the user's SSH username and password; saves neither password
  nor SSH private keys.
- Verifies the pinned SSH server identity before sending credentials.
- Creates a tunnel to the reader on eepc-0184.bath.ac.uk:8769 and opens the
  browser automatically after the reader responds.
- Uses 127.0.0.1:8769 locally, or an unused local port if 8769 is busy.
- Supports additional SSH interactive sign-in prompts when required.
- Disconnect closes the tunnel; closing the launcher does the same.
- Provides a link to Bath's existing VPN setup/help. VPN and its MFA remain
  in the university's normal client; they are not collected by this launcher.

Choose the download for your OS and processor. Extract it before opening it,
and keep all files in the extracted application folder together. No Python
installation or terminal command is needed for end users. A live ERA5 reader
and an SSH-enabled account on the Bath computer are still required.

The included automated builds are development builds. Windows code signing
and Apple Developer ID signing/notarization are not configured; obtain an
approved/signed distribution through Bath IT for a managed-device rollout.
