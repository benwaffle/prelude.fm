import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from './db';

// Spotify only accepts the loopback IP in a redirect URI, but Better Auth treats localhost as a
// different origin; without this, signing in from localhost fails with "Invalid origin".
const LOOPBACK_ORIGINS = ['http://127.0.0.1:3000', 'http://localhost:3000'];

export const auth = betterAuth({
  trustedOrigins: process.env.NODE_ENV === 'production' ? [] : LOOPBACK_ORIGINS,
  database: drizzleAdapter(db, {
    provider: 'sqlite',
  }),
  socialProviders: {
    spotify: {
      clientId: process.env.SPOTIFY_CLIENT_ID!,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET!,
      scope: [
        'user-read-email',
        'user-read-private',
        'user-library-read',
        'user-library-modify',
        'user-top-read',
        'playlist-read-private',
        'playlist-read-collaborative',
        'streaming',
        'user-read-playback-state',
        'user-modify-playback-state',
      ],
    },
  },
});
