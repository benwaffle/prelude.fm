'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { SpotifyPlayerProvider } from '@/lib/spotify-player-context';
import { LibraryProvider } from '@/lib/library-context';
import { getSpotifyToken } from '@/app/actions/spotify';
import { PreludeNav } from './PreludeNav';
import { PlayerBar } from './PlayerBar';
import { MobileTabs } from './MobileTabs';

// Spotify tokens last an hour; refresh with room to spare.
const TOKEN_REFRESH_INTERVAL_MS = 50 * 60 * 1000;

interface NavSearch {
  query: string;
  setQuery: (value: string) => void;
}

const NavSearchContext = createContext<NavSearch>({ query: '', setQuery: () => {} });

export function useNavSearch(): NavSearch {
  return useContext(NavSearchContext);
}

interface AppShellProps {
  children: ReactNode;
}

function sectionFor(pathname: string): {
  current: 'library' | 'catalogue';
  placeholder: string;
} {
  return pathname.startsWith('/catalog')
    ? { current: 'catalogue', placeholder: 'Composer, work, catalogue no.…' }
    : { current: 'library', placeholder: 'Search your library…' };
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const { current, placeholder } = sectionFor(pathname);
  const { data: session, isPending } = authClient.useSession();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [tokenUserId, setTokenUserId] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const navSearch = useMemo(() => ({ query, setQuery }), [query]);

  // The search box empties when crossing between library and catalogue; within a section it keeps
  // what you typed.
  const [searchedSection, setSearchedSection] = useState(current);
  if (searchedSection !== current) {
    setSearchedSection(current);
    setQuery('');
  }

  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    const refresh = () => {
      getSpotifyToken()
        .then((token) => {
          if (cancelled) return;
          setAccessToken(token);
          setTokenUserId(session.user.id);
          setTokenError(null);
        })
        .catch((err) => {
          console.error('Error fetching token:', err);
          if (!cancelled) setTokenError(err instanceof Error ? err.message : 'Unknown error');
        });
    };

    refresh();
    const interval = setInterval(refresh, TOKEN_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [session]);

  // Better Auth resolves the session on the client; showing sign-in on first paint would flash it
  // at signed-in users.
  if (isPending) return <Interlude>Opening the hall…</Interlude>;

  if (!session) return <SignIn />;

  if (tokenError) {
    return (
      <Interlude>
        Spotify wouldn’t issue a token ({tokenError}).{' '}
        <button
          type="button"
          onClick={() => authClient.signIn.social({ provider: 'spotify', callbackURL: '/' })}
          className="cursor-pointer border-b border-rule text-ink hover:border-ink"
        >
          Sign in again
        </button>
        .
      </Interlude>
    );
  }

  if (!accessToken || tokenUserId !== session.user.id) return <Interlude>Tuning up…</Interlude>;

  return (
    <SpotifyPlayerProvider accessToken={accessToken}>
      <LibraryProvider key={session.user.id} accessToken={accessToken} userId={session.user.id}>
        <NavSearchContext.Provider value={navSearch}>
          <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
            <div className="absolute -top-[30%] -right-[15%] h-[80vw] w-[80vw] opacity-55 blur-[20px] transition-[background] duration-700 [background:radial-gradient(closest-side,var(--room),transparent_70%)]" />
          </div>
          <PreludeNav
            current={current}
            query={query}
            setQuery={setQuery}
            placeholder={placeholder}
          />
          <div className="relative z-[1] min-h-screen">{children}</div>
          <div className="fixed inset-x-0 bottom-0 z-10">
            <PlayerBar />
            <MobileTabs current={current} />
          </div>
        </NavSearchContext.Provider>
      </LibraryProvider>
    </SpotifyPlayerProvider>
  );
}

function Interlude({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <p className="max-w-[46ch] text-center font-display text-lg text-muted italic">{children}</p>
    </div>
  );
}

function SignIn() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-7 bg-paper px-6">
      <div className="flex items-baseline gap-2">
        <span className="font-display text-5xl leading-none font-medium tracking-[-0.01em] italic">
          prelude<span className="text-accent">.</span>fm
        </span>
      </div>
      <p className="max-w-[38ch] text-center font-display text-lg text-muted italic">
        Your liked movements, gathered back into the works they belong to.
      </p>
      <button
        type="button"
        onClick={() => authClient.signIn.social({ provider: 'spotify', callbackURL: '/' })}
        className="cursor-pointer rounded-[2px] bg-ink px-6 py-3 font-meta text-[11px] tracking-[0.2em] text-paper uppercase transition-colors duration-150 hover:bg-accent"
      >
        Sign in with Spotify
      </button>
    </div>
  );
}
