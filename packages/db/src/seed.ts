import { randomBytes, scryptSync } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { normalizeCoMobile } from '@wp/shared'
import { closeClient, getDb } from './client.js'
import { users } from './schema.js'

// Mismo formato que usará el auth de la fase 1: scrypt salt:hash en hex.
function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
const phone = normalizeCoMobile(process.env.ADMIN_PHONE ?? '')
const password = process.env.ADMIN_PASSWORD

if (!email || !phone || !password) {
  throw new Error('El seed necesita ADMIN_EMAIL, ADMIN_PHONE (celular CO) y ADMIN_PASSWORD en .env')
}

const db = getDb()
try {
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) })

  if (existing) {
    await db
      .update(users)
      .set({
        phone,
        passwordHash: hashPassword(password),
        role: 'admin',
        status: 'approved',
        emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
        phoneVerifiedAt: existing.phoneVerifiedAt ?? new Date(),
      })
      .where(eq(users.id, existing.id))
    console.log(`Superadmin actualizado: ${email}`)
  } else {
    await db.insert(users).values({
      email,
      phone,
      passwordHash: hashPassword(password),
      role: 'admin',
      status: 'approved',
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
      approvedAt: new Date(),
    })
    console.log(`Superadmin creado: ${email}`)
  }
} finally {
  await closeClient()
}
