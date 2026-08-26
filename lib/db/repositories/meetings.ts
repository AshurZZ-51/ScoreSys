import type { Executor } from '../client';
import { one, query } from '../client';

export interface MeetingSummary {
  id: string;
  name: string;
  meeting_date: string;
  deadline: string | null;
  status: string;
  notes: string | null;
}

export interface MeetingReviewerSnapshot {
  reviewer_code: string;
  reviewer_name: string;
  reviewer_role: string;
}

export function getMeetingSummary(meetingId: string, executor?: Executor): Promise<MeetingSummary> {
  return one<MeetingSummary>(
    `SELECT id, name, meeting_date, deadline, status, notes
       FROM meetings
      WHERE id = $1`,
    [meetingId],
    executor,
  );
}

export function listMeetingReviewers(
  meetingId: string,
  executor?: Executor,
): Promise<MeetingReviewerSnapshot[]> {
  return query<MeetingReviewerSnapshot>(
    `SELECT reviewer_code, reviewer_name, reviewer_role
       FROM meeting_reviewers
      WHERE meeting_id = $1`,
    [meetingId],
    executor,
  );
}
