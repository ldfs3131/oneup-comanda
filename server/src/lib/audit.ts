import { sql } from 'drizzle-orm';
import { auditLogs } from '../db/schema.js';
import type { Executor } from '../db/index.js';

export async function audit(
  tx: Executor,
  e: { userId?: number | null; action: string; entityType?: string; entityId?: number; message: string; data?: unknown },
) {
  await tx.insert(auditLogs).values({
    userId: e.userId ?? null,
    // perfil do usuário no momento da ação
    userRole: e.userId ? sql`(SELECT r.code::text FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ${e.userId})` : null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    message: e.message,
    data: e.data as object | undefined,
  });
}
