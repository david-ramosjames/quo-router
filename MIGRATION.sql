-- Migrate public.intakes to flat, editable columns.
-- Generated from INTAKE_COLUMNS in server.js. Safe to re-run.
--
-- Run this once in Supabase after creating the base intakes table:
--   create table public.intakes (
--     id uuid primary key default gen_random_uuid(),
--     call_id text unique, name text, phone text,
--     quo_link text, transcript text, data jsonb,
--     created_at timestamptz default now()
--   );
--   alter table public.intakes enable row level security;

-- 1) Add one column per intake-form field
alter table public.intakes add column if not exists how_found text;
alter table public.intakes add column if not exists map_location text;
alter table public.intakes add column if not exists accident_date text;
alter table public.intakes add column if not exists accident_time text;
alter table public.intakes add column if not exists representation_date text;
alter table public.intakes add column if not exists accident_location text;
alter table public.intakes add column if not exists city text;
alter table public.intakes add column if not exists county text;
alter table public.intakes add column if not exists accident_description text;
alter table public.intakes add column if not exists police_department text;
alter table public.intakes add column if not exists police_report_no text;
alter table public.intakes add column if not exists ticket_issued boolean;
alter table public.intakes add column if not exists ticket_who text;
alter table public.intakes add column if not exists ticket_reason text;
alter table public.intakes add column if not exists name text;
alter table public.intakes add column if not exists phone text;
alter table public.intakes add column if not exists email text;
alter table public.intakes add column if not exists address text;
alter table public.intakes add column if not exists dob text;
alter table public.intakes add column if not exists sex text;
alter table public.intakes add column if not exists dl_number text;
alter table public.intakes add column if not exists spouse_name text;
alter table public.intakes add column if not exists emergency_contact text;
alter table public.intakes add column if not exists passengers text;
alter table public.intakes add column if not exists vehicle text;
alter table public.intakes add column if not exists vehicle_owner text;
alter table public.intakes add column if not exists drivable boolean;
alter table public.intakes add column if not exists towed boolean;
alter table public.intakes add column if not exists towed_by text;
alter table public.intakes add column if not exists vehicle_location text;
alter table public.intakes add column if not exists has_loan boolean;
alter table public.intakes add column if not exists lienholder text;
alter table public.intakes add column if not exists rental_needed boolean;
alter table public.intakes add column if not exists body_shop text;
alter table public.intakes add column if not exists employer text;
alter table public.intakes add column if not exists job_description text;
alter table public.intakes add column if not exists missed_work boolean;
alter table public.intakes add column if not exists salary_rate text;
alter table public.intakes add column if not exists other_driver_name text;
alter table public.intakes add column if not exists other_driver_sex text;
alter table public.intakes add column if not exists other_driver_dob text;
alter table public.intakes add column if not exists other_driver_address text;
alter table public.intakes add column if not exists other_driver_phone text;
alter table public.intakes add column if not exists other_driver_dl text;
alter table public.intakes add column if not exists other_driver_car_owner text;
alter table public.intakes add column if not exists client_insurance text;
alter table public.intakes add column if not exists client_policy_no text;
alter table public.intakes add column if not exists client_claim_no text;
alter table public.intakes add column if not exists third_party_insurance text;
alter table public.intakes add column if not exists third_party_policy_no text;
alter table public.intakes add column if not exists third_party_claim_no text;
alter table public.intakes add column if not exists pip boolean;
alter table public.intakes add column if not exists med_pay boolean;
alter table public.intakes add column if not exists um_uim boolean;
alter table public.intakes add column if not exists ems boolean;
alter table public.intakes add column if not exists hospital_bill boolean;
alter table public.intakes add column if not exists hospital text;
alter table public.intakes add column if not exists treating_doctor text;
alter table public.intakes add column if not exists injury_types text;
alter table public.intakes add column if not exists medicaid boolean;
alter table public.intakes add column if not exists medicare boolean;
alter table public.intakes add column if not exists health_insurance text;
alter table public.intakes add column if not exists notes text;
alter table public.intakes add column if not exists updated_at timestamptz default now();

-- 2) Backfill existing rows from the data JSONB archive
update public.intakes set
  how_found = coalesce(how_found, nullif(data->'referral'->>'how_found', '')),
  map_location = coalesce(map_location, nullif(data->'referral'->>'map_location', '')),
  accident_date = coalesce(accident_date, nullif(data->'accident'->>'date', '')),
  accident_time = coalesce(accident_time, nullif(data->'accident'->>'time', '')),
  representation_date = coalesce(representation_date, nullif(data->'accident'->>'representation_date', '')),
  accident_location = coalesce(accident_location, nullif(data->'accident'->>'location', '')),
  city = coalesce(city, nullif(data->'accident'->>'city', '')),
  county = coalesce(county, nullif(data->'accident'->>'county', '')),
  accident_description = coalesce(accident_description, nullif(data->'accident'->>'description', '')),
  police_department = coalesce(police_department, nullif(data->'accident'->>'police_department', '')),
  police_report_no = coalesce(police_report_no, nullif(data->'accident'->>'police_report_no', '')),
  ticket_issued = coalesce(ticket_issued, nullif(data->'accident'->>'ticket_issued', '')::boolean),
  ticket_who = coalesce(ticket_who, nullif(data->'accident'->>'ticket_who', '')),
  ticket_reason = coalesce(ticket_reason, nullif(data->'accident'->>'ticket_reason', '')),
  name = coalesce(name, nullif(data->'client'->>'name', '')),
  phone = coalesce(phone, nullif(data->'client'->>'phone', '')),
  email = coalesce(email, nullif(data->'client'->>'email', '')),
  address = coalesce(address, nullif(data->'client'->>'address', '')),
  dob = coalesce(dob, nullif(data->'client'->>'dob', '')),
  sex = coalesce(sex, nullif(data->'client'->>'sex', '')),
  dl_number = coalesce(dl_number, nullif(data->'client'->>'dl_number', '')),
  spouse_name = coalesce(spouse_name, nullif(data->'client'->>'spouse_name', '')),
  emergency_contact = coalesce(emergency_contact, nullif(data->'client'->>'emergency_contact', '')),
  passengers = coalesce(passengers, (select string_agg(x, ', ') from jsonb_array_elements_text(case when jsonb_typeof(data->'client'->'passengers') = 'array' then data->'client'->'passengers' else '[]'::jsonb end) x)),
  vehicle = coalesce(vehicle, nullif(data->'property_damage'->>'vehicle', '')),
  vehicle_owner = coalesce(vehicle_owner, nullif(data->'property_damage'->>'owner', '')),
  drivable = coalesce(drivable, nullif(data->'property_damage'->>'drivable', '')::boolean),
  towed = coalesce(towed, nullif(data->'property_damage'->>'towed', '')::boolean),
  towed_by = coalesce(towed_by, nullif(data->'property_damage'->>'towed_by', '')),
  vehicle_location = coalesce(vehicle_location, nullif(data->'property_damage'->>'vehicle_location', '')),
  has_loan = coalesce(has_loan, nullif(data->'property_damage'->>'has_loan', '')::boolean),
  lienholder = coalesce(lienholder, nullif(data->'property_damage'->>'lienholder', '')),
  rental_needed = coalesce(rental_needed, nullif(data->'property_damage'->>'rental_needed', '')::boolean),
  body_shop = coalesce(body_shop, nullif(data->'property_damage'->>'body_shop', '')),
  employer = coalesce(employer, nullif(data->'employment'->>'employer', '')),
  job_description = coalesce(job_description, nullif(data->'employment'->>'job_description', '')),
  missed_work = coalesce(missed_work, nullif(data->'employment'->>'missed_work', '')::boolean),
  salary_rate = coalesce(salary_rate, nullif(data->'employment'->>'salary_rate', '')),
  other_driver_name = coalesce(other_driver_name, nullif(data->'other_driver'->>'name', '')),
  other_driver_sex = coalesce(other_driver_sex, nullif(data->'other_driver'->>'sex', '')),
  other_driver_dob = coalesce(other_driver_dob, nullif(data->'other_driver'->>'dob', '')),
  other_driver_address = coalesce(other_driver_address, nullif(data->'other_driver'->>'address', '')),
  other_driver_phone = coalesce(other_driver_phone, nullif(data->'other_driver'->>'phone', '')),
  other_driver_dl = coalesce(other_driver_dl, nullif(data->'other_driver'->>'dl_number', '')),
  other_driver_car_owner = coalesce(other_driver_car_owner, nullif(data->'other_driver'->>'car_owner', '')),
  client_insurance = coalesce(client_insurance, nullif(data->'insurance'->>'client_company', '')),
  client_policy_no = coalesce(client_policy_no, nullif(data->'insurance'->>'client_policy_number', '')),
  client_claim_no = coalesce(client_claim_no, nullif(data->'insurance'->>'client_claim_number', '')),
  third_party_insurance = coalesce(third_party_insurance, nullif(data->'insurance'->>'third_party_company', '')),
  third_party_policy_no = coalesce(third_party_policy_no, nullif(data->'insurance'->>'third_party_policy_number', '')),
  third_party_claim_no = coalesce(third_party_claim_no, nullif(data->'insurance'->>'third_party_claim_number', '')),
  pip = coalesce(pip, nullif(data->'insurance'->>'pip', '')::boolean),
  med_pay = coalesce(med_pay, nullif(data->'insurance'->>'med_pay', '')::boolean),
  um_uim = coalesce(um_uim, nullif(data->'insurance'->>'um_uim', '')::boolean),
  ems = coalesce(ems, nullif(data->'injury'->>'ems', '')::boolean),
  hospital_bill = coalesce(hospital_bill, nullif(data->'injury'->>'hospital_bill', '')::boolean),
  hospital = coalesce(hospital, nullif(data->'injury'->>'hospital', '')),
  treating_doctor = coalesce(treating_doctor, nullif(data->'injury'->>'treating_doctor', '')),
  injury_types = coalesce(injury_types, (select string_agg(x, ', ') from jsonb_array_elements_text(case when jsonb_typeof(data->'injury'->'injury_types') = 'array' then data->'injury'->'injury_types' else '[]'::jsonb end) x)),
  medicaid = coalesce(medicaid, nullif(data->'injury'->>'medicaid', '')::boolean),
  medicare = coalesce(medicare, nullif(data->'injury'->>'medicare', '')::boolean),
  health_insurance = coalesce(health_insurance, nullif(data->'injury'->>'health_insurance', '')),
  notes = coalesce(notes, nullif(data->>'notes', ''))
where data is not null;

-- 3) Lookup indexes (search by name / phone from the app)
create index if not exists intakes_name_idx  on public.intakes (lower(name));
create index if not exists intakes_phone_idx on public.intakes (phone);

-- 4) The flat view is now redundant — the table itself is flat
drop view if exists public.intakes_flat;

-- 5) Follow-up interactions (calls/texts/voicemails linked to an intake)
create table if not exists public.intake_interactions (
  id             uuid primary key default gen_random_uuid(),
  intake_call_id text,
  phone          text,
  type           text,
  direction      text,
  source_id      text unique,
  content        text,
  transcript     text,
  quo_link       text,
  data           jsonb,
  occurred_at    timestamptz default now()
);
alter table public.intake_interactions enable row level security;
create index if not exists intake_interactions_intake_idx on public.intake_interactions (intake_call_id);
