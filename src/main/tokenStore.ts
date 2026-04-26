import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface StoredAccount {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  refreshToken: string;
}

interface DiskShape {
  version: 1;
  // Each value is base64-encoded ciphertext from safeStorage. We never write
  // plaintext refresh tokens, even though the userData dir is per-user.
  accounts: Array<Omit<StoredAccount, 'refreshToken'> & { refreshToken_enc: string }>;
}

const FILE = () => path.join(app.getPath('userData'), 'accounts.json');

function readDisk(): DiskShape {
  const f = FILE();
  if (!existsSync(f)) return { version: 1, accounts: [] };
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf-8')) as DiskShape;
    if (parsed.version !== 1) return { version: 1, accounts: [] };
    return parsed;
  } catch {
    return { version: 1, accounts: [] };
  }
}

function writeDisk(d: DiskShape): void {
  const f = FILE();
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(d, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

function decrypt(b64: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'safeStorage encryption is unavailable on this system; refusing to read credentials.',
    );
  }
  return safeStorage.decryptString(Buffer.from(b64, 'base64'));
}

function encrypt(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'safeStorage encryption is unavailable on this system; refusing to persist credentials.',
    );
  }
  return safeStorage.encryptString(plain).toString('base64');
}

export function listAccounts(): StoredAccount[] {
  const d = readDisk();
  return d.accounts.map((a) => ({
    id: a.id,
    email: a.email,
    name: a.name,
    picture: a.picture,
    refreshToken: decrypt(a.refreshToken_enc),
  }));
}

export function getAccount(id: string): StoredAccount | null {
  return listAccounts().find((a) => a.id === id) ?? null;
}

export function upsertAccount(acc: StoredAccount): void {
  const d = readDisk();
  const enc = encrypt(acc.refreshToken);
  const existing = d.accounts.findIndex((a) => a.id === acc.id);
  const row = {
    id: acc.id,
    email: acc.email,
    name: acc.name,
    picture: acc.picture,
    refreshToken_enc: enc,
  };
  if (existing >= 0) d.accounts[existing] = row;
  else d.accounts.push(row);
  writeDisk(d);
}

export function removeAccount(id: string): void {
  const d = readDisk();
  d.accounts = d.accounts.filter((a) => a.id !== id);
  writeDisk(d);
}
