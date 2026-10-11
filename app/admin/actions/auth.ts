'use server';

import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { isAdminUser } from '@/lib/admin';

export async function checkAuth() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error('Unauthorized');
  }

  if (!(await isAdminUser(session.user.id))) {
    throw new Error('Access denied');
  }

  return session;
}
