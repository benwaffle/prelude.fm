interface NoticeProps {
  children: React.ReactNode;
  intent?: 'info' | 'success' | 'error' | 'warning';
  variant?: 'info' | 'success' | 'error' | 'warning';
  className?: string;
}

const intentStyles: Record<NonNullable<NoticeProps['intent']>, string> = {
  info: 'bg-blue-50 text-[var(--gall)] border-blue-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  error: 'bg-red-50 text-red-700 border-red-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
};

const joinClasses = (...classes: Array<string | undefined>) => classes.filter(Boolean).join(' ');

/** The notice box's classes, for an element that draws its own (a load failure). */
export function noticeClassName(
  intent: NonNullable<NoticeProps['intent']>,
  className?: string,
): string {
  return joinClasses('border px-4 py-3 text-sm', intentStyles[intent], className);
}

export function Notice({ children, intent, variant, className }: NoticeProps) {
  return <div className={noticeClassName(intent ?? variant ?? 'info', className)}>{children}</div>;
}
