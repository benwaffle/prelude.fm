// Usage: pnpm catalog:count [--budget <rows>] [--minutes <n>]
// Counts the composer list (`catalog_composer`): composers never counted first, then those counted
// longest ago. The daily cron does a slice; this is for catching up in one go (after a dump
// import). Without a budget it counts every composer once, which reads about the whole library.
import { defineScript } from './lib/cli';

defineScript(
  { options: { budget: { type: 'integer', min: 1 }, minutes: { type: 'integer', min: 1 } } },
  async ({ options }) => {
    const { refreshCatalogComposers } = await import('@/lib/musicbrainz-composer-catalogue');
    const started = Date.now();
    const result = await refreshCatalogComposers({
      budgetRows: options.budget,
      timeMs: options.minutes && options.minutes * 60_000,
    });
    console.log(
      `Counted ${result.counted.toLocaleString('en')} composers, about ${result.rowsRead.toLocaleString('en')} rows read, in ${Math.round((Date.now() - started) / 1000)}s. ${result.uncounted.toLocaleString('en')} not counted yet.`,
    );
    return 0;
  },
);
