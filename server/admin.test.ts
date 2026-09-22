import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, resolvePasswordHash, ensureDefaultAdmin } from './admin.js'

test('default admin password resolves to the configured bcrypt hash', () => {
  const hash = resolvePasswordHash(process.env.ADMIN_PASSWORD_HASH)
  assert.ok(hash.startsWith('$2'))
  assert.ok(hash.length > 20)
})

test('ensureDefaultAdmin inserts missing admin row with default password', async () => {
  let inserted: Record<string, unknown> | null = null
  const fakeSupabase = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === 'admins') {
              return { data: null, error: null }
            }
            return { data: null, error: null }
          },
        }),
      }),
      insert: async (row: Record<string, unknown>) => {
        inserted = row
        return { error: null }
      },
    }),
  }

  await ensureDefaultAdmin(fakeSupabase as any, {
    username: DEFAULT_ADMIN_USERNAME,
    password: DEFAULT_ADMIN_PASSWORD,
  })

  assert.ok(inserted)
  assert.equal(inserted?.username, DEFAULT_ADMIN_USERNAME)
  assert.ok(String(inserted?.password_hash).startsWith('$2'))
})
