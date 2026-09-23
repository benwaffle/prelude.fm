'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export function adminFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type FailureContext = {
  clearFailure: () => void;
  showFailure: (error: unknown) => void;
  message: string | null;
};

const Context = createContext<FailureContext | null>(null);

export function AdminFailureProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);

  const clearFailure = useCallback(() => setMessage(null), []);
  const showFailure = useCallback((error: unknown) => setMessage(adminFailureMessage(error)), []);
  const value = useMemo(
    () => ({ clearFailure, showFailure, message }),
    [clearFailure, showFailure, message],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function AdminFailureNotice() {
  const { message, clearFailure } = useAdminFailure();
  if (message === null) return null;
  return (
    <div
      role="alert"
      className="mb-6 rounded border border-red-300 bg-red-50 px-4 py-3 text-red-800"
    >
      <div className="flex items-start gap-4">
        <span className="min-w-0 flex-1 whitespace-pre-wrap">{message}</span>
        <button
          type="button"
          className="underline"
          onClick={clearFailure}
          aria-label="Dismiss admin error"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function useAdminFailure(): FailureContext {
  const context = useContext(Context);
  if (!context) throw new Error('AdminFailureProvider is required');
  return context;
}
