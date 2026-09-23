'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  clearChannelControl,
  getGatewayStatus,
  setChannelPaused,
  type GatewayView,
} from '../actions/gateway';
import { useAdminFailure } from './AdminFailure';

/**
 * The MusicBrainz request budget, and the switch that stops it.
 *
 * This sits in the header rather than on a tab because it answers a question
 * that applies to every page — is the gateway running, and how much of today's
 * budget is left — and because a stop button you have to navigate to is a
 * worse stop button.
 */
export function GatewayBar() {
  const { clearFailure, showFailure } = useAdminFailure();
  const [status, setStatus] = useState<GatewayView | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    getGatewayStatus().then(setStatus).catch(showFailure);
  }, [showFailure]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!status) return null;

  const stopped = status.channels.every((channel) => channel.paused);
  const queued = status.channels.reduce((sum, channel) => sum + channel.queued, 0);

  async function toggleAll() {
    clearFailure();
    setBusy(true);
    try {
      setStatus(
        stopped
          ? await clearChannelControl('all')
          : await setChannelPaused('all', true, 'Stopped from admin'),
      );
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function toggleChannel(channel: string, paused: boolean) {
    clearFailure();
    setBusy(true);
    try {
      setStatus(
        paused
          ? await setChannelPaused(channel, true, 'Stopped from admin')
          : await clearChannelControl(channel),
      );
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ml-auto flex items-center gap-3 text-[11px]">
      <button
        className="mono flex items-center gap-2 text-[var(--ink-2)] hover:text-[var(--gall)]"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span
          aria-hidden
          className="inline-block h-[7px] w-[7px] rounded-full"
          style={{ background: stopped ? 'var(--gall)' : 'var(--viridian)' }}
        />
        MB {status.total}/{status.globalCap}
        {queued > 0 && <span className="text-[var(--faint)]">· {queued} queued</span>}
      </button>

      <button className="act" onClick={toggleAll} disabled={busy}>
        {stopped ? 'Resume' : 'Stop'}
      </button>

      {open && (
        <div className="slip absolute right-5 top-[46px] z-20 w-[320px] px-4 py-3">
          <p className="eyebrow mb-2">MusicBrainz requests today ({status.day})</p>
          {!status.persisted && (
            <p className="mb-2 text-[var(--gall)]">Not persisted — caps are per process only.</p>
          )}
          <table>
            <tbody>
              {status.channels.map((channel) => (
                <tr key={channel.channel}>
                  <td className="w-full">
                    {channel.channel}
                    {channel.note && (
                      <span className="block text-[var(--faint)]">{channel.note}</span>
                    )}
                  </td>
                  <td className="mono whitespace-nowrap text-right text-[var(--ink-2)]">
                    {channel.used}/{channel.cap}
                  </td>
                  <td className="text-right">
                    <button
                      className="act"
                      disabled={busy}
                      onClick={() => toggleChannel(channel.channel, !channel.paused)}
                    >
                      {channel.paused ? 'Resume' : 'Stop'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {status.history.length > 1 && (
            <p className="mono mt-3 text-[var(--faint)]">
              {status.history
                .slice(-7)
                .map((day) => `${day.day.slice(5)} ${day.requests}`)
                .join('  ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
