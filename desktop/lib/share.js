/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * "Share dashboard": a public https link to the dashboard that works from anywhere (phone on mobile data, another
 * house), using Tailscale Funnel. The computer connects out to Tailscale, so no router changes, no open ports and
 * the home IP stays hidden. The link never changes: https://<computer>.<tailnet>.ts.net
 * Discord login still decides who can do anything on the dashboard.
 */
import { execFile as realExecFile, spawn as realSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DOWNLOAD = 'https://tailscale.com/download';
const SAFE_HOSTS = new Set(['tailscale.com', 'login.tailscale.com']);
/** Only Tailscale's own pages are ever opened from here. */
export const isTailscaleLink = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && SAFE_HOSTS.has(x.hostname); } catch { return false; } };

export function tailscalePaths(platform = process.platform, env = process.env) {
  if (platform === 'win32') return [`${env.ProgramFiles || 'C:\\Program Files'}\\Tailscale\\tailscale.exe`, `${env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Tailscale\\tailscale.exe`, 'tailscale'];
  if (platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', 'tailscale'];
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale'];
}

const run = (execFile, cmd, args, timeout = 20000) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout ?? ''), err: String(stderr ?? '') }));
});

/** Tailscale's own Windows installer (the official package server, signed by Tailscale Inc.). */
export const msiUrl = (arch = process.arch) => `https://pkgs.tailscale.com/stable/tailscale-setup-latest-${arch === 'arm64' ? 'arm64' : 'amd64'}.msi`;
const SIGNER = /Tailscale Inc/i;
/** The first Tailscale sign-in page found in some text (what `tailscale login` prints). */
export const loginLinkIn = (text) => { const m = /(https:\/\/login\.tailscale\.com\/\S+)/.exec(String(text ?? '')); const u = m?.[1]?.replace(/[).,]+$/, ''); return u && isTailscaleLink(u) ? u : null; };

export class Share {
  constructor({ platform = process.platform, env = process.env, execFile = realExecFile, spawn = realSpawn, exists = fs.existsSync, fetchFn = (...a) => fetch(...a), tmp = os.tmpdir() } = {}) {
    this.platform = platform; this.env = env; this.execFile = execFile; this.spawn = spawn; this.exists = exists; this.fetchFn = fetchFn; this.tmp = tmp; this.bin = null;
  }

  /**
   * Installs Tailscale on Windows without the person hunting for it. First winget (built into Windows 11; it checks
   * the package's hash itself), else Tailscale's own .msi from its package server, kept only if Windows says it is
   * signed by Tailscale Inc. Windows asks once to allow the install. Other systems get the download page.
   */
  async install({ onStep = () => {} } = {}) {
    if (await this.find()) return { ok: true, already: true };
    if (this.platform !== 'win32') return { ok: false, error: 'Install Tailscale from its website, then come back.', link: DOWNLOAD };
    onStep('Installing Tailscale (Windows will ask you to allow it)...');
    const w = await run(this.execFile, 'winget', ['install', '--id', 'Tailscale.Tailscale', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], 600000);
    if (await this.waitForBin(30)) return { ok: true, via: 'winget' };
    onStep('Downloading Tailscale...');
    const file = path.join(this.tmp, `tailscale-setup-${Date.now()}.msi`);
    try {
      const r = await this.fetchFn(msiUrl(), { redirect: 'follow', signal: AbortSignal.timeout(300000) });
      if (!r.ok) throw new Error(`the download answered ${r.status}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    } catch (e) { return { ok: false, error: `Could not download Tailscale (${e.message}).${w.ok ? '' : ' '}`, link: DOWNLOAD }; }
    const ps = (cmd) => run(this.execFile, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], 600000);
    const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
    const sig = await ps(`$s = Get-AuthenticodeSignature -LiteralPath ${q(file)}; "$($s.Status)|$($s.SignerCertificate.Subject)"`);
    const [status, subject] = sig.out.trim().split('|');
    if (status !== 'Valid' || !SIGNER.test(subject ?? '')) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } return { ok: false, error: 'The Tailscale download was not signed by Tailscale, so it was not installed.', link: DOWNLOAD }; }
    onStep('Installing Tailscale (Windows will ask you to allow it)...');
    const inst = await ps(`$p = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', ${q(`"${file}"`)}, '/quiet', '/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`);
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    if (await this.waitForBin(30)) return { ok: true, via: 'msi' };
    return { ok: false, error: /canceled|cancelled|1223/i.test(inst.err + inst.out) || inst.code === 1223 ? 'The install was cancelled. Press Set up again and choose Yes when Windows asks.' : 'Tailscale did not finish installing.', link: DOWNLOAD };
  }

  async waitForBin(seconds, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    for (let k = 0; k < seconds; k++) { if (await this.find()) return true; await sleep(1000); }
    return false;
  }

  /**
   * Starts Tailscale's sign-in and returns its page so the app can open it. The sign-in finishes in the browser;
   * waitFor() then notices this computer is connected.
   */
  login() {
    return new Promise((resolve) => {
      let child, done = false, text = '';
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try { child = this.spawn(this.bin, ['login', '--timeout=600s'], { windowsHide: true }); } catch (e) { return finish({ ok: false, error: e.message }); }
      const look = (d) => { text += String(d); const u = loginLinkIn(text); if (u) finish({ ok: true, link: u }); };
      child.stdout?.on('data', look); child.stderr?.on('data', look);
      child.on('error', (e) => finish({ ok: false, error: e.message }));
      child.on('exit', (code) => finish(code === 0 ? { ok: true, already: true } : { ok: false, error: text.trim().split('\n').pop() || 'Tailscale sign-in did not start.' }));
      setTimeout(() => finish({ ok: false, error: 'Tailscale did not show a sign-in page.' }), 30000).unref?.();
    });
  }

  /** Checks every few seconds until test() says yes or the time runs out. */
  async waitFor(test, { seconds = 600, every = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), cancelled = () => false } = {}) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) { if (cancelled()) return false; if (await test()) return true; await sleep(every); }
    return false;
  }

  async find() {
    for (const p of tailscalePaths(this.platform, this.env)) {
      if (p !== 'tailscale' && !this.exists(p)) continue;
      const r = await run(this.execFile, p, ['version'], 8000);
      if (r.ok) { this.bin = p; return p; }
    }
    this.bin = null; return null;
  }

  /** Where things stand, in one object the window can show. */
  async status(port) {
    if (!this.bin && !(await this.find())) return { state: 'missing', link: DOWNLOAD };
    const r = await run(this.execFile, this.bin, ['status', '--json']);
    let j = null; try { j = JSON.parse(r.out); } catch { /* not running */ }
    if (!j) return { state: 'stopped', error: 'Tailscale is installed but not running. Open the Tailscale app.' };
    if (j.BackendState !== 'Running') return { state: 'login', error: 'Sign in to Tailscale (open the Tailscale app and log in).', link: typeof j.AuthURL === 'string' && isTailscaleLink(j.AuthURL) ? j.AuthURL : null };
    const host = String(j.Self?.DNSName ?? '').replace(/\.$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(host)) return { state: 'error', error: 'Tailscale did not report a name for this computer. Turn on MagicDNS in the Tailscale admin console.' };
    const url = `https://${host}`;
    const funnel = await this.isFunneling(port);
    return { state: funnel ? 'on' : 'off', url, host };
  }

  async isFunneling(port) {
    const r = await run(this.execFile, this.bin, ['funnel', 'status', '--json']);
    let j = null; try { j = JSON.parse(r.out); } catch { return false; }
    const web = JSON.stringify(j?.Web ?? {});
    const allow = j?.AllowFunnel && Object.values(j.AllowFunnel).some(Boolean);
    return !!allow && (web.includes(`127.0.0.1:${port}`) || web.includes(`localhost:${port}`));
  }

  /**
   * Turns the public link on. Returns { ok, url } or { ok: false, error, link, state }. When Tailscale first needs
   * Funnel allowed for the account it prints a page to approve and keeps waiting; that page comes back straight away
   * (state 'approve') while Tailscale finishes on its own once it is approved.
   */
  async on(port) {
    const st = await this.status(port);
    if (st.state === 'on') return { ok: true, url: st.url };
    if (st.state !== 'off') return { ok: false, error: st.error ?? 'Install Tailscale first.', link: st.link ?? null, state: st.state };
    const r = await this.funnelCommand(port, ['funnel', '--bg', '--yes', `http://127.0.0.1:${port}`]);
    if (/flag provided but not defined: -yes/.test(r.text) && !r.link) Object.assign(r, await this.funnelCommand(port, ['funnel', '--bg', `http://127.0.0.1:${port}`])); // older Tailscale
    if (await this.isFunneling(port)) return { ok: true, url: st.url };
    if (r.link) return { ok: false, error: 'Allow Funnel (public links) for your Tailscale account once. Good Boy carries on by itself after you approve.', link: r.link, state: 'approve' };
    return { ok: false, error: `Tailscale could not share the dashboard: ${r.text.trim().split('\n').pop()?.slice(0, 200) || 'unknown problem'}` };
  }

  funnelCommand(port, args) {
    return new Promise((resolve) => {
      let child, done = false, text = '';
      const finish = (extra = {}) => { if (!done) { done = true; resolve({ text, link: loginLinkIn(text), ...extra }); } };
      try { child = this.spawn(this.bin, args, { windowsHide: true }); } catch (e) { text = e.message; return finish(); }
      const look = (d) => { text += String(d); if (loginLinkIn(text)) finish(); };
      child.stdout?.on('data', look); child.stderr?.on('data', look);
      child.on('error', (e) => { text += e.message; finish(); });
      child.on('exit', (code) => finish({ code }));
      setTimeout(() => finish(), 60000).unref?.();
    });
  }

  async off() {
    if (!this.bin && !(await this.find())) return { ok: true };
    const r = await run(this.execFile, this.bin, ['funnel', '--https=443', 'off']);
    return r.ok || /not.*serv|no serve config|nothing/i.test(r.err + r.out) ? { ok: true } : { ok: false, error: (r.err || r.out).trim().slice(0, 200) };
  }
}

/** The bot settings that make the dashboard use the public link (its login comes back to the same address). */
export function shareSettings(url) {
  return url ? { DASHBOARD_BASE_URL: url, DASHBOARD_TRUST_PROXY: '1' } : { DASHBOARD_BASE_URL: '', DASHBOARD_TRUST_PROXY: '' };
}
