import { auditLogs } from '../db/schema.js';
export async function audit(tx, e) {
    await tx.insert(auditLogs).values({
        userId: e.userId ?? null,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        message: e.message,
        data: e.data,
    });
}
