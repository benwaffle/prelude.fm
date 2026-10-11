/**
 * One-time authorisation for prelude_fm_bot.
 *
 * MusicBrainz issues access tokens that expire and a refresh token that does
 * not, so this is run once and what it prints is kept. It uses the
 * out-of-band redirect, which is what MusicBrainz offers installed
 * applications: no web server, no callback to host — the authorise page shows
 * a code and you paste it back.
 *
 *   pnpm mb:authorise            print the URL to open
 *   pnpm mb:authorise <code>     exchange the code for a refresh token
 *
 * Register the application first at
 * https://musicbrainz.org/account/applications with:
 *   Type:     Installed application
 *   Callback: urn:ietf:wg:oauth:2.0:oob
 *
 * Then put MUSICBRAINZ_CLIENT_ID and MUSICBRAINZ_CLIENT_SECRET in .envrc and
 * run this. Authorise while signed in as prelude_fm_bot, not as yourself —
 * the token carries whoever was logged in, and edits made with the wrong one
 * are attributed to the wrong account.
 */
import { defineScript } from './lib/cli';
import {
  botAuthorizationUrl,
  BOT_REDIRECT_URI,
  TOKEN_ENDPOINT,
} from '../app/lib/musicbrainz-oauth';

defineScript({ options: {}, positionals: true, database: false }, async ({ positionals }) => {
  const clientId = process.env.MUSICBRAINZ_CLIENT_ID;
  const clientSecret = process.env.MUSICBRAINZ_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      'Set MUSICBRAINZ_CLIENT_ID and MUSICBRAINZ_CLIENT_SECRET first.\n' +
        'Register at https://musicbrainz.org/account/applications as an\n' +
        'Installed application with callback urn:ietf:wg:oauth:2.0:oob',
    );
    return 1;
  }

  const code = positionals[0];

  if (!code) {
    const url = botAuthorizationUrl(clientId);

    console.log(`
1. Sign in to MusicBrainz as prelude_fm_bot (not as yourself).
2. Open:

${url}

3. Approve, copy the code it shows, and run:

   pnpm mb:authorise <code>
`);
    return;
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: BOT_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    console.error(
      `MusicBrainz refused the code (${response.status}). ` +
        'Codes are single-use and short-lived — request a fresh one with `pnpm mb:authorise`.',
    );
    return 1;
  }

  const body = (await response.json()) as { refresh_token?: string };
  if (!body.refresh_token) {
    console.error(
      'No refresh token came back. The authorise URL needs access_type=offline; ' +
        'run `pnpm mb:authorise` again to get a correctly formed one.',
    );
    return 1;
  }

  console.log(`
Add this to .envrc, then \`direnv allow\`:

export MUSICBRAINZ_BOT_REFRESH_TOKEN=${body.refresh_token}

It does not expire. Replace MUSICBRAINZ_BOT_REFRESH_TOKEN in the Vercel
Production environment too, then redeploy. The previous token only has
submit_isrc and cannot submit barcodes. Treat it as a password — anyone
holding it can edit MusicBrainz as prelude_fm_bot. Check with:

  pnpm mb:bot --max-edits 5
`);
});
