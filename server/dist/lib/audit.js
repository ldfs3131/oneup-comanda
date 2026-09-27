import { sql } from 'drizzle-orm';
import { auditLogs } from '../db/schema.js';
export async function audit(tx, e) {
    await tx.insert(auditLogs).values({
        userId: e.userId ?? null,
        // perfil do usuário no momento da ação
        userRole: e.userId ? sql `(SELECT r.code::text FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ${e.userId})` : null,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        message: e.message,
        data: e.data,
    });
}
