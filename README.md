# Nexo Crédito

Sistema integral de administración de préstamos, cobranza y cartera en COP, construido con Next.js (App Router + proxy Auth) y Supabase/PostgreSQL.

## Módulos principales

- **Dashboard (`/`)**: KPIs en tiempo real (cartera pendiente, recaudo diario efectivo/transferencia, cuotas vencidas, evolución de ingresos 14 días, agenda de cobro prioritaria).
- **Cobranza y Cuotas (`/cuotas`)**: Bandeja operativa por estado (`Para hoy`, `Vencidas`, `Parciales`, `Próximas`, `Pagadas`), cobro rápido en 1 clic, recordatorios por WhatsApp y sincronización de moras (`late_penalties`).
- **Clientes (`/clientes`, `/clientes/[id]`)**: Directorio buscable, ficha 360° con historial de préstamos, pagos, cumplimiento y acceso directo a WhatsApp.
- **Préstamos (`/prestamos`, `/prestamos/[id]`)**: Cartera filtrable, simulador y creación atómica con calendario de días hábiles y festivos colombianos, snapshot regulatorio, activación/bloqueo, congelación de mora y ajustes financieros auditados.
- **Pagos (`/pagos`)**: Distribución automática en cascada o manual sobre cuotas y penalizaciones, comprobante imprimible y compartible por WhatsApp, historial y reversión administrativa auditada.
- **Reportes y Auditoría (`/reportes`)**: Rentabilidad, índice de morosidad, antigüedad de cartera, exportaciones CSV (UTF-8) y bitácora inmutable de auditoría.
- **Configuración (`/configuracion`)**: Identidad comercial para comprobantes, marco regulatorio opcional, política de mora, carga automática de festivos de Colombia (Ley Emiliani + Semana Santa) y gestión de equipo/roles.
- **Portal de Consulta Pública (`/consulta`)**: Apartado público sin inicio de sesión donde el cliente ingresa su número de documento para revisar su saldo pendiente, próxima cuota y plan de pagos (protegido contra enumeración por límite de tasa y sin exponer datos sensibles).

## Instalación

1. Cree un proyecto en Supabase y ejecute en el SQL Editor en orden:
   - `supabase/migrations/001_initial.sql`
   - `supabase/migrations/002_create_loan.sql`
   - `supabase/migrations/003_full_app_support.sql`
2. Copie `.env.example` a `.env.local` y asigne la URL raíz del proyecto (`https://<ref>.supabase.co`, sin `/rest/v1`), la clave pública y `SUPABASE_SERVICE_ROLE_KEY`. La llave de servicio jamás se expone al navegador.
3. Cree el primer usuario en **Authentication > Users** y ejecute el `insert` indicado en `supabase/seed.sql` con su UUID.
4. Ejecute `npm install` y `npm run dev`.

## Seguridad y operación

- Desactive el registro público en Supabase Auth; los nuevos operadores se crean desde **Configuración > Equipo** o vía administrador.
- Toda operación sensible pasa por Route Handlers verificados en servidor con validación `zod`, control de rol (`admin` / `employee`), idempotencia en pagos y trazabilidad en `audit_logs`.
- Los datos financieros no se eliminan: los pagos erróneos se reversan conservando historial (`reversed_at`), y las condonaciones quedan en `financial_adjustments`.
- Antes de operar en producción, configure la tasa oficial vigente y su fuente en **Configuración > Regulación y Mora**; el motor de referencia no sustituye asesoría jurídica.

## Despliegue en Vercel

Importe el repositorio, configure las tres variables de `.env.example` en Vercel y despliegue. Use backups programados de Supabase y pruebe restauraciones periódicamente.
