-- Add external borrower metadata without changing existing loans.
alter table public.loans add column if not exists external_organization text;
alter table public.loans add column if not exists external_borrower_name text;

comment on column public.loans.external_organization is
  'Organization entered when the shared external borrower account creates a loan.';
comment on column public.loans.external_borrower_name is
  'Actual borrower name entered for an external organization loan.';
