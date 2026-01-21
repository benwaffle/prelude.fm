'use client';

import { authClient } from '@/lib/auth-client';
import { LikedSongs } from './components/LikedSongs';
import { SpotifyPlayer } from './components/SpotifyPlayer';
import { SpotifyPlayerProvider } from '@/lib/spotify-player-context';
import { useEffect, useState } from 'react';
import { getSpotifyToken } from './actions/spotify';

export default function Home() {
  const { data: session } = authClient.useSession();
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    if (session) {
      getSpotifyToken()
        .then((token) => setAccessToken(token))
        .catch((err) => console.error('Error fetching token:', err));
    }
  }, [session]);

  const handleSignIn = async () => {
    await authClient.signIn.social({
      provider: 'spotify',
      callbackURL: '/',
    });
  };

  const handleSignOut = async () => {
    await authClient.signOut();
  };

  return (
    <div className="flex min-h-screen font-sans">
      <main className="flex min-h-screen w-full flex-col items-center gap-8 py-6 px-4 sm:px-6 lg:px-12 max-w-[1600px] mx-auto">
        {/* Editorial Header */}
        <header className="w-full flex items-start justify-between pt-4 pb-2 animate-fade-in-up">
          <div className="flex flex-col gap-0.5">
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight accent-line" style={{ color: 'var(--charcoal)' }}>
              prelude.fm
            </h1>
            <p className="text-xs tracking-wide uppercase mt-1" style={{ color: 'var(--warm-gray)', letterSpacing: '0.15em' }}>
              Classical Music Library
            </p>
          </div>
          {session && (
            <button
              onClick={handleSignOut}
              className="flex h-11 items-center justify-center px-6 text-sm font-medium transition-all duration-300 cursor-pointer refined-hover border"
              style={{
                background: 'transparent',
                color: 'var(--charcoal)',
                borderColor: 'var(--border-strong)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--charcoal)';
                e.currentTarget.style.color = 'var(--cream)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--charcoal)';
              }}
            >
              Sign Out
            </button>
          )}
        </header>

        {/* Decorative divider */}
        <div className="w-full h-px animate-fade-in stagger-2 -mt-2" style={{ background: 'linear-gradient(90deg, transparent, var(--border-strong) 20%, var(--border-strong) 80%, transparent)' }} />

        {session ? (
          accessToken ? (
            <SpotifyPlayerProvider accessToken={accessToken}>
              <div className="w-full animate-fade-in-up stagger-3">
                <LikedSongs accessToken={accessToken} />
              </div>
              <SpotifyPlayer />
            </SpotifyPlayerProvider>
          ) : (
            <div className="flex items-center justify-center py-24 animate-fade-in">
              <p className="text-lg" style={{ color: 'var(--warm-gray)' }}>Loading your collection...</p>
            </div>
          )
        ) : (
          <div className="flex flex-col items-center gap-8 py-32 animate-fade-in-up">
            <div className="text-center max-w-md">
              <h2 className="text-3xl font-bold mb-4" style={{ color: 'var(--charcoal)' }}>
                Your Classical Music Collection
              </h2>
              <p className="text-base leading-relaxed mb-8" style={{ color: 'var(--warm-gray)' }}>
                Stream your favorite classical works organized by composer, catalog number, and movement.
              </p>
            </div>
            <button
              onClick={handleSignIn}
              className="flex h-14 items-center justify-center gap-3 px-10 text-base font-medium transition-all duration-300 cursor-pointer refined-hover"
              style={{
                background: 'var(--accent)',
                color: 'var(--cream)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--accent-hover)';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--accent)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
              </svg>
              Continue with Spotify
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
