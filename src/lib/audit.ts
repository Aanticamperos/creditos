import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuditInput {
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  old_data?: Record<string, unknown> | null;
  new_data?: Record<string, unknown> | null;
  reason?: string | null;
}

export async function writeAuditLog(adminClient: SupabaseClient, entry: AuditInput) {
  const { error } = await adminClient.from('audit_logs').insert({
    actor_id: entry.actor_id,
    action: entry.action,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id ?? null,
    old_data: entry.old_data ?? null,
    new_data: entry.new_data ?? null,
    reason: entry.reason ?? null,
  });
  if (error) {
    console.error('Error writing audit log:', error.message);
  }
}
