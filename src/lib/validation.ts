import { z } from 'zod';

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const customerCreateSchema = z.object({
  document_type: z.enum(['CC', 'CE', 'NIT', 'Pasaporte']),
  document_number: z.string().trim().min(3, 'El número de documento es obligatorio').max(30),
  first_names: z.string().trim().min(2, 'Los nombres son obligatorios').max(120),
  last_names: z.string().trim().min(2, 'Los apellidos son obligatorios').max(120),
  phone: z.string().trim().min(7, 'El teléfono es obligatorio').max(30),
  email: z
    .string()
    .trim()
    .email('Correo electrónico inválido')
    .or(z.literal(''))
    .optional()
    .nullable(),
  address: z.string().trim().max(240).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const customerUpdateSchema = customerCreateSchema.partial().extend({
  archived: z.boolean().optional(),
});

export const loanCreateSchema = z
  .object({
    customer_id: z.string().uuid('Cliente inválido'),
    capital: z.number().int('El capital debe ser entero en COP').positive('El capital debe ser mayor a 0'),
    interest_rate: z.number().min(0, 'El interés no puede ser negativo').max(1000, 'Interés fuera de rango'),
    frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
    billing_mode: z.enum(['fixed_installments', 'monthly_interest_only']).default('fixed_installments'),
    installments_count: z.number().int().min(1, 'Mínimo 1 cuota').max(365, 'Máximo 365 cuotas'),
    disbursement_date: z.string().regex(isoDateRegex, 'Fecha de desembolso inválida'),
    first_payment_date: z.string().regex(isoDateRegex, 'Fecha de primera cuota inválida'),
    notes: z.string().trim().max(1000).optional().nullable(),
    initial_status: z.enum(['active', 'draft']).default('active'),
  })
  .refine((v) => v.first_payment_date >= v.disbursement_date, {
    message: 'La primera cuota no puede ser anterior a la fecha de desembolso',
    path: ['first_payment_date'],
  });

export const loanPatchSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('change_status'),
    status: z.enum(['active', 'blocked', 'finished', 'archived']),
    reason: z.string().trim().max(400).optional().nullable(),
  }),
  z.object({
    action: z.literal('toggle_penalty_freeze'),
    installment_id: z.string().uuid('Cuota inválida'),
    penalty_frozen: z.boolean(),
    reason: z.string().trim().max(400).optional().nullable(),
  }),
  z.object({
    action: z.literal('update_notes'),
    notes: z.string().trim().max(1000).nullable(),
  }),
  z.object({
    action: z.literal('add_capital'),
    amount: z.number().int().positive('El capital adicional debe ser positivo'),
    reason: z.string().trim().min(3, 'Indica el motivo o detalle del nuevo capital').max(400),
  }),
  z.object({
    action: z.literal('capitalize_interest'),
    installment_id: z.string().uuid('Cuota inválida'),
    reason: z.string().trim().max(400).optional().nullable(),
  }),
]);

export const paymentCreateSchema = z
  .object({
    customer_id: z.string().uuid('Cliente inválido'),
    method: z.enum(['cash', 'transfer']),
    transfer_reference: z.string().trim().max(120).optional().nullable(),
    notes: z.string().trim().max(500).optional().nullable(),
    idempotency_key: z.string().uuid('Llave de idempotencia inválida').optional(),
    installment_allocations: z
      .array(
        z.object({
          installment_id: z.string().uuid(),
          amount: z.number().int().positive('Cada abono debe ser positivo'),
        }),
      )
      .default([]),
    penalty_allocations: z
      .array(
        z.object({
          penalty_id: z.string().uuid(),
          amount: z.number().int().positive('Cada pago de mora debe ser positivo'),
        }),
      )
      .default([]),
    capital_payments: z
      .array(
        z.object({
          loan_id: z.string().uuid(),
          amount: z.number().int().positive('Cada abono a capital debe ser positivo'),
        }),
      )
      .default([]),
  })
  .refine(
    (v) =>
      v.installment_allocations.length + v.penalty_allocations.length + v.capital_payments.length >
      0,
    {
      message: 'Debes asignar al menos una cuota, mora o abono a capital',
    },
  )
  .refine((v) => v.method !== 'transfer' || Boolean(v.transfer_reference?.trim()), {
    message: 'La referencia es obligatoria para transferencias',
    path: ['transfer_reference'],
  });

export const paymentReverseSchema = z.object({
  reason: z.string().trim().min(5, 'Indica el motivo de reversión (mínimo 5 caracteres)').max(500),
});

export const adjustmentCreateSchema = z.object({
  loan_id: z.string().uuid('Préstamo inválido'),
  adjustment_type: z.enum(['installment_discount', 'penalty_waiver', 'note_adjustment']),
  installment_id: z.string().uuid().optional().nullable(),
  penalty_id: z.string().uuid().optional().nullable(),
  amount: z.number().int().min(0),
  reason: z.string().trim().min(5, 'El motivo es obligatorio (mínimo 5 caracteres)').max(500),
});

export const holidayCreateSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('single'),
    holiday_date: z.string().regex(isoDateRegex, 'Fecha inválida'),
    description: z.string().trim().min(2, 'Descripción requerida').max(150),
  }),
  z.object({
    mode: z.literal('colombia_year'),
    year: z.number().int().min(2024).max(2035),
  }),
]);

export const settingsUpdateSchema = z.object({
  business_profile: z
    .object({
      company_name: z.string().trim().min(2).max(120),
      nit: z.string().trim().max(40),
      phone: z.string().trim().max(40),
      city: z.string().trim().max(80),
      receipt_footer: z.string().trim().max(300),
    })
    .optional(),
  regulatory_policy: z
    .object({
      configured: z.boolean(),
      max_ea_rate: z.number().min(0).max(500),
      max_monthly_rate: z.number().min(0).max(100),
      official_source: z.string().trim().max(180),
      effective_from: z.string().trim().max(20),
      enforce_limit: z.boolean(),
      notes: z.string().trim().max(500),
    })
    .optional(),
  penalty_policy: z
    .object({
      enabled: z.boolean(),
      days_per_period: z.number().int().min(1).max(60),
      penalty_mode: z.enum(['installment_value', 'fixed_percent']),
      percent_of_installment: z.number().min(1).max(200),
      freeze_on_partial: z.boolean(),
      apply_to_frequencies: z.array(z.enum(['daily', 'weekly', 'biweekly', 'monthly'])).min(1),
    })
    .optional(),
});

export const teamCreateSchema = z.object({
  email: z.string().trim().email('Correo inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(100),
  full_name: z.string().trim().min(2, 'Nombre completo requerido').max(120),
  role: z.enum(['admin', 'employee']),
});

export const teamPatchSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['admin', 'employee']).optional(),
  active: z.boolean().optional(),
  full_name: z.string().trim().min(2).max(120).optional(),
});

export function firstZodError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Datos inválidos';
}
