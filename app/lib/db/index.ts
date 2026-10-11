import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const db = drizzle(client, { schema });

/** Query surface shared by the root client and a libSQL transaction. */
export type DatabaseExecutor = Pick<
  typeof db,
  'select' | 'selectDistinct' | 'insert' | 'update' | 'delete' | 'all'
>;
