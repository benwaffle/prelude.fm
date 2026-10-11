'use client';

import { Suspense } from 'react';
import { CatalogScreen } from '@/app/components/catalog/CatalogScreen';

export default function CatalogPage() {
  // The catalogue reads where it is from the URL's search params.
  return (
    <Suspense>
      <CatalogScreen />
    </Suspense>
  );
}
