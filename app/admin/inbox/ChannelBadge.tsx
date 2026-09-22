export type ContributionChannel = 'BOT' | 'TOOL' | 'HAND' | 'REPORT';

export function ChannelBadge({ channel }: { channel: ContributionChannel }) {
  return <span className="tag">{channel}</span>;
}
