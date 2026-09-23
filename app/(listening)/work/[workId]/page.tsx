'use client';

import { use } from 'react';
import { DetailScreen } from '@/app/components/detail/DetailScreen';

export default function WorkDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workId: string }>;
  searchParams: Promise<{ rec?: string }>;
}) {
  const { workId } = use(params);
  const { rec } = use(searchParams);

  // MusicBrainz work identity is an MBID. The route does
  // not need to know which.
  if (workId === '') {
    return (
      <main className="mx-auto max-w-[1280px] px-6 pt-16">
        <p className="font-display text-[15px] text-muted italic">That isn’t a work we hold.</p>
      </main>
    );
  }

  return (
    <DetailScreen workId={workId} recordingId={rec !== undefined && rec !== '' ? rec : null} />
  );
}
