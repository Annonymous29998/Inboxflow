import { execFile } from 'node:child_process';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { resolveCname } from 'dns/promises';
import { cloudTrackingOrigin, trackingCnameTarget } from './public-url.js';

const execFileAsync = promisify(execFile);

/** track.example.com — the only hostname this mailer will request a certificate for. */
const TRACKING_HOST = /^track\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export function isTrackingHost(host: string): boolean {
  return TRACKING_HOST.test(host);
}

function normalizeHost(host: string): string {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

/** The name on the certificate presented for this SNI on this machine. */
export function localCertificateMatches(host: string): Promise<boolean> {
  const name = normalizeHost(host);
  if (!isTrackingHost(name)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port: 443, servername: name, rejectUnauthorized: false, timeout: 8000 },
      () => {
        const cert = socket.getPeerCertificate();
        const names = `${cert.subjectaltname || ''},${cert.subject?.CN || ''}`
          .split(/,\s*/)
          .map((part) => part.replace(/^DNS:/i, '').trim().toLowerCase());
        socket.end();
        resolve(names.includes(name));
      },
    );
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Public HTTPS, used when this process is not the server that holds the certificate. */
export async function probeTrackingHttps(host: string): Promise<boolean> {
  const name = normalizeHost(host);
  if (!isTrackingHost(name)) return false;
  try {
    const res = await fetch(`https://${name}/health`, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function cnamePointsHere(host: string): Promise<boolean> {
  const target = trackingCnameTarget();
  try {
    const rows = await resolveCname(host);
    return rows.some((row) => row.replace(/\.$/, '').toLowerCase() === target);
  } catch {
    return false;
  }
}

/** Issue a certificate on this server. Refuses any name that is not a tracking host pointing here. */
export async function publishTrackingHost(host: string): Promise<boolean> {
  const name = normalizeHost(host);
  if (!isTrackingHost(name)) return false;
  if (!(await cnamePointsHere(name))) return false;
  if (await localCertificateMatches(name)) return true;
  if (process.env.TRACKING_CERT_ISSUE !== '1') return false;
  try {
    await execFileAsync('sudo', ['-n', '/usr/local/sbin/inboxflow-issue-tracking-cert', name], {
      timeout: 110_000,
    });
  } catch (error) {
    console.error('Tracking certificate was not issued', name, error instanceof Error ? error.message : error);
    return false;
  }
  return localCertificateMatches(name);
}

async function askCloud(authorization: string, host: string): Promise<boolean> {
  try {
    const res = await fetch(`${cloudTrackingOrigin()}/api/workspace/tracking-host`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ host }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ready?: boolean };
    return Boolean(data.ready);
  } catch {
    return false;
  }
}

/**
 * True only when https://track.domain already answers with its own certificate.
 * On the public server this can request that certificate. On a PC it asks the public server.
 */
export async function ensureTrackingHttps(host: string, authorization?: string | null): Promise<boolean> {
  const name = normalizeHost(host);
  if (!isTrackingHost(name)) return false;
  if (process.env.TRACKING_CERT_ISSUE === '1') return publishTrackingHost(name);
  const token = String(authorization || '').trim();
  if (token) return askCloud(token, name);
  return probeTrackingHttps(name);
}
