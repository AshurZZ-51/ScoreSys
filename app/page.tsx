'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), password })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || '登录失败');
        setLoading(false);
        return;
      }

      // 保存登录信息到localStorage
      localStorage.setItem('reviewer', JSON.stringify(data.reviewer));
      sessionStorage.setItem('scoresys_session_token', data.session_token);

      // 根据角色跳转
      if (data.reviewer.is_admin) {
        router.push('/admin');
      } else {
        router.push('/scoring');
      }
    } catch (err: any) {
      setError('网络错误: ' + err.message);
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #e0f2fe 0%, #f0f9ff 50%, #ecfeff 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    }}>
      <div style={{
        background: 'white',
        borderRadius: '20px',
        padding: '48px 40px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.08)',
        width: '400px',
        maxWidth: '90%'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            width: '64px',
            height: '64px',
            background: 'linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)',
            borderRadius: '16px',
            margin: '0 auto 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '32px',
            color: 'white'
          }}>★</div>
          <h1 style={{
            fontSize: '24px',
            fontWeight: '700',
            color: '#0f172a',
            margin: '0 0 8px'
          }}>立项评审在线打分系统</h1>
          <p style={{
            color: '#64748b',
            fontSize: '14px',
            margin: 0
          }}>请输入账号密码登录</p>
        </div>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{
              display: 'block',
              fontSize: '13px',
              fontWeight: '600',
              color: '#334155',
              marginBottom: '6px'
            }}>账号</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="如 W / N / S / J / G"
              required
              autoFocus
              style={{
                width: '100%',
                padding: '12px 14px',
                fontSize: '15px',
                border: '1.5px solid #e2e8f0',
                borderRadius: '10px',
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'border 0.2s'
              }}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#e2e8f0'}
            />
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={{
              display: 'block',
              fontSize: '13px',
              fontWeight: '600',
              color: '#334155',
              marginBottom: '6px'
            }}>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              required
              style={{
                width: '100%',
                padding: '12px 14px',
                fontSize: '15px',
                border: '1.5px solid #e2e8f0',
                borderRadius: '10px',
                outline: 'none',
                boxSizing: 'border-box'
              }}
              onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
              onBlur={(e) => e.target.style.borderColor = '#e2e8f0'}
            />
          </div>

          {error && (
            <div style={{
              background: '#fef2f2',
              color: '#dc2626',
              padding: '10px 14px',
              borderRadius: '8px',
              fontSize: '13px',
              marginBottom: '16px',
              border: '1px solid #fecaca'
            }}>
              ⚠ {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '13px',
              fontSize: '15px',
              fontWeight: '600',
              color: 'white',
              background: loading ? '#94a3b8' : 'linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)',
              border: 'none',
              borderRadius: '10px',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s'
            }}
          >
            {loading ? '登录中...' : '登录'}
          </button>
        </form>

        <div style={{
          marginTop: '24px',
          padding: '14px',
          background: '#f8fafc',
          borderRadius: '10px',
          fontSize: '12px',
          color: '#64748b',
          lineHeight: '1.6'
        }}>
          <div style={{ fontWeight: '600', marginBottom: '6px', color: '#475569' }}>💡 账号说明</div>
          评委首字母登录：W / N / S / J / G<br/>
          默认密码：<strong>首字母+123</strong>（如 W → W123）<br/>
          忘记密码请联系管理员
        </div>
      </div>
    </div>
  );
}
