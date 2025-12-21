"use client";

import { authClient } from "@/lib/auth-client";
import { LikedSongs } from "./components/LikedSongs";

export default function Home() {
  const { data: session } = authClient.useSession();

  const handleSignIn = async () => {
    await authClient.signIn.social({
      provider: "spotify",
      callbackURL: "/",
    });
  };

  const handleSignOut = async () => {
    await authClient.signOut();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-4xl flex-col items-center gap-8 py-16 px-8 bg-white dark:bg-black">
        <div className="w-full flex items-center justify-between">
          <h1 className="text-4xl font-bold text-black dark:text-zinc-50">
            Classical Music Streaming
          </h1>
          {session && (
            <button
              onClick={handleSignOut}
              className="flex h-10 items-center justify-center rounded-full bg-black px-6 text-sm text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              Sign Out
            </button>
          )}
        </div>

        {session ? (
          <LikedSongs />
        ) : (
          <div className="flex flex-col items-center gap-6 py-32">
            <p className="text-lg text-zinc-600 dark:text-zinc-400">
              Sign in with Spotify to get started
            </p>
            <button
              onClick={handleSignIn}
              className="flex h-12 items-center justify-center gap-2 rounded-full bg-[#1DB954] px-8 text-white transition-colors hover:bg-[#1ed760]"
            >
              Sign in with Spotify
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
