'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@iconify-icon/react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isScrolled, setIsScrolled] = useState(false);
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    setMounted(true);
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
    }
  }, [router]);

  useEffect(() => {
    let ticking = false;
    
    const handleScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          const scrollY = window.scrollY;
          setIsScrolled(prev => {
            if (!prev && scrollY > 40) return true;
            if (prev && scrollY < 20) return false;
            return prev;
          });
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    router.push('/login');
  };

  if (!mounted) {
    return null;
  }

  return (
    <>
      {/* Header */}
      <header className={`sticky top-0 z-50 transition-all duration-300 ${
        isScrolled 
          ? 'bg-[#f5f5f5] py-2 px-4'
          : 'bg-[#f5f5f5] py-0 px-0'
      }`}>
        <div className={`rounded-2xl transition-all duration-300 ${
          isScrolled ? 'bg-white mx-0 px-4 py-2' : 'bg-[#f5f5f5] mx-4 lg:mx-8 px-6 py-4'
        }`}>
          <div className="flex items-center justify-between">
            <Link href="/dashboard" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <Icon icon="pixelarticons:zap" style={{ color: '#de610d' }} width={isScrolled ? 24 : 32} />
              <div className="flex items-center gap-3">
                <h1 className={`font-bold text-black transition-all duration-300 ${
                  isScrolled ? 'text-xl' : 'text-2xl lg:text-3xl'
                }`}>
                  ANUBIS
                </h1>
                <span className={`hidden lg:inline text-black/50 transition-all duration-300 ${
                  isScrolled ? 'text-sm' : 'text-base'
                }`}>
                  проводник в мир AI
                </span>
              </div>
            </Link>
            <nav className="flex items-center gap-4">
              <Link href="/dashboard" 
                 className={`flex items-center gap-2 transition-colors ${
                   pathname === '/dashboard' ? 'text-[#de610d]' : 'hover:text-[#de610d]'
                 }`}>
                <Icon icon="pixelarticons:home" width={isScrolled ? 20 : 24} />
                <span className="hidden sm:inline">Главная</span>
              </Link>
              <Link href="/dashboard/providers"
                 className={`flex items-center gap-2 transition-colors ${
                   pathname === '/dashboard/providers' ? 'text-[#de610d]' : 'hover:text-[#de610d]'
                 }`}>
                <Icon icon="pixelarticons:server" width={isScrolled ? 20 : 24} />
                <span className="hidden sm:inline">Провайдеры</span>
              </Link>
              <Link href="/dashboard/config"
                 className={`flex items-center gap-2 transition-colors ${
                   pathname === '/dashboard/config' ? 'text-[#de610d]' : 'hover:text-[#de610d]'
                 }`}>
                <Icon icon="pixelarticons:sliders" width={isScrolled ? 20 : 24} />
                <span className="hidden sm:inline">Настройки</span>
              </Link>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 hover:text-[#de610d] transition-colors">
                <Icon icon="pixelarticons:power" width={isScrolled ? 20 : 24} />
                <span className="hidden sm:inline">Выход</span>
              </button>
            </nav>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="bg-[#f5f5f5] min-h-screen overflow-x-hidden">
        {children}
      </div>
    </>
  );
}
