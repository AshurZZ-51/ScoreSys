'use client';

import { useMemo, useState } from 'react';
import { sortMeetingsForAdmin } from '@/lib/adminLifecycle';

type Meeting = Record<string, any>;

export default function MeetingList({ meetings, assignmentCounts = {}, onOpen, onCreate, onSetCurrent, onRecycle, onOpenRecycleBin }: {
  meetings: Meeting[]; assignmentCounts?: Record<string, number>; onOpen: (meeting: Meeting) => void; onCreate: () => void;
  onSetCurrent: (meeting: Meeting) => void; onRecycle: (ids: string[]) => void; onOpenRecycleBin: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const ordered = useMemo(() => sortMeetingsForAdmin(meetings), [meetings]);
  const toggle = (id: string) => setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  const recycle = () => selected.length && window.confirm(`将选中的 ${selected.length} 场评审会移入回收站？`) && onRecycle(selected);
  return <section style={styles.section}>
    <div style={styles.toolbar}><h2 style={styles.h2}>评审会列表</h2><div style={styles.actions}><button style={styles.secondary} onClick={onOpenRecycleBin}>回收站</button><button style={styles.primary} onClick={onCreate}>新建评审会</button></div></div>
    {selected.length > 0 && <div style={styles.bulk}><span>已选 {selected.length} 场</span><button style={styles.danger} onClick={recycle}>移入回收站</button></div>}
    <div style={styles.tableWrap}><table style={styles.table}><thead><tr><th style={styles.cell}><input aria-label="全选评审会" type="checkbox" checked={ordered.length > 0 && selected.length === ordered.length} onChange={() => setSelected(selected.length === ordered.length ? [] : ordered.map((meeting) => meeting.id))}/></th><th style={styles.cell}>评审会</th><th style={styles.cell}>日期</th><th style={styles.cell}>截止时间</th><th style={styles.cell}>项目</th><th style={styles.cell}>操作</th></tr></thead><tbody>
      {ordered.map((meeting) => <tr key={meeting.id} style={meeting.is_current ? styles.currentRow : undefined}><td style={styles.cell}><input aria-label={`选择${meeting.name}`} type="checkbox" checked={selected.includes(meeting.id)} onChange={() => toggle(meeting.id)}/></td><td style={styles.cell}>{meeting.is_current && <span style={styles.badge}>当前</span>}<strong>{meeting.name}</strong></td><td style={styles.cell}>{meeting.meeting_date || '-'}</td><td style={styles.cell}>{meeting.deadline ? String(meeting.deadline).replace('T', ' ').slice(0, 16) : '-'}</td><td style={styles.cell}>{assignmentCounts[meeting.id] || 0}/12</td><td style={styles.cell}><div style={styles.actions}><button style={styles.secondary} onClick={() => onOpen(meeting)}>进入</button><button style={styles.secondary} disabled={meeting.is_current} onClick={() => onSetCurrent(meeting)}>设为当前</button><button style={styles.danger} onClick={() => onRecycle([meeting.id])}>回收</button></div></td></tr>)}
      {!ordered.length && <tr><td style={styles.empty} colSpan={6}>暂无评审会</td></tr>}
    </tbody></table></div>
  </section>;
}

const styles: Record<string, React.CSSProperties> = { section: { marginTop: 20 }, h2: { margin: 0, fontSize: 18 }, toolbar: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14 }, actions: { display: 'flex', flexWrap: 'wrap', gap: 7 }, bulk: { display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0' }, primary: { background: '#0f766e', color: '#fff', border: '1px solid #0f766e', borderRadius: 5, padding: '8px 12px', cursor: 'pointer' }, secondary: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 5, padding: '8px 12px', cursor: 'pointer' }, danger: { background: '#fff', color: '#b42318', border: '1px solid #f3b1ab', borderRadius: 5, padding: '8px 12px', cursor: 'pointer' }, tableWrap: { overflowX: 'auto', border: '1px solid #d9e1ec', borderRadius: 6 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 }, cell: { textAlign: 'left', verticalAlign: 'top', padding: '11px 12px', borderBottom: '1px solid #e7edf5' }, empty: { textAlign: 'center', padding: 22, color: '#64748b' }, badge: { display: 'inline-block', marginRight: 8, padding: '2px 6px', borderRadius: 4, background: '#0f766e', color: '#fff', fontSize: 12 }, currentRow: { background: '#f0fdfa' } };
