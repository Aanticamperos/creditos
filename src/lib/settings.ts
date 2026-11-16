import type { SupabaseClient } from '@supabase/supabase-js';
import type { PenaltyPolicy } from './financial';

export interface BusinessProfileSettings {
  company_name: string;
  nit: string;
  phone: string;
  city: string;
  receipt_footer: string;
}

export interface RegulatoryPolicySettings {
  configured: boolean;
  max_ea_rate: number;
  max_monthly_rate: number;
  official_source: string;
  effective_from: string;
  enforce_limit: boolean;
  notes: string;
}

export interface AppSettingsBundle {
  business_profile: BusinessProfileSettings;
  regulatory_policy: RegulatoryPolicySettings;
  penalty_policy: PenaltyPolicy;
}

export const DEFAULT_SETTINGS: AppSettingsBundle = {
  business_profile: {
    company_name: 'Nexo Crédito',
    nit: '',
    phone: '',
    city: 'Colombia',
    receipt_footer: 'Gracias por su pago puntual. Conserve este comprobante.',
  },
  regulatory_policy: {
    configured: false,
    max_ea_rate: 0,
    max_monthly_rate: 0,
    official_source: '',
    effective_from: '',
    enforce_limit: false,
    notes: 'Tasa definida libremente por el prestamista en cada operación.',
  },
  penalty_policy: {
    enabled: true,
    days_per_period: 4,
    penalty_mode: 'installment_value',
    percent_of_installment: 100,
    freeze_on_partial: true,
    apply_to_frequencies: ['daily'],
  },
};

export async function loadAppSettings(client: SupabaseClient): Promise<AppSettingsBundle> {
  const { data } = await client.from('app_settings').select('key, value');
  const map = new Map<string, Record<string, unknown>>();
  for (const row of data ?? []) {
    if (row.key && row.value && typeof row.value === 'object') {
      map.set(row.key, row.value as Record<string, unknown>);
    }
  }

  return {
    business_profile: {
      ...DEFAULT_SETTINGS.business_profile,
      ...(map.get('business_profile') ?? {}),
    },
    regulatory_policy: {
      ...DEFAULT_SETTINGS.regulatory_policy,
      ...(map.get('regulatory_policy') ?? {}),
    },
    penalty_policy: {
      ...DEFAULT_SETTINGS.penalty_policy,
      ...(map.get('penalty_policy') ?? {}),
    },
  };
}
