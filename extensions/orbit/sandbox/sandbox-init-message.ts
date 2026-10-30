/**
 * apt package names that provide the Linux sandbox runtime binaries ASRT shells
 * out to: `ripgrep` -> rg, `socat` -> socat, `bubblewrap` -> bwrap. These ship as
 * deb `recommends` (see app/forge.config.ts), so a `--no-install-recommends`
 * install -- or a distro/derivative that strips Recommends -- can still be missing
 * them and trip the init failure in issue #305. (#305 only named rg + socat, but
 * ASRT requires bwrap on Linux too.)
 */
export const LINUX_SANDBOX_APT_PACKAGES = ["ripgrep", "socat", "bubblewrap"];

/**
 * User-facing message for a failed bash-sandbox init. On Linux, when ASRT reports
 * its runtime prerequisites are missing, append the exact apt install line so the
 * user can fix it in one step instead of decoding "ripgrep (rg) not found". Pure:
 * takes the platform and the underlying error message, does no IO.
 */
export function describeSandboxInitFailure(
  platform: NodeJS.Platform,
  errorMessage: string,
): string {
  const base = `Bash sandbox init failed (${errorMessage}); bash stays gated per action.`;
  // ASRT's initialize() throws "Sandbox dependencies not available: ..." only when
  // the Linux binary checks fail; anchor on that so unrelated failures stay terse.
  if (platform === "linux" && /dependencies not available/i.test(errorMessage)) {
    return `${base} On Debian/Ubuntu, install the prerequisites with: sudo apt install ${LINUX_SANDBOX_APT_PACKAGES.join(" ")}`;
  }
  return base;
}
