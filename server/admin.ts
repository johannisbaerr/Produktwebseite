import bcrypt from 'bcryptjs'

export const DEFAULT_ADMIN_USERNAME = 'admin'
export const DEFAULT_ADMIN_PASSWORD = 'qcwvsdq3'

export const resolvePasswordHash = (configuredHash?: string) => {
  const trimmed = configuredHash?.trim()
  if (trimmed) return trimmed
  return bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10)
}

type SupabaseLike = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (field: string, value: string) => {
        maybeSingle: () => Promise<{ data: { id: number; username: string; password_hash: string } | null; error: { message: string } | null }>
      }
    }
    insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>
  }
}

export const ensureDefaultAdmin = async (
  supabase: SupabaseLike,
  options: { username?: string; password?: string; passwordHash?: string } = {},
) => {
  const username = options.username ?? DEFAULT_ADMIN_USERNAME
  const passwordHash = resolvePasswordHash(options.passwordHash ?? process.env.ADMIN_PASSWORD_HASH)

  const { data: existing, error: lookupError } = await supabase
    .from('admins')
    .select('id,username,password_hash')
    .eq('username', username)
    .maybeSingle()

  if (lookupError) {
    throw new Error(`Admin lookup failed: ${lookupError.message}`)
  }

  if (existing) return existing

  const { error: insertError } = await supabase.from('admins').insert({
    username,
    password_hash: passwordHash,
  })

  if (insertError) {
    throw new Error(`Admin seed failed: ${insertError.message}`)
  }

  return { id: 0, username, password_hash: passwordHash }
}
