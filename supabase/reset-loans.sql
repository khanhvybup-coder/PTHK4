-- DANGER: this removes only loan data and audit history.
-- Rooms, equipment and profiles are preserved.
-- Run manually in Supabase SQL Editor after taking a database backup.

begin;

update public.kths_app_state
set version = version + 1,
    document = document || jsonb_build_object(
      'version', version + 1,
      'nextSequence', 1,
      'loanSequences', '{}'::jsonb,
      'loans', '[]'::jsonb,
      'events', '[]'::jsonb,
      'updatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    updated_at = now()
where id = 'main';

delete from public.loan_events;
delete from public.loan_items;
delete from public.loans;
delete from public.loan_sequences;

commit;

-- The next call for 2026 creates PM-2026-01.
