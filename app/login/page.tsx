'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@iconify-icon/react';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const togglePassword = () => {
    setShowPassword(prev => !prev);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await res.json();

      if (data.success) {
        localStorage.setItem('token', data.token);
        router.push('/dashboard');
      } else {
        setError('Неверный пароль');
      }
    } catch (err) {
      setError('Ошибка подключения');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold mb-2" style={{ color: '#de610d' }}>
            ANUBIS
          </h1>
          <p className="text-lg" style={{ color: '#6b7280' }}>
            Универсальный AI прокси
          </p>
        </div>

        {}
        <div className="bg-white rounded-lg p-8">
          <div className="flex items-center gap-3 mb-6">
            <Icon icon="pixelarticons:lock" width="24" height="24" style={{ color: '#de610d' }} />
            <h2 className="text-xl font-bold" style={{ color: '#374151' }}>
              Вход в систему
            </h2>
          </div>

          <form onSubmit={handleLogin}>
            {}
            <div className="mb-6">
              <label className="block mb-2 text-sm font-semibold" style={{ color: '#374151' }}>
                Пароль
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Введите пароль"
                  className="w-full px-4 py-3 pr-12 rounded-lg border-2 border-gray-200 focus:border-[#de610d] focus:outline-none text-base"
                  style={{ fontSize: '16px' }}
                  required
                />
                <div
                  onClick={togglePassword}
                  onMouseDown={(e) => e.preventDefault()}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 cursor-pointer hover:opacity-70 select-none"
                  style={{ zIndex: 999, userSelect: 'none' }}
                >
                  <Icon
                    icon={showPassword ? 'pixelarticons:eye-closed' : 'pixelarticons:eye'}
                    width="20"
                    height="20"
                    style={{ color: '#6b7280', pointerEvents: 'none' }}
                  />
                </div>
              </div>
              {error && (
                <div className="mt-2 flex items-center gap-2 text-sm" style={{ color: '#ef4444' }}>
                  <Icon icon="pixelarticons:close" width="16" height="16" />
                  <span>{error}</span>
                </div>
              )}
            </div>

            {}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-lg font-semibold text-white transition-colors disabled:opacity-50"
              style={{ backgroundColor: '#de610d' }}
              onMouseEnter={(e) => {
                if (!loading) e.currentTarget.style.backgroundColor = '#c55a0b';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#de610d';
              }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Icon icon="pixelarticons:sync" width="20" height="20" className="animate-spin" />
                  Вход...
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <Icon icon="pixelarticons:arrow-right" width="20" height="20" />
                  Войти
                </span>
              )}
            </button>
          </form>

          {}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <div className="flex items-start gap-2 text-sm" style={{ color: '#6b7280' }}>
              <Icon icon="pixelarticons:info" width="16" height="16" className="mt-0.5 flex-shrink-0" />
              <p>
                Пароль по умолчанию: <span className="font-semibold">123456</span>
                <br />
                Можно изменить в настройках после входа
              </p>
            </div>
          </div>
        </div>

        {}
        <div className="text-center mt-6 text-sm" style={{ color: '#6b7280' }}>
          <p className="flex items-center justify-center gap-2">
            Создано силами 
            <a href="https://trovu.tech/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:opacity-80 transition-opacity">
              <Icon icon="streamline-pixel:technology-robot-ai" width="20" style={{ color: '#de610d' }} />
              <span className="font-bold" style={{ color: '#de610d' }}>trovu</span><span className="font-bold">.tech</span>
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
