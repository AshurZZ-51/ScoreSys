import type { Executor } from '../client';
import { one, query } from '../client';
import type { MeetingRow } from '../types';

export function batchUpdateMeetings(
  meetingIds: string[],
  action: 'recycle' | 'restore',
  executor?: Executor,
): Promise<{ id: string }[]> {
  if (action === 'recycle') {
    return query<{ id: string }>(
      `UPDATE meetings
          SET deleted_at = $1, scheduled_purge_at = $2, status = $3, is_current = $4
        WHERE id = ANY($5::uuid[])
        RETURNING id`,
      [new Date().toISOString(), null, 'archived', false, meetingIds],
      executor,
    );
  }

  return query<{ id: string }>(
    `UPDATE meetings
        SET deleted_at = $1, scheduled_purge_at = $2, status = $3
      WHERE id = ANY($4::uuid[])
      RETURNING id`,
    [null, null, 'active', meetingIds],
    executor,
  );
}

export function updateMeeting(
  meetingId: string,
  action: 'soft_delete' | 'restore',
  executor?: Executor,
): Promise<MeetingRow> {
  if (action === 'soft_delete') {
    return one<MeetingRow>(
      `UPDATE meetings
          SET deleted_at = $1, scheduled_purge_at = $2, status = $3, is_current = $4
        WHERE id = $5
        RETURNING *`,
      [new Date().toISOString(), null, 'archived', false, meetingId],
      executor,
    );
  }

  return one<MeetingRow>(
    `UPDATE meetings
        SET deleted_at = $1, scheduled_purge_at = $2, status = $3
      WHERE id = $4
      RETURNING *`,
    [null, null, 'active', meetingId],
    executor,
  );
}

export const batchMutateMeetings = batchUpdateMeetings;
export const mutateMeeting = updateMeeting;
