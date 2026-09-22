'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { GatewayBar } from './components/GatewayBar';
import { Spinner } from './components/Spinner';
import { AlbumsTab } from './tabs/AlbumsTab';
import { ContributeTab } from './tabs/ContributeTab';
import { HealthTab } from './tabs/HealthTab';
import type { InboxFocus } from './lib/inbox-focus';
import { parseAdminUrl, patchAdminUrl, type AdminTab, type AdminUrlPatch } from './lib/admin-url';

/*
 * A workbench for closing MusicBrainz gaps — not a second catalogue.
 * /catalog and the player stay the map; admin is Inbox, Albums, and Health.
 */
const TABS: { id: AdminTab; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'albums', label: 'Albums' },
  { id: 'health', label: 'Health' },
];

export default function AdminPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Spinner className="h-4 w-4" />
        </div>
      }
    >
      <AdminPageContent />
    </Suspense>
  );
}

function AdminPageContent() {
  const { data: session, isPending } = authClient.useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { tab, albumFilter, inboxClass, focus } = parseAdminUrl(searchParams);

  const isAdmin = session?.user?.name === 'benwaffle';

  function updateUrl(patch: AdminUrlPatch) {
    router.push(
      `${pathname}${patchAdminUrl(new URLSearchParams(searchParams.toString()), patch)}`,
      {
        scroll: false,
      },
    );
  }

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
            onClick={() =>
              authClient.signIn.social({
                provider: 'spotify',
                callbackURL: `${pathname}${searchParams.size ? `?${searchParams}` : ''}`,
              })
            }
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
    updateUrl({
      tab: 'inbox',
      class: focus.kind === 'album' ? 'missing' : 'isrc',
      album: focus.kind === 'album' ? focus.id : null,
      release: focus.kind === 'release' ? focus.id : null,
      filter: null,
    });
  }

  function selectTab(nextTab: AdminTab) {
    updateUrl({
      tab: nextTab,
      class: nextTab === 'inbox' ? (inboxClass ?? null) : null,
      album: nextTab === 'inbox' && focus?.kind === 'album' ? focus.id : null,
      release: nextTab === 'inbox' && focus?.kind === 'release' ? focus.id : null,
      filter: nextTab === 'albums' ? (albumFilter ?? null) : null,
    });
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
              onClick={() => selectTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      <main className="mx-auto max-w-[1400px] px-5 pt-6">
        {tab === 'inbox' && (
          <ContributeTab
            focus={focus}
            inboxClass={inboxClass}
            onClassChange={(nextClass) =>
              updateUrl({
                tab: 'inbox',
                class: nextClass,
                album: null,
                release: null,
                filter: null,
              })
            }
          />
        )}

        {tab === 'albums' && (
          <AlbumsTab
            state={albumFilter}
            onStateChange={(nextFilter) =>
              updateUrl({
                tab: 'albums',
                filter: nextFilter ?? null,
                class: null,
                album: null,
                release: null,
              })
            }
            onOpenInbox={openInbox}
          />
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
