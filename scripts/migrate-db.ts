import { defineScript } from './lib/cli';

defineScript({ options: {} }, async () => {
  const [{ db }, { migrate }] = await Promise.all([
    import('@/lib/db'),
    import('drizzle-orm/libsql/migrator'),
  ]);
  await migrate(db, { migrationsFolder: 'drizzle' });
});
