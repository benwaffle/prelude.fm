'use client';

import { useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';
import { GatewayBar } from './components/GatewayBar';
import { Spinner } from './components/Spinner';
import { AlbumsTab } from './tabs/AlbumsTab';
import { ContributeTab } from './tabs/ContributeTab';
import { HealthTab } from './tabs/HealthTab';
import type { AlbumState } from './lib/album-state';
import type { InboxFocus } from './lib/inbox-focus';

/*
 * A workbench for closing MusicBrainz gaps — not a second catalogue.
 * /catalog and the player stay the map; admin is Inbox, Albums, and Health.
 */
type TabId = 'inbox' | 'albums' | 'health';

const TABS: { id: TabId; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'albums', label: 'Albums' },
  { id: 'health', label: 'Health' },
];

export default function AdminPage() {
  const { data: session, isPending } = authClient.useSession();
  const [tab, setTab] = useState<TabId>('inbox');
  const [albumFilter, setAlbumFilter] = useState<AlbumState | undefined>();
  const [inboxFocus, setInboxFocus] = useState<InboxFocus | null>(null);

  const isAdmin = session?.user?.name === 'benwaffle';

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

  function openInbox(focus: InboxFocus) {
    setInboxFocus(focus);
    setTab('inbox');
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
        {tab === 'inbox' && (
          <ContributeTab focus={inboxFocus} onFocusHandled={() => setInboxFocus(null)} />
        )}

        {tab === 'albums' && (
          <AlbumsTab state={albumFilter} onStateChange={setAlbumFilter} onOpenInbox={openInbox} />
        )}

        {tab === 'health' && <HealthTab />}
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
