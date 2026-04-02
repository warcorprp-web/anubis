import { NextRequest, NextResponse } from 'next/server';
import { loadAdminPassword } from '@/lib/storage';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'anubis-secret-key';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { password } = body;

    const adminPassword = loadAdminPassword();

    if (password === adminPassword) {
      // Generate JWT token
      const token = jwt.sign(
        { authenticated: true },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      return NextResponse.json({
        success: true,
        token,
      });
    }

    return NextResponse.json(
      {
        error: {
          message: 'Неверный пароль',
          code: 'INVALID_PASSWORD',
        },
      },
      { status: 401 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          message: 'Ошибка входа',
          code: 'LOGIN_ERROR',
        },
      },
      { status: 500 }
    );
  }
}
