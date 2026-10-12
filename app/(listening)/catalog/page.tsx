'use client';

import { Suspense } from 'react';
import { CatalogScreen } from '@/app/components/catalog/CatalogScreen';

export default function CatalogPage() {
  return (
    <Suspense>
      <CatalogScreen />
    </Suspense>
  );
}
