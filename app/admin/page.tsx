'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';
import { getAdminStats } from './actions/admin-stats';
import type { AlbumState } from './lib/album-state';
import { Spinner } from './components/Spinner';
import { GatewayBar } from './components/GatewayBar';
import { CoverageTab } from './tabs/CoverageTab';
import { AlbumsTab } from './tabs/AlbumsTab';
import { DecisionsTab } from './tabs/DecisionsTab';
import { TracksTab } from './tabs/TracksTab';
import { ComposersTab } from './tabs/ComposersTab';
import { WorksTab } from './tabs/WorksTab';

/*
 * The page is organised around one goal: let MusicBrainz describe as much of
 * the library as possible. Coverage says how far that has got, Albums is where
 * the work happens, and Decisions holds what only a person can settle. The
 * editors are still here, but they are the fallback for what MusicBrainz
 * cannot answer rather than the main event.
 */
type TabId = 'coverage' | 'albums' | 'decisions' | 'library';
type LibraryView = 'queue' | 'works' | 'composers';

const TABS: { id: TabId; label: string }[] = [
  { id: 'coverage', label: 'Coverage' },
  { id: 'albums', label: 'Albums' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'library', label: 'Library' },
];

const LIBRARY_VIEWS: { id: LibraryView; label: string }[] = [
  { id: 'queue', label: 'Unmatched tracks' },
  { id: 'works', label: 'Works' },
  { id: 'composers', label: 'Composers' },
];

export default function AdminPage() {
  const { data: session, isPending } = authClient.useSession();
  const [tab, setTab] = useState<TabId>('coverage');
  const [library, setLibrary] = useState<LibraryView>('queue');
  const [albumFilter, setAlbumFilter] = useState<AlbumState | undefined>();
  const [queueCount, setQueueCount] = useState<number | null>(null);

  const isAdmin = session?.user?.name === 'benwaffle';

  useEffect(() => {
    if (!isAdmin) return;
    getAdminStats()
      .then((stats) => setQueueCount(stats.pendingTracks))
      .catch(() => setQueueCount(null));
  }, [isAdmin]);

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  if (!session) {
    return (
      <Gate
        body="Sign in to continue."
        action={
          <button
            className="act"
            onClick={() => authClient.signIn.social({ provider: 'spotify', callbackURL: '/admin' })}
          >
            Sign in with Spotify
          </button>
        }
      />
    );
  }

  if (!isAdmin) {
    return (
      <Gate
        body={`Signed in as ${session.user?.name ?? 'someone else'}. This page is for another account.`}
        action={
          <Link className="act" href="/">
            Back to the player
          </Link>
        }
      />
    );
  }

  return (
    <>
      <header className="desk-rail relative">
        <h1>prelude admin</h1>
        <GatewayBar />
        <Link href="/" className="text-[11px] text-[var(--ink-2)] hover:text-[var(--gall)]">
          Back to the player
        </Link>
      </header>

      <div className="rule-b px-5">
        <nav className="tab-strip mx-auto max-w-[1400px]" aria-label="Sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              className="tab"
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      <main className="mx-auto max-w-[1400px] px-5 pt-6">
        {tab === 'coverage' && (
          <CoverageTab
            onPick={(state) => {
              setAlbumFilter(state);
              setTab('albums');
            }}
          />
        )}

        {tab === 'albums' && <AlbumsTab state={albumFilter} onStateChange={setAlbumFilter} />}

        {tab === 'decisions' && <DecisionsTab />}

        {tab === 'library' && (
          <div className="flex flex-col gap-5">
            <p className="max-w-[70ch] text-[var(--ink-2)]">
              For what MusicBrainz cannot answer. Anything edited here is ours alone — MusicBrainz
              will not confirm it, and it stays as entered.
            </p>
            <nav className="tab-strip" aria-label="Library">
              {LIBRARY_VIEWS.map((view) => (
                <button
                  key={view.id}
                  className="tab"
                  aria-current={library === view.id ? 'page' : undefined}
                  onClick={() => setLibrary(view.id)}
                >
                  {view.label}
                  {view.id === 'queue' && queueCount !== null && (
                    <span className="tab-n">{queueCount}</span>
                  )}
                </button>
              ))}
            </nav>
            {library === 'queue' && <TracksTab onSwitchTab={(next) => setLibrary(next)} />}
            {library === 'works' && <WorksTab />}
            {library === 'composers' && <ComposersTab />}
          </div>
        )}
      </main>
    </>
  );
}

function Gate({ body, action }: { body: string; action: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="slip max-w-sm border-l-2 border-l-[var(--gall)] px-6 py-6">
        <h1 className="mb-2">prelude admin</h1>
        <p className="mb-5 text-[var(--ink-2)]">{body}</p>
        {action}
      </div>
    </div>
  );
}
