'use server';

import type { ReadinessFunnel } from '@/lib/catalogue-readiness';
import { loadReadinessFunnel } from '../lib/catalogue-readiness-load';
import { checkAuth } from './auth';

export async function getReadinessFunnel(): Promise<ReadinessFunnel> {
  await checkAuth();
  return loadReadinessFunnel();
}
