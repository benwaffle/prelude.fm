'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { useIsAdmin } from '@/lib/use-is-admin';
import { GatewayBar } from './components/GatewayBar';
import { AdminFailureNotice, AdminFailureProvider } from './components/AdminFailure';
import { Spinner } from './components/Spinner';
import { AlbumsTab } from './tools/AlbumsTab';
import { HealthTab } from './tools/HealthTab';
import { ReleaseCorrectionsTab } from './tools/ReleaseCorrectionsTab';
import { RefreshWorkTab } from './tools/RefreshWorkTab';
import { AdminHome } from './home/AdminHome';
import { InboxSectionPage } from './inbox/InboxSectionPage';
import {
  adminHref,
  INBOX_CLASSES,
  PAGE_TITLE,
  parseAdminUrl,
  type InboxClass,
} from './lib/admin-url';

// A workbench for closing MusicBrainz gaps, not a second catalogue.
export default function AdminPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Spinner className="h-4 w-4" />
        </div>
      }
    >
      <AdminFailureProvider>
        <AdminPageContent />
      </AdminFailureProvider>
    </Suspense>
  );
}

function AdminPageContent() {
  const { data: session, isPending } = authClient.useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { page, albumFilter, focus } = parseAdminUrl(searchParams);

  const isAdmin = useIsAdmin(session?.user?.id);

  if (isPending || (session && isAdmin === null)) {
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

  return (
    <>
      <header className="desk-rail relative">
        <h1>
          <Link href="/admin" className="no-underline">
            prelude admin
          </Link>
        </h1>
        <GatewayBar />
        <Link href="/" className="text-[11px] text-[var(--ink-2)] hover:text-[var(--gall)]">
          Back to the player
        </Link>
      </header>

      <main className="mx-auto max-w-[1400px] px-5 pt-6">
        <AdminFailureNotice />
        {page === null ? (
          <AdminHome />
        ) : (
          <>
            <nav className="mb-4 flex flex-wrap items-baseline gap-2" aria-label="Breadcrumb">
              <Link href="/admin" className="text-[var(--ink-2)] hover:text-[var(--gall)]">
                ← Admin home
              </Link>
              <h2 className="panel-title">{PAGE_TITLE[page]}</h2>
            </nav>
            {isInboxClass(page) && <InboxSectionPage key={page} section={page} focus={focus} />}
            {page === 'albums' && (
              <AlbumsTab
                state={albumFilter}
                onStateChange={(nextFilter) =>
                  router.push(adminHref('albums', { albumFilter: nextFilter }), { scroll: false })
                }
                onOpenInbox={(nextFocus) =>
                  router.push(
                    adminHref(nextFocus.kind === 'album' ? 'missing' : 'isrc', {
                      focus: nextFocus,
                    }),
                  )
                }
              />
            )}
            {page === 'corrections' && <ReleaseCorrectionsTab />}
            {page === 'refresh-work' && <RefreshWorkTab />}
            {page === 'checks' && <HealthTab />}
          </>
        )}
      </main>
    </>
  );
}

function isInboxClass(page: string): page is InboxClass {
  return (INBOX_CLASSES as readonly string[]).includes(page);
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
