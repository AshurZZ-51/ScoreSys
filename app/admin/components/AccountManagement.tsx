'use client';

import { FormEvent, useEffect, useState } from 'react';

type Account = { code: string; name: string; role: string; is_admin: boolean };

const emptyForm = { code: '', name: '', role: '', password: '', is_admin: false };

export default function AccountManagement() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const response = await fetch('/api/accounts', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) { setNotice(data.error || '读取账号失败'); return; }
    setAccounts(data.accounts || []);
  };

  useEffect(() => { load(); }, []);

  const createAccount = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const response = await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    const data = await response.json();
    setBusy(false);
    setNotice(response.ok ? '账号已创建。' : data.error || '创建账号失败');
    if (response.ok) { setForm(emptyForm); await load(); }
  };

  const resetPassword = async (code: string) => {
    const password = passwords[code] || '';
    setBusy(true);
    const response = await fetch(`/api/accounts/${encodeURIComponent(code)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset_password', password }) });
    const data = await response.json();
    setBusy(false);
    setNotice(response.ok ? `已重置 ${code} 的密码。` : data.error || '重置密码失败');
    if (response.ok) setPasswords((current) => ({ ...current, [code]: '' }));
  };

  const setAdmin = async (account: Account) => {
    setBusy(true);
    const response = await fetch(`/api/accounts/${encodeURIComponent(account.code)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set_admin', is_admin: !account.is_admin }) });
    const data = await response.json();
    setBusy(false);
    setNotice(response.ok ? `已更新 ${account.code} 的管理员权限。` : data.error || '更新管理员权限失败');
    if (response.ok) await load();
  };

  return <section>
    <div style={styles.heading}><h2 style={styles.h2}>账号管理</h2><button type="button" style={styles.secondary} onClick={load} disabled={busy}>刷新</button></div>
    {notice && <p style={styles.notice}>{notice}</p>}
    <form style={styles.form} onSubmit={createAccount}>
      <h3 style={styles.h3}>新增账号</h3>
      <input style={styles.input} required placeholder="账号" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
      <input style={styles.input} placeholder="姓名" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      <input style={styles.input} placeholder="角色" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} />
      <input style={styles.input} required type="password" placeholder="初始密码" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
      <label style={styles.checkbox}><input type="checkbox" checked={form.is_admin} onChange={(event) => setForm({ ...form, is_admin: event.target.checked })} /> 设为管理员</label>
      <button style={styles.primary} disabled={busy}>创建账号</button>
    </form>
    <div style={styles.tableWrap}><table style={styles.table}><thead><tr><th style={styles.cell}>账号</th><th style={styles.cell}>姓名</th><th style={styles.cell}>角色</th><th style={styles.cell}>管理员</th><th style={styles.cell}>密码重置</th><th style={styles.cell}>权限</th></tr></thead><tbody>
      {accounts.map((account) => { const protectedAccount = account.code.trim().toLowerCase() === 'admin51'; return <tr key={account.code}>
        <td style={styles.cell}>{account.code}</td><td style={styles.cell}>{account.name || '-'}</td><td style={styles.cell}>{account.role || '-'}</td><td style={styles.cell}>{account.is_admin ? '是' : '否'}</td>
        <td style={styles.cell}><div style={styles.inline}><input style={styles.password} type="password" placeholder="新密码" value={passwords[account.code] || ''} onChange={(event) => setPasswords((current) => ({ ...current, [account.code]: event.target.value }))} /><button type="button" style={styles.secondary} disabled={busy || !(passwords[account.code] || '')} onClick={() => resetPassword(account.code)}>重置</button></div></td>
        <td style={styles.cell}>{protectedAccount ? 'admin51 不可降级或删除' : <button type="button" style={account.is_admin ? styles.danger : styles.secondary} disabled={busy} onClick={() => setAdmin(account)}>{account.is_admin ? '取消管理员' : '设为管理员'}</button>}</td>
      </tr>; })}
      {!accounts.length && <tr><td style={styles.empty} colSpan={6}>暂无账号</td></tr>}
    </tbody></table></div>
  </section>;
}

const styles: Record<string, React.CSSProperties> = {
  heading: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '20px 0 14px' },
  h2: { margin: 0, fontSize: 18 }, h3: { margin: 0, fontSize: 15 },
  form: { display: 'grid', gap: 10, padding: 16, marginBottom: 16, border: '1px solid #d9e1ec', borderRadius: 6, background: '#fbfdff' },
  input: { width: '100%', padding: '9px 10px', border: '1px solid #cbd5e1', borderRadius: 5, boxSizing: 'border-box', fontSize: 14 },
  password: { minWidth: 120, flex: 1, padding: '7px 8px', border: '1px solid #cbd5e1', borderRadius: 5, boxSizing: 'border-box' },
  checkbox: { display: 'flex', gap: 7, alignItems: 'center', color: '#334155', fontSize: 14 },
  primary: { width: 'fit-content', background: '#0f766e', color: '#fff', border: '1px solid #0f766e', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' },
  secondary: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', padding: '7px 10px', borderRadius: 5, cursor: 'pointer' },
  danger: { background: '#fff', color: '#b42318', border: '1px solid #f3b1ab', padding: '7px 10px', borderRadius: 5, cursor: 'pointer' },
  notice: { padding: '10px 12px', background: '#ecfeff', color: '#155e75', border: '1px solid #a5f3fc', borderRadius: 6 },
  tableWrap: { overflowX: 'auto', border: '1px solid #d9e1ec', borderRadius: 6 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  cell: { padding: '11px 12px', textAlign: 'left', borderBottom: '1px solid #e7edf5', verticalAlign: 'middle' }, empty: { padding: 20, color: '#8591a5', textAlign: 'center' }, inline: { display: 'flex', gap: 7, alignItems: 'center' }
};
