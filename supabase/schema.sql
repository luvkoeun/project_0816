-- 한끼픽 사용 기록 스키마
-- Supabase 대시보드 > SQL Editor 에 그대로 붙여넣고 실행하세요.
--
-- 설계 원칙
--  1) 추가만 합니다(append-only). 브라우저는 INSERT만 할 수 있고 수정·삭제·조회는 막습니다.
--  2) 개인을 특정할 수 있는 값은 넣지 않습니다. 위도·경도, 주소, 로그인 정보를 저장하지 않습니다.
--  3) session_id는 브라우저가 만든 1회용 UUID입니다. 사람과 이어지지 않습니다.

-- ---------------------------------------------------------------------------
-- 1. 검색 한 번 = sessions 한 줄. "식당이 몇 개 떴는지"가 deck_size 입니다.
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id               uuid primary key,
  created_at       timestamptz not null default now(),
  deck_size        integer     not null,   -- 이번 검색으로 뜬 식당 수
  budget           integer     not null,
  time_limit       integer     not null,
  radius_m         integer     not null,
  cuisines         text[]      not null,
  location_source  text        not null check (location_source in ('gps', 'manual')),
  app_version      text
);

-- ---------------------------------------------------------------------------
-- 2. 카드를 넘기거나 고른 동작 한 번 = swipes 한 줄.
-- ---------------------------------------------------------------------------
create table if not exists public.swipes (
  id               bigint generated always as identity primary key,
  session_id       uuid        not null references public.sessions(id) on delete cascade,
  created_at       timestamptz not null default now(),
  deck_index       integer     not null,   -- 덱에서 몇 번째 카드였는지 (0부터)
  action           text        not null check (action in ('pass', 'choose')),
  input            text        not null check (input in ('drag', 'button', 'keyboard')),
  restaurant_id    text,
  restaurant_name  text,
  cuisine          text,
  price            integer,                -- 대표메뉴 추정가
  distance_m       integer,
  within_budget    boolean
);

create index if not exists swipes_session_idx on public.swipes (session_id);

-- ---------------------------------------------------------------------------
-- 3. 선택을 누른 순간 = picks 한 줄.
--    swipes_before 가 "몇 번 넘기고 골랐는지" 입니다.
-- ---------------------------------------------------------------------------
create table if not exists public.picks (
  id               bigint generated always as identity primary key,
  session_id       uuid        not null references public.sessions(id) on delete cascade,
  created_at       timestamptz not null default now(),
  swipes_before    integer     not null,   -- 고르기 전까지 넘긴 횟수
  deck_index       integer     not null,
  deck_size        integer     not null,
  decision_ms      integer     not null,   -- 검색 완료부터 선택까지 걸린 시간
  input            text        not null check (input in ('drag', 'button', 'keyboard')),
  restaurant_id    text,
  restaurant_name  text,
  cuisine          text,
  price            integer,
  distance_m       integer,
  within_budget    boolean
);

create index if not exists picks_session_idx on public.picks (session_id);

-- ---------------------------------------------------------------------------
-- 4. 선택 후 만족도 = feedback 한 줄.
-- ---------------------------------------------------------------------------
create table if not exists public.feedback (
  id               bigint generated always as identity primary key,
  session_id       uuid        not null references public.sessions(id) on delete cascade,
  created_at       timestamptz not null default now(),
  rating           integer     not null check (rating between 1 and 5),
  tags             text[]      not null default '{}'
);

create index if not exists feedback_session_idx on public.feedback (session_id);

-- ---------------------------------------------------------------------------
-- 5. RLS: 브라우저(anon 키)는 INSERT만. 읽기·수정·삭제 정책은 만들지 않습니다.
--    정책이 없으면 막히므로, anon 키가 공개돼도 남의 기록을 읽어갈 수 없습니다.
--    분석은 대시보드나 service_role 키로 하세요(둘 다 RLS를 우회합니다).
-- ---------------------------------------------------------------------------
alter table public.sessions enable row level security;
alter table public.swipes   enable row level security;
alter table public.picks    enable row level security;
alter table public.feedback enable row level security;

drop policy if exists "anon inserts sessions" on public.sessions;
drop policy if exists "anon inserts swipes"   on public.swipes;
drop policy if exists "anon inserts picks"    on public.picks;
drop policy if exists "anon inserts feedback" on public.feedback;

create policy "anon inserts sessions" on public.sessions
  for insert to anon with check (true);
create policy "anon inserts swipes" on public.swipes
  for insert to anon with check (true);
create policy "anon inserts picks" on public.picks
  for insert to anon with check (true);
create policy "anon inserts feedback" on public.feedback
  for insert to anon with check (true);

-- ---------------------------------------------------------------------------
-- 6. 분석용 뷰. security_invoker 를 켜서 뷰로 RLS를 우회하지 못하게 합니다.
-- ---------------------------------------------------------------------------
create or replace view public.session_summary
  with (security_invoker = on) as
select
  s.id                as session_id,
  s.created_at,
  s.deck_size,
  s.budget,
  s.time_limit,
  s.radius_m,
  s.cuisines,
  s.location_source,
  p.swipes_before,
  p.decision_ms,
  p.restaurant_name   as picked_name,
  p.cuisine           as picked_cuisine,
  p.price             as picked_price,
  p.distance_m        as picked_distance_m,
  (p.id is not null)  as picked,
  f.rating,
  f.tags
from public.sessions s
left join public.picks    p on p.session_id = s.id
left join public.feedback f on f.session_id = s.id;


-- ===========================================================================
-- 자주 쓸 질의 (SQL Editor 에서 실행)
-- ===========================================================================

-- 몇 번 넘기고 고르는가 — 평균·중앙값
--   select round(avg(swipes_before), 1) as 평균_넘김,
--          percentile_cont(0.5) within group (order by swipes_before) as 중앙값,
--          count(*) as 선택수
--   from public.picks;

-- 넘긴 횟수별 분포
--   select swipes_before, count(*) as 건수
--   from public.picks group by 1 order by 1;

-- 뜬 식당 수 대비 몇 번째에서 고르는가
--   select deck_size, round(avg(swipes_before), 1) as 평균_넘김
--   from public.picks group by 1 order by 1;

-- 검색은 했는데 아무것도 안 고른 비율(이탈률)
--   select count(*) filter (where not picked)::float / nullif(count(*), 0) as 이탈률
--   from public.session_summary;

-- 예산대별 선택까지 걸린 시간
--   select budget, count(*), round(avg(decision_ms) / 1000.0, 1) as 평균_초
--   from public.session_summary where picked group by 1 order by 1;
