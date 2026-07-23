import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

function getKey(secret: string): Buffer {
  return scryptSync(secret, 'inboxflow-salt', 32);
}

export function decryptPayload(payload: string, encryptionKey: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Invalid encrypted payload');
  }

  const decipher = createDecipheriv('aes-256-gcm', getKey(encryptionKey), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

export function encryptPayload(text: string, encryptionKey: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', getKey(encryptionKey), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function parseProviderConfig(config: unknown, encryptionKey: string): Record<string, string> {
  if (typeof config === 'string') {
    try {
      return JSON.parse(decryptPayload(config, encryptionKey));
    } catch {
      return JSON.parse(config);
    }
  }
  if (config && typeof config === 'object' && 'encrypted' in config) {
    const enc = String((config as { encrypted: string }).encrypted);
    return JSON.parse(decryptPayload(enc, encryptionKey));
  }
  return (config || {}) as Record<string, string>;
}
