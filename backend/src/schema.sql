create table if not exists orgs (
  id serial primary key,
  name text not null,
  agent_token text not null unique,
  tally_company text default '',
  created_at timestamptz default now()
);
create table if not exists users (
  id serial primary key,
  org_id int not null references orgs(id) on delete cascade,
  email text not null unique,
  salt text not null,
  pw_hash text not null,
  created_at timestamptz default now()
);
create table if not exists mailboxes (
  id serial primary key,
  org_id int not null references orgs(id) on delete cascade,
  email text not null,
  enc_password text not null,
  imap_host text not null default 'imap.gmail.com',
  last_uid bigint not null default 0,
  active boolean not null default true,
  last_error text,
  last_checked timestamptz,
  created_at timestamptz default now(),
  unique(org_id, email)
);
create table if not exists documents (
  id serial primary key,
  org_id int not null references orgs(id) on delete cascade,
  mailbox_id int references mailboxes(id) on delete set null,
  source text not null default 'upload',
  source_ref text,
  sender text,
  subject text,
  filename text not null,
  mime text,
  file_path text not null,
  doc_type text,
  status text not null default 'new',
  extracted jsonb,
  warnings jsonb default '[]',
  error text,
  tally_result text,
  created_at timestamptz default now(),
  approved_at timestamptz,
  synced_at timestamptz,
  unique(org_id, source_ref, filename)
);
create index if not exists documents_status on documents(org_id, status);
create table if not exists tally_vouchers (
  id serial primary key,
  org_id int not null references orgs(id) on delete cascade,
  guid text not null,
  vch_type text,
  number text,
  vch_date date,
  party text,
  reference text,
  amount numeric(16,2),
  fetched_at timestamptz default now(),
  unique(org_id, guid)
);
alter table orgs add column if not exists agent_last_seen timestamptz;
alter table orgs add column if not exists last_pull_at timestamptz;
alter table orgs add column if not exists last_pull_count int;
-- two-way sync with Tally
alter table documents add column if not exists tally_guid text;
alter table documents add column if not exists tally_state text;
alter table orgs add column if not exists last_pull_request_at timestamptz;
create table if not exists doc_events (
  id serial primary key,
  org_id int not null references orgs(id) on delete cascade,
  doc_id int references documents(id) on delete cascade,
  kind text not null,
  detail text not null,
  at timestamptz default now()
);
create index if not exists doc_events_org on doc_events(org_id, id desc);
-- check-before-post / Tally-entered records
alter table documents add column if not exists dup_guid text;
alter table documents add column if not exists force_post boolean not null default false;
alter table orgs add column if not exists sync_stage text;
alter table orgs add column if not exists last_pull_result jsonb;
-- live watching of Tally was removed: sync is button-driven only
alter table orgs drop column if exists auto_sync_seconds;
alter table orgs add column if not exists own_name text not null default '';
alter table orgs add column if not exists own_gstin text not null default '';
alter table orgs add column if not exists default_role text not null default 'buyer';
-- tracked sync runs: the dashboard's progress pipeline
create table if not exists sync_runs (
  id serial primary key,
  org_id int not null references orgs(id) on delete cascade,
  kind text not null,
  status text not null default 'running',
  stage text not null,
  doc_ids int[] not null default '{}',
  result jsonb,
  message text,
  started_at timestamptz default now(),
  updated_at timestamptz default now(),
  finished_at timestamptz
);
create index if not exists sync_runs_org on sync_runs(org_id, id desc);
-- does TallyPrime itself answer on the Tally computer? (reported by the Tally program on every poll)
alter table orgs add column if not exists tally_ok boolean;
alter table orgs add column if not exists tally_checked_at timestamptz;

-- Original files (PDF / image / sheet) live in the database, so everything is in Supabase. data_dir files are only a cache.
create table if not exists document_files (
  doc_id int primary key references documents(id) on delete cascade,
  data bytea not null
);

alter table users add column if not exists auth_id uuid unique;      -- the user's id in Supabase Auth (auth.users)
alter table documents add column if not exists storage_path text;     -- the file's path in the Supabase Storage bucket "documents"

alter table orgs add column if not exists company_ok boolean;           -- is the company named in Setup open in TallyPrime? (reported by the Tally program)
alter table orgs add column if not exists company_checked_at timestamptz;

-- Several computers can run the Tally program for one account: each one reports for itself.
create table if not exists tally_agents (
  org_id int not null references orgs(id) on delete cascade,
  agent_key text not null,
  host text default '',
  last_seen timestamptz not null default now(),
  tally_ok boolean,
  tally_checked_at timestamptz,
  company_ok boolean,
  primary key (org_id, agent_key)
);
alter table tally_agents enable row level security;
alter table if exists document_files enable row level security;

-- The company that is open on the PC that connected last is the active one; everything is tagged with its company.
alter table documents add column if not exists company text;
alter table tally_vouchers add column if not exists company text;
alter table tally_agents add column if not exists company_name text;
alter table tally_agents add column if not exists company_since timestamptz;
update documents d set company=o.tally_company from orgs o where o.id=d.org_id and d.company is null and o.tally_company<>'' and (d.status='synced' or d.source='tally');
update tally_vouchers v set company=o.tally_company from orgs o where o.id=v.org_id and v.company is null and o.tally_company<>'';
