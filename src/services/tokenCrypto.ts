import crypto from 'crypto';

const TOKEN_PREFIX = 'enc:v1:';
const TOKEN_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const ENCRYPTION_KEY_ENV = 'TOKEN_ENCRYPTION_KEY';

let cachedDerivedKey: Buffer | null | undefined;

function getDerivedKey(): Buffer | null {
  if (cachedDerivedKey !== undefined) {
    return cachedDerivedKey;
  }

  const rawKey = process.env[ENCRYPTION_KEY_ENV];
  if (!rawKey) {
    cachedDerivedKey = null;
    return null;
  }

  // Deterministically derive a fixed 32-byte key from env input.
  cachedDerivedKey = crypto.createHash('sha256').update(rawKey, 'utf8').digest();
  return cachedDerivedKey;
}

export function isTokenEncryptionEnabled(): boolean {
  return Boolean(getDerivedKey());
}

export function isEncryptedToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

export function encryptToken(token: string): string {
  if (!token || isEncryptedToken(token)) {
    return token;
  }

  const key = getDerivedKey();
  if (!key) {
    return token;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(TOKEN_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${TOKEN_PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decryptToken(token: string): string {
  if (!token || !isEncryptedToken(token)) {
    return token;
  }

  const key = getDerivedKey();
  if (!key) {
    throw new Error(`${ENCRYPTION_KEY_ENV} is required to decrypt stored OAuth tokens`);
  }

  const payload = token.slice(TOKEN_PREFIX.length);
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('Stored encrypted token has invalid format');
  }

  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(TOKEN_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
