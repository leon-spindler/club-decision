-- Run once in Supabase → SQL Editor.
create table if not exists ratings (
  user_name  text not null,
  event_id   text not null,
  stars      int  not null check (stars between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (user_name, event_id)
);
alter table ratings enable row level security;
-- Friends-only app with no logins: anyone with the link may read/write ratings.
create policy "read"   on ratings for select using (true);
create policy "insert" on ratings for insert with check (true);
create policy "update" on ratings for update using (true);
create policy "delete" on ratings for delete using (true);
