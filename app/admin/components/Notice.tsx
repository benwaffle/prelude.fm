interface NoticeProps {
  children: React.ReactNode;
  intent?: 'info' | 'success' | 'error' | 'warning';
  variant?: 'info' | 'success' | 'error' | 'warning';
  className?: string;
}

const intentStyles: Record<NonNullable<NoticeProps['intent']>, string> = {
  info: 'bg-blue-50 text-blue-700 border-blue-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  error: 'bg-red-50 text-red-700 border-red-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
};

const joinClasses = (...classes: Array<string | undefined>) => classes.filter(Boolean).join(' ');

export function Notice({ children, intent, variant, className }: NoticeProps) {
  const resolvedIntent = intent ?? variant ?? 'info';
  return (
    <div
      className={joinClasses(
        'rounded-lg border px-4 py-3 text-sm',
        intentStyles[resolvedIntent],
        className,
      )}
    >
      {children}
    </div>
  );
}
