"use client";

import { authClient } from "@/lib/auth-client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { getAdminStats } from "./actions";
import { TracksTab } from "./tabs/TracksTab";
import { ComposersTab } from "./tabs/ComposersTab";
import { WorksTab } from "./tabs/WorksTab";

type TabType = "tracks" | "composers" | "works";

function Spinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export default function AdminPage() {
  const { data: session } = authClient.useSession();
  const [activeTab, setActiveTab] = useState<TabType>("tracks");
  const [stats, setStats] = useState<{
    pendingTracks: number;
    unlinkedArtists: number;
    totalWorks: number;
  } | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);

  const isAdmin = session?.user?.name === "benwaffle";

  useEffect(() => {
    if (!isAdmin) return;
    loadStats();
  }, [isAdmin]);

  const loadStats = async () => {
    setLoadingStats(true);
    try {
      const result = await getAdminStats();
      setStats(result);
    } catch (err) {
      console.error("Failed to load stats:", err);
    } finally {
      setLoadingStats(false);
    }
  };

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Please sign in to access this page
        </p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Access denied
        </p>
      </div>
    );
  }

  const tabs: { id: TabType; label: string; count?: number }[] = [
    { id: "tracks", label: "Tracks" },
    { id: "composers", label: "Composers", count: stats?.unlinkedArtists },
    { id: "works", label: "Works", count: stats?.totalWorks },
  ];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black p-8">
      <main className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-4xl font-bold text-black dark:text-zinc-50">
            admin
          </h1>
          <Link
            href="/"
            className="text-sm text-zinc-600 dark:text-zinc-400 hover:text-black dark:hover:text-white"
          >
            &larr; Back to Player
          </Link>
        </div>

        {/* Tab Navigation */}
        <div className="border-b border-zinc-200 dark:border-zinc-700 mb-6">
          <nav className="flex gap-1" aria-label="Tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
                    : "border-transparent text-zinc-600 dark:text-zinc-400 hover:text-black dark:hover:text-white hover:border-zinc-300 dark:hover:border-zinc-600"
                }`}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span
                    className={`ml-2 px-2 py-0.5 text-xs rounded-full ${
                      activeTab === tab.id
                        ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                        : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                    }`}
                  >
                    {loadingStats ? <Spinner className="w-3 h-3 inline" /> : tab.count}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab Content */}
        <div>
          {activeTab === "tracks" && (
            <TracksTab onSwitchTab={(tab) => setActiveTab(tab)} />
          )}
          {activeTab === "composers" && <ComposersTab />}
          {activeTab === "works" && <WorksTab />}
        </div>
      </main>
    </div>
  );
}
