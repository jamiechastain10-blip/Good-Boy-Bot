/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * App updates from GitHub, with no server of our own. Releases are published to the public repository below by the
 * GitHub build. The installed Windows app downloads and installs them by itself (electron-updater checks each file's
 * SHA-512 before installing). Builds that cannot replace themselves (the portable .exe, the unsigned Mac app and the
 * Owner build, which is never published) are told a new version is out and where to get it.
 * Your data is never touched: it lives outside the app folder.
 */
export const RELEASES = { owner: 'jamiechastain10-blip', repo: 'Good-Boy-Bot' };
export const releasesPage = () => `https://github.com/${RELEASES.owner}/${RELEASES.repo}/releases`;
export const latestApi = () => `https://api.github.com/repos/${RELEASES.owner}/${RELEASES.repo}/releases/latest`;

/** auto = download and install by itself; notify = tell the person; off = development or the build check. */
export function updateMode({ packaged, platform, portable = false, edition = 'consumer', smoke = false }) {
  if (!packaged || smoke) return 'off';
  if (platform === 'win32' && !portable && edition !== 'owner') return 'auto';
  return 'notify';
}

/** Each edition has its own update feed in the same repository: latest.yml (Good Boy) or developer.yml. */
export const channelFor = (edition) => (edition === 'developer' ? 'developer' : 'latest');

const parts = (v) => String(v ?? '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
/** 1 if a is newer than b, -1 if older, 0 if the same. */
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** From GitHub's "latest release" answer: is it newer than what is installed? */
export function readLatest(release, current) {
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) return { newer: false };
  const version = String(release.tag_name ?? '').replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+/.test(version)) return { newer: false };
  const url = typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/') ? release.html_url : releasesPage();
  return { newer: compareVersions(version, current) > 0, version, url, notes: String(release.body ?? '').slice(0, 2000), publishedAt: release.published_at ?? null };
}

/** What the Updates page shows, in words. */
export function describe(u) {
  switch (u?.phase) {
    case 'off': return 'Updates are checked in the installed app.';
    case 'checking': return 'Checking for updates...';
    case 'downloading': return `Downloading version ${u.version}${u.percent != null ? ` (${Math.round(u.percent)}%)` : ''}...`;
    case 'ready': return u.restartAt ? `Version ${u.version} is ready. Good Boy restarts in a moment to finish.` : `Version ${u.version} is ready. Restart Good Boy to finish.`;
    case 'available': return `Version ${u.version} is out.`;
    case 'current': return 'You have the latest version.';
    // No release at all yet: say so, instead of claiming this is the latest (it hides a publishing problem).
    case 'none': return 'No version has been published yet, so there is nothing to update to.';
    case 'error': return `Could not check for updates: ${u.error}`;
    default: return 'Not checked yet.';
  }
}

/** How long to wait before restarting by itself once an update is ready (null = do not restart by itself). */
export const RESTART_DELAY_MS = 60000;
export function restartPlan({ mode, phase, autoRestart = true, postponed = false }) {
  if (mode !== 'auto' || phase !== 'ready' || !autoRestart || postponed) return null;
  return RESTART_DELAY_MS;
}
