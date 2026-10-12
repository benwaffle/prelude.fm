import { AppShell } from '@/app/components/AppShell';

// A shared layout, so the Spotify player survives navigation instead of being torn down and
// stopping playback.
export default function ListeningLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
