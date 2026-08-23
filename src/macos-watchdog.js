export const MACOS_WATCHDOG_LABEL = 'io.github.claude-rotator.watchdog';
export const MACOS_MAIN_LAUNCH_AGENT_LABEL = 'io.github.claude-rotator';

export function renderMacosWatchdogScript({
  markerPath,
  installStatePath,
  mainPlistPath,
  domain,
  mainLabel = MACOS_MAIN_LAUNCH_AGENT_LABEL,
  launchctlPath = '/bin/launchctl',
  plutilPath = '/usr/bin/plutil',
  shasumPath = '/usr/bin/shasum',
}) {
  return `#!/bin/sh
set -u

MARKER_PATH=${shellQuote(markerPath)}
INSTALL_STATE_PATH=${shellQuote(installStatePath)}
MAIN_PLIST_PATH=${shellQuote(mainPlistPath)}
DOMAIN=${shellQuote(domain)}
MAIN_LABEL=${shellQuote(mainLabel)}
LAUNCHCTL=${shellQuote(launchctlPath)}
PLUTIL=${shellQuote(plutilPath)}
SHASUM=${shellQuote(shasumPath)}

[ -f "$MARKER_PATH" ] || exit 0
[ -f "$INSTALL_STATE_PATH" ] || exit 0
[ -f "$MAIN_PLIST_PATH" ] || exit 0

marker_version=$("$PLUTIL" -extract version raw -o - "$MARKER_PATH" 2>/dev/null) || exit 0
[ "$marker_version" = 1 ] || exit 0
marker_sha=$("$PLUTIL" -extract installStateSha256 raw -o - "$MARKER_PATH" 2>/dev/null) || exit 0
case "$marker_sha" in
  *[!0123456789abcdef]* | '') exit 0 ;;
esac
[ "\${#marker_sha}" -eq 64 ] || exit 0

shasum_output=$("$SHASUM" -a 256 "$INSTALL_STATE_PATH" 2>/dev/null) || exit 0
install_state_sha=\${shasum_output%% *}
[ "$marker_sha" = "$install_state_sha" ] || exit 0

plist_label=$("$PLUTIL" -extract Label raw -o - "$MAIN_PLIST_PATH" 2>/dev/null) || exit 0
[ "$plist_label" = "$MAIN_LABEL" ] || exit 0

job="$DOMAIN/$MAIN_LABEL"
"$LAUNCHCTL" print "$job" >/dev/null 2>&1
print_status=$?
if [ "$print_status" -eq 0 ]; then
  exit 0
fi
[ "$print_status" -eq 113 ] || exit "$print_status"

"$LAUNCHCTL" bootstrap "$DOMAIN" "$MAIN_PLIST_PATH" || exit $?
"$LAUNCHCTL" print "$job" >/dev/null 2>&1
`;
}

export function renderMacosWatchdogLaunchAgentPlist({ lockPath, helperPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(MACOS_WATCHDOG_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/lockf</string>
    <string>-t</string>
    <string>0</string>
    <string>-k</string>
    <string>${xmlEscape(lockPath)}</string>
    <string>${xmlEscape(helperPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>15</integer>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
