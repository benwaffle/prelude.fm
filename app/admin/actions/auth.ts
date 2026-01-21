'use server';

import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { createSpotifySdk } from '@/lib/spotify-sdk';

export async function checkAuth() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error('Unauthorized');
  }

  if (session.user.name !== 'benwaffle') {
    throw new Error('Access denied');
  }

  return session;
}

async function getSpotifyAccessToken(userId: string) {
  const tokenResponse = await auth.api.getAccessToken({
    body: {
      providerId: 'spotify',
      userId,
    },
    headers: await headers(),
  });

  if (!tokenResponse?.accessToken) {
    throw new Error('No Spotify access token');
  }

  return tokenResponse.accessToken;
}

async function createServerSpotifyClient(accessToken: string) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    throw new Error('SPOTIFY_CLIENT_ID is not configured');
  }
  return createSpotifySdk(accessToken, clientId);
}

export async function getSpotifyClient() {
  const session = await checkAuth();
  const accessToken = await getSpotifyAccessToken(session.user.id);
  return createServerSpotifyClient(accessToken);
}
