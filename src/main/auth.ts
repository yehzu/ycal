import { shell } from 'electron';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { loadOAuthConfig } from './config';
import { upsertAccount, type StoredAccount } from './tokenStore';
import { NETWORK_TIMEOUT_MS, withNetworkTimeout } from './networkTimeout';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  // appdata = a hidden per-app folder Google Drive provides; nothing here
  // is visible at drive.google.com. Used by Drive sync to round-trip
  // rhythm.json / tasks-schedule.json / settings.json / tasks.md across
  // Macs + iPhone. Existing accounts authorized before this scope was
  // added will need to be removed + re-added for sync to work.
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
];

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>yCal — signed in</title>
<style>
  body { background:#f4ede0; color:#1a1814; font-family: ui-serif, Georgia, serif;
         display:grid; place-items:center; height:100vh; margin:0; }
  .card { padding:32px 40px; border-top:3px double #1a1814; border-bottom:3px double #1a1814; text-align:center; }
  h1 { font-style:italic; font-weight:700; margin:0 0 8px; }
  p  { color:#6e6757; margin:0; }
</style></head>
<body><div class="card"><h1>yCal</h1><p>Signed in. You may close this tab and return to the app.</p></div></body></html>`;

const ERROR_HTML = (msg: string) => `<!doctype html>
<html><body style="font-family:ui-serif,Georgia,serif;background:#f4ede0;padding:40px">
<h1 style="font-style:italic">yCal — sign-in failed</h1>
<pre style="white-space:pre-wrap">${msg.replace(/[<>&]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string),
)}</pre></body></html>`;

interface AuthCallbackResult {
  code: string;
  state: string;
}

export async function startAddAccount(): Promise<StoredAccount> {
  const cfg = loadOAuthConfig();
  if (!cfg) {
    throw new Error(
      'OAuth client credentials not configured. See README for Google Cloud Console setup.',
    );
  }
  const state = crypto.randomBytes(16).toString('hex');
  return runAuthDance(cfg, state);
}

async function runAuthDance(
  cfg: { client_id: string; client_secret: string },
  state: string,
): Promise<StoredAccount> {
  // Bind a localhost server on an ephemeral port. Google treats
  // http://127.0.0.1 as a wildcard for any port on a Desktop OAuth client,
  // so we don't need to pre-register a fixed port.
  const { server, port } = await new Promise<{
    server: ReturnType<typeof createServer>;
    port: number;
  }>((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as AddressInfo;
      resolve({ server: s, port: addr.port });
    });
  });

  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

  const callback = new Promise<AuthCallbackResult>((resolve, reject) => {
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.pathname !== '/oauth2callback') {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const code = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        if (error) {
          res.statusCode = 400;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(ERROR_HTML(`Google returned error: ${error}`));
          reject(new Error(`OAuth error from Google: ${error}`));
          return;
        }
        if (!code || !gotState) {
          res.statusCode = 400;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(ERROR_HTML('Missing code or state.'));
          reject(new Error('OAuth callback missing code or state.'));
          return;
        }
        if (gotState !== state) {
          res.statusCode = 400;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(ERROR_HTML('State mismatch — refusing to proceed.'));
          reject(new Error('OAuth state mismatch.'));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(SUCCESS_HTML);
        resolve({ code, state: gotState });
      } catch (e) {
        reject(e);
      }
    });
  });

  const oauth2 = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, redirectUri);
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });

  await shell.openExternal(authUrl);

  let result: AuthCallbackResult;
  try {
    result = await callback;
  } finally {
    server.close();
  }

  const { tokens } = await withNetworkTimeout(
    'oauth.getToken',
    () => oauth2.getToken(result.code),
    NETWORK_TIMEOUT_MS * 2, // sign-in is user-initiated; allow extra slack.
  );
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and try again.',
    );
  }
  oauth2.setCredentials(tokens);

  const oauth2v2 = google.oauth2({ version: 'v2', auth: oauth2 });
  const profile = await withNetworkTimeout('oauth.userinfo', () =>
    oauth2v2.userinfo.get({}, { timeout: NETWORK_TIMEOUT_MS }),
  );
  const email = profile.data.email;
  if (!email) throw new Error('Google profile missing email.');

  const stored: StoredAccount = {
    id: profile.data.id ?? email,
    email,
    name: profile.data.name ?? null,
    picture: profile.data.picture ?? null,
    refreshToken: tokens.refresh_token,
  };
  upsertAccount(stored);
  return stored;
}

// One OAuth2Client per account, reused for the process's lifetime.
//
// A fresh client starts with no access token, so its very first request
// spends a full token-refresh round trip — and every caller here used to
// mint one per call. listAllMeetingArchives() walks the accounts and
// builds a client per account, so a single `ycal recordings` paid one
// refresh per signed-in account before it could even list. Reuse also
// lets google-auth-library do its job: one client dedupes concurrent
// refreshes and keeps the access token until it actually expires, which
// matters now that the meta reads run six-wide.
//
// Keyed by account id, but the cached entry is only handed back when the
// OAuth client_id AND the refresh token still match — so re-adding an
// account (new refresh token) or editing the OAuth config rebuilds
// instead of silently reusing a client bound to dead credentials. An
// entry for a removed account is simply never looked up again.
const clientCache = new Map<
  string,
  { clientId: string; refreshToken: string; client: OAuth2Client }
>();

export function authClientForAccount(account: StoredAccount): OAuth2Client {
  const cfg = loadOAuthConfig();
  if (!cfg) throw new Error('OAuth client credentials not configured.');
  const hit = clientCache.get(account.id);
  if (hit && hit.clientId === cfg.client_id && hit.refreshToken === account.refreshToken) {
    return hit.client;
  }
  const oauth2 = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
  oauth2.setCredentials({ refresh_token: account.refreshToken });
  clientCache.set(account.id, {
    clientId: cfg.client_id,
    refreshToken: account.refreshToken,
    client: oauth2,
  });
  return oauth2;
}
