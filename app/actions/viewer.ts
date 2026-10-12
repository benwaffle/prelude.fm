'use server';

import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { isAdminUser } from '@/lib/admin';

export async function getViewerIsAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session ? isAdminUser(session.user.id) : false;
}
