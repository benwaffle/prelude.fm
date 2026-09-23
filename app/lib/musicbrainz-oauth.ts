/**
 * Getting a usable access token for `prelude_fm_bot`.
 *
 * MusicBrainz access tokens expire, so the thing worth storing is the refresh
 * token: it does not, and it can be exchanged for an access token whenever
 * one is needed. A static bearer in the environment would work for an hour
 * and then start failing in a way that looks like the bot being rejected.
 *
 * Nothing here is written down. The refresh token and client secret come from
 * the environment, the access token lives in memory until shortly before it
 * expires, and neither is logged — a token is a password, and the failure
 * mode for printing one is somebody else editing the database as us.
 */

const TOKEN_ENDPOINT = 'https://musicbrainz.org/oauth2/token';
export const BOT_SCOPES = 'submit_isrc submit_barcode';

export function botAuthorizationUrl(clientId: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
    scope: BOT_SCOPES,
    access_type: 'offline',
  });
  return `https://musicbrainz.org/oauth2/authorize?${query}`;
}

/** Refresh a little early, so a token cannot expire mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

export class MusicBrainzAuthError extends Error {}

let cached: { token: string; expiresAt: number } | null = null;

export type BotCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

/** What the environment supplies, or null when the bot is not configured. */
export function botCredentials(): BotCredentials | null {
  const clientId = process.env.MUSICBRAINZ_CLIENT_ID;
  const clientSecret = process.env.MUSICBRAINZ_CLIENT_SECRET;
  const refreshToken = process.env.MUSICBRAINZ_BOT_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

/**
 * An access token, from the cache when one is still good.
 *
 * This deliberately does not go through the request gateway. The gateway
 * exists to keep us inside MusicBrainz's one-request-per-second budget for
 * the *web service*; the OAuth endpoint is a different service, and queueing
 * a token refresh behind a backfill would stall a submission for no reason.
 */
export async function botAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) return cached.token;

  const credentials = botCredentials();
  if (!credentials) {
    throw new MusicBrainzAuthError(
      'prelude_fm_bot is not configured. Set MUSICBRAINZ_CLIENT_ID, ' +
        'MUSICBRAINZ_CLIENT_SECRET and MUSICBRAINZ_BOT_REFRESH_TOKEN — ' +
        'run `pnpm mb:authorise` to obtain the refresh token.',
    );
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });

  if (!response.ok) {
    // The body can echo the credentials back, so it is not repeated here.
    throw new MusicBrainzAuthError(
      `MusicBrainz refused the refresh token (${response.status}). ` +
        'It may have been revoked; re-run `pnpm mb:authorise`.',
    );
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new MusicBrainzAuthError('MusicBrainz returned no access token.');
  }

  cached = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** Test seam, and a way to force a refresh after re-authorising. */
export function forgetBotAccessToken() {
  cached = null;
}
