# Installing Orbit

Installers ship from the
[Releases page](https://github.com/galaxyproject/loom/releases) — pick the
latest release and download the artifact for your machine.

The macOS builds are Developer ID signed and notarized by Apple, so they open
with a normal double-click, and ship for both Apple Silicon and Intel. Linux
ships `.deb` / `.rpm` / `.zip` for x64 and arm64. Windows ships a portable
`.zip` (remote-only) rather than an installer -- see the
[Windows (portable, remote-only)](#windows-portable-remote-only) section below.

## macOS

Both architectures are packaged, signed and notarized:

| File                        | When to pick it                                                   |
| --------------------------- | ----------------------------------------------------------------- |
| `Orbit-<version>-arm64.dmg` | Apple Silicon Macs (M1/M2/M3/M4) — anything from late 2020 onward |
| `Orbit-<version>-x64.dmg`   | Intel Macs                                                        |

Not sure which you have? Apple menu → About This Mac: "Chip: Apple M..." is
Apple Silicon, "Processor: Intel..." is Intel.

### Install

1. Download the matching `.dmg` from the Releases page.
2. Double-click the DMG, drag **Orbit** to the **Applications** folder.
3. Eject the DMG (drag its icon to the trash).

### First launch

The build is **Developer ID signed and notarized by Apple**, so it opens like
any other app — double-click **Orbit** in Applications. No Gatekeeper warning,
no right-click dance, no Terminal commands.

### Updates

Orbit checks for new releases on startup. When a newer version is
available, a banner appears at the top of the window with a link to the
Releases page. Click the link, download the new DMG, and replace the old
app in Applications (drag-and-drop will prompt you to overwrite).

Auto-update isn't wired up yet, so the download is manual — one click after
the banner appears.

### Uninstall

Drag **Orbit** from **Applications** to the **Trash**. Per-user state
lives under:

- `~/.orbit/` — window position, version-check cache.
- `~/.loom/` — agent configuration, API keys (encrypted via macOS
  Keychain), session history.

Remove those directories to fully reset the app.

## Linux

Two package formats are published per release:

| File                            | When to pick it                                          |
| ------------------------------- | -------------------------------------------------------- |
| `orbit_<version>_amd64.deb`     | Debian, Ubuntu, Linux Mint, Pop!\_OS, and derivatives    |
| `orbit-<version>.x86_64.rpm`    | Fedora, RHEL, CentOS, openSUSE                           |
| `Orbit-linux-x64-<version>.zip` | Any distro — extract and run the `orbit` binary directly |

### Install (.deb — Debian/Ubuntu)

```bash
sudo dpkg -i orbit_<version>_amd64.deb
sudo apt-get install -f   # resolves any missing dependencies
orbit                     # launch from terminal, or find it in your app launcher
```

Not showing up in your application menu? Some desktop environments don't
refresh their app database right after a `dpkg` install, so the Orbit icon can
be missing even though the install worked. Run `sudo update-desktop-database
/usr/share/applications` (or just log out and back in) and it'll appear. Either
way, `orbit` from the terminal always launches it.

### Install (.rpm — Fedora/RHEL)

```bash
sudo rpm -i orbit-<version>.x86_64.rpm
orbit
```

### Install (.zip — any distro)

```bash
unzip Orbit-linux-x64-<version>.zip -d ~/orbit
~/orbit/orbit
```

### Uninstall

```bash
sudo dpkg -r orbit          # Debian/Ubuntu
sudo rpm -e orbit           # Fedora/RHEL
```

Per-user state lives under `~/.orbit/` and `~/.loom/` — remove those to fully reset.

---

## Windows (portable, remote-only)

Download `Orbit-win32-x64-<version>.zip` from the
[Releases page](https://github.com/galaxyproject/loom/releases), unzip it
anywhere you like, and run `orbit.exe` from the extracted folder. There is no
installer: the Squirrel installer trips Win32's 260-character path limit while
staging the bundled Loom CLI, which ships as real files rather than inside an
asar because it runs as a subprocess. Until that is solved, the portable `.zip`
is the Windows build.

Nothing is written outside the folder you extracted plus your per-user state
(below), so "uninstalling" is deleting the folder.

### SmartScreen warning

The build is unsigned, so the first run of `orbit.exe` shows "Windows protected
your PC -- Unknown publisher". This is expected.

1. Click **More info**.
2. Click **Run anyway**.

Signing with an Authenticode certificate (planned, not yet in place) would
remove this prompt.

### What works

- Connect to a Galaxy server and run tools and workflows via the Galaxy provider.
- Read and write workspace files from your Windows filesystem.

### What doesn't (yet)

- **No local bash shell.** There is no local execution path -- all computation
  routes to Galaxy. A native local power mode is planned.

### Updates

Orbit shows a banner when a newer release is available. Click the link to go to
the Releases page, download the new `.zip`, and replace your extracted folder
with the new one. Per-user state lives outside that folder, so it survives.

---

## Windows local execution (WSL2)

For local bash execution today, run the Linux `.deb` build inside WSL2 --
WSLg provides native GUI support with no X server setup required. This remains
the path for local execution until a native Windows local power mode lands.

### Prerequisites

1. **WSL2** -- run `wsl --install` in an elevated PowerShell if not already set up.
2. **WSLg** -- bundled with WSL2 on Windows 11 (build 22000+). Run `wsl --update` to ensure it's current.
3. **Ubuntu** (or another Debian-based distro) inside WSL2.

### Install inside WSL2

Open your WSL2 terminal and run:

```bash
# Download the .deb from the Releases page, then:
sudo dpkg -i orbit_<version>_amd64.deb
sudo apt-get install -f
orbit
```

On most setups the Orbit window opens on your Windows desktop via WSLg with no
further configuration. On a fresh or minimal WSL2 distro it may not appear the
first time -- see [If the window doesn't appear](#if-the-window-doesnt-appear)
below.

### If the window doesn't appear

On a fresh or minimal WSL2 distro, WSLg's GUI session sometimes fails to come
up on the first launch: `orbit` starts with no error in the terminal, but no
window appears and the taskbar entry shows a `[WARN COPY MODE] ...` title. A
full WSL restart is what reliably clears it. Here's the recovery, in order:

1. Make sure the common GUI client libraries are present. Installing any GTK
   app pulls them in, and `gedit` is a convenient one:

   ```bash
   sudo apt-get update && sudo apt-get install -y gedit
   ```

2. From **PowerShell** on Windows, fully restart WSL so WSLg re-initializes:

   ```powershell
   wsl --shutdown
   ```

   This stops **all** running WSL2 distros and the WSL VM, so save work in any
   other WSL sessions first.

3. Reopen your WSL2 terminal and run `orbit` again -- the window should now
   appear. (Launching `gedit` is a quick way to confirm WSLg itself is back.)

### Notes

- File paths inside WSL2 are at `/mnt/c/...` from within the terminal. Point Orbit's working directory at a path inside WSL2 (`~/analyses/`) for best performance -- cross-filesystem I/O over `/mnt/c` is slower.
- Keychain-based API key encryption is not available in WSL2 (no `safeStorage`). API keys are stored in plaintext in `~/.loom/config.json` inside the WSL2 filesystem. Use filesystem permissions (`chmod 600`) to restrict access.

---

## Reporting installer issues

If the DMG won't open, the app crashes on launch, or Gatekeeper behaves
differently than described, please file an issue at
[github.com/galaxyproject/loom/issues](https://github.com/galaxyproject/loom/issues)
with: macOS version, Mac model (Apple menu → About This Mac), the exact
filename downloaded, and any error text.
