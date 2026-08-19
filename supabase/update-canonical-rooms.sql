-- Updates only the shared room catalog in the existing online state.
-- Loans, workflow history, equipment, users and yearly loan counters are preserved.
-- Run once in Supabase SQL Editor after taking a backup.

begin;

update public.kths_app_state
set version = version + 1,
    document = document || jsonb_build_object(
      'version', version + 1,
      'rooms', jsonb_build_array(
        jsonb_build_object(
          'id', 'source-0',
          'name', 'Phòng 1 - CS155',
          'function', 'Trung tâm KTPCTP',
          'capacity', 10,
          'operationalStatus', 'Tốt',
          'custom', false,
          'createdAt', null,
          'updatedAt', null
        ),
        jsonb_build_object(
          'id', 'source-1',
          'name', 'Phòng 2 - CS155',
          'function', 'Phòng máy tính',
          'capacity', 20,
          'operationalStatus', 'Tốt',
          'custom', false,
          'createdAt', null,
          'updatedAt', null
        ),
        jsonb_build_object(
          'id', 'source-2',
          'name', 'Phòng 3 - CS155',
          'function', 'Thực hành giám định KTHS',
          'capacity', 20,
          'operationalStatus', 'Tốt',
          'custom', false,
          'createdAt', null,
          'updatedAt', null
        ),
        jsonb_build_object(
          'id', 'source-3',
          'name', 'Phòng 1 - CS200',
          'function', 'Phòng học CLC',
          'capacity', 20,
          'operationalStatus', 'Tốt',
          'custom', false,
          'createdAt', null,
          'updatedAt', null
        ),
        jsonb_build_object(
          'id', 'source-4',
          'name', 'Phòng 2 - CS200',
          'function', 'Thực hành KNHT',
          'capacity', 10,
          'operationalStatus', 'Tốt',
          'custom', false,
          'createdAt', null,
          'updatedAt', null
        )
      ),
      'updatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    updated_at = now()
where id = 'main';

commit;

-- The update must affect exactly one row. If it affects zero rows, the online
-- state has not been initialized yet; deploy the package and sign in once.
