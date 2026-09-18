'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';
import { getAdminStats } from './actions/admin-stats';
import { Spinner } from './components/Spinner';
import { DeskTab } from './tabs/DeskTab';
import { TracksTab } from './tabs/TracksTab';
import { ComposersTab } from './tabs/ComposersTab';
import { WorksTab } from './tabs/WorksTab';

type TabId = 'desk' | 'queue' | 'works' | 'composers';

const TABS: { id: TabId; label: string }[] = [
  { id: 'desk', label: 'Desk' },
  { id: 'queue', label: 'Queue' },
  { id: 'works', label: 'Works' },
  { id: 'composers', label: 'Composers' },
];

export default function AdminPage() {
  const { data: session, isPending } = authClient.useSession();
  const [tab, setTab] = useState<TabId>('desk');
  const [counts, setCounts] = useState<{ queue: number; works: number; composers: number } | null>(
    null,
  );

  const isAdmin = session?.user?.name === 'benwaffle';

  useEffect(() => {
    if (!isAdmin) return;
    getAdminStats()
      .then((stats) =>
        setCounts({
          queue: stats.pendingTracks,
          works: stats.totalWorks,
          composers: stats.unlinkedArtists,
        }),
      )
      .catch(() => setCounts(null));
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
        title="Catalogue desk"
        body="Sign in to open the desk."
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
        title="Catalogue desk"
        body={`Signed in as ${session.user?.name ?? 'someone else'}. This desk belongs to another account.`}
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
      <header className="desk-rail">
        <h1>Catalogue desk</h1>
        <span className="mono text-[10px] text-[var(--faint)]">prelude.fm</span>
        <Link href="/" className="ml-auto text-[11px] text-[var(--ink-2)] hover:text-[var(--gall)]">
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
              {counts && item.id !== 'desk' && <span className="tab-n">{counts[item.id]}</span>}
            </button>
          ))}
        </nav>
      </div>

      <main className="mx-auto max-w-[1400px] px-5 pt-7">
        {tab === 'desk' && (
          <DeskTab onSwitchTab={(next) => setTab(next === 'queue' ? 'queue' : next)} />
        )}
        {tab === 'queue' && <TracksTab onSwitchTab={(next) => setTab(next)} />}
        {tab === 'works' && <WorksTab />}
        {tab === 'composers' && <ComposersTab />}
      </main>
    </>
  );
}

/** Sign-in and access states. An empty screen should still say what to do next. */
function Gate({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="slip max-w-sm border-l-2 border-l-[var(--gall)] px-6 py-6">
        <h1 className="mb-2">{title}</h1>
        <p className="mb-5 text-[var(--ink-2)]">{body}</p>
        {action}
      </div>
    </div>
  );
}
