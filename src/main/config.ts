import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface OAuthConfig {
  client_id: string;
  client_secret: string;
}

let cached: OAuthConfig | null = null;

export function loadOAuthConfig(): OAuthConfig | null {
  if (cached) return cached;

  // Resolution order (highest priority first):
  //   1. $YCAL_CONFIG               — explicit override (CLI / debugging)
  //   2. userData/oauth-client.json — per-machine override (kept for users
  //                                    who want to point yCal at a different
  //                                    OAuth client without rebuilding)
  //   3. bundled with the .app      — the default for installed users:
  //                                    process.resourcesPath/oauth-client.json
  //                                    when packaged, build/oauth-client.json
  //                                    when running `npm run dev`.
  //   4. legacy fallbacks           — appPath + cwd, kept for backwards compat.
  const candidates = [
    process.env.YCAL_CONFIG,
    path.join(app.getPath('userData'), 'oauth-client.json'),
    app.isPackaged
      ? path.join(process.resourcesPath, 'oauth-client.json')
      : path.join(app.getAppPath(), 'build', 'oauth-client.json'),
    path.join(app.getAppPath(), 'oauth-client.json'),
    path.join(process.cwd(), 'oauth-client.json'),
  ].filter((p): p is string => !!p);

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      // Google Cloud Console downloads the credentials wrapped in { installed: { ... } }.
      const node = raw.installed ?? raw.web ?? raw;
      if (node.client_id && node.client_secret) {
        cached = { client_id: node.client_id, client_secret: node.client_secret };
        return cached;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export function isConfigured(): boolean {
  return loadOAuthConfig() !== null;
}
