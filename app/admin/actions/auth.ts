'use server';

import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { createSpotifySdk } from '@/lib/spotify-sdk';
import { getSpotifyToken } from '@/app/actions/spotify';

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

async function createServerSpotifyClient(accessToken: string) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    throw new Error('SPOTIFY_CLIENT_ID is not configured');
  }
  return createSpotifySdk(accessToken, clientId);
}

export async function getSpotifyClient() {
  await checkAuth();
  const accessToken = await getSpotifyToken();
  return createServerSpotifyClient(accessToken);
}
