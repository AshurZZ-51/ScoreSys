'use client';

type Meeting = { id: string; name: string; meeting_date?: string; is_current?: boolean };

export default function ReportSelector({ meetings, selectedId, onSelect, onOpen }: {
  meetings: Meeting[]; selectedId?: string; onSelect: (meeting: Meeting) => void; onOpen: (meeting: Meeting) => void;
}) {
  const selected = meetings.find((meeting) => meeting.id === selectedId);
  return <section style={styles.section}>
    <label style={styles.label}>选择评审会
      <select aria-label="选择评审会报告" value={selectedId || ''} onChange={(event) => {
        const meeting = meetings.find((item) => item.id === event.target.value);
        if (meeting) onSelect(meeting);
      }} style={styles.select}>
        <option value="">请选择评审会</option>
        {meetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.is_current ? '当前 · ' : ''}{meeting.name} · {meeting.meeting_date || '未设置日期'}</option>)}
      </select>
    </label>
    {selected && <button type="button" style={styles.primary} onClick={() => onOpen(selected)}>打开可打印报告</button>}
  </section>;
}

const styles: Record<string, React.CSSProperties> = {
  section: { display: 'flex', alignItems: 'end', gap: 12, flexWrap: 'wrap', padding: '12px 0 18px' },
  label: { display: 'grid', gap: 6, color: '#334155', fontWeight: 700, fontSize: 14 },
  select: { minWidth: 300, padding: '9px 10px', border: '1px solid #cbd5e1', borderRadius: 5, background: '#fff', color: '#0f172a' },
  primary: { padding: '9px 12px', border: '1px solid #0f766e', borderRadius: 5, background: '#0f766e', color: '#fff', cursor: 'pointer' }
};
