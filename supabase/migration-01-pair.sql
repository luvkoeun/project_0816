-- 한 번에 두 곳을 보여주는 버전(pair)으로 바뀌면서 필요한 변경입니다.
-- 이미 schema.sql 을 실행한 프로젝트에서 이 파일을 SQL Editor 에 붙여넣고 실행하세요.
-- 새로 만드는 프로젝트는 schema.sql 하나면 됩니다(이 내용이 이미 반영돼 있습니다).
--
-- 표를 새로 만들지 않습니다. 기존 표에 variant 를 두어 버전을 구분합니다.
-- 그래야 group by variant 한 줄로 두 버전을 나란히 비교할 수 있습니다.
-- 여러 번 실행해도 안전합니다.

-- 1. 어느 버전에서 쌓인 기록인지 구분합니다. 기존 행은 전부 'single' 이 됩니다.
alter table public.sessions
  add column if not exists variant text not null default 'single';

alter table public.sessions drop constraint if exists sessions_variant_check;
alter table public.sessions
  add constraint sessions_variant_check check (variant in ('single', 'pair'));

-- 2. 두 곳 중 어느 쪽이었는지. 0 = 왼쪽, 1 = 오른쪽. single 버전 기록은 null 로 남습니다.
alter table public.swipes add column if not exists pair_position integer;
alter table public.picks  add column if not exists pair_position integer;

-- 3. 고르기까지 실제로 눈으로 본 식당 수.
--    single 은 넘긴 횟수와 같지만 pair 는 한 번 넘길 때 두 곳을 보므로 값이 달라집니다.
--    두 버전을 같은 잣대로 비교하려면 이 값이 필요합니다.
alter table public.picks add column if not exists cards_seen integer;

-- 기존 single 기록은 넘긴 횟수 + 1 이 곧 본 식당 수입니다.
update public.picks
   set cards_seen = swipes_before + 1
 where cards_seen is null;

-- 4. 카드를 눌러 고르는 방식이 생겨 input 에 'card' 를 허용합니다.
--    제약 이름이 환경마다 다를 수 있어, 이름으로 찾지 않고 정의 내용으로 찾아 지웁니다.
--    이름만 보고 지우면 못 찾고 넘어가서 옛 제약이 남고, 'card' 가 계속 거절됩니다.
do $$
declare c record;
begin
  for c in
    select conrelid::regclass::text as tbl, conname
      from pg_constraint
     where contype = 'c'
       and conrelid in ('public.swipes'::regclass, 'public.picks'::regclass)
       and pg_get_constraintdef(oid) ilike '%input%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table public.swipes
  add constraint swipes_input_check check (input in ('drag', 'button', 'keyboard', 'card'));
alter table public.picks
  add constraint picks_input_check check (input in ('drag', 'button', 'keyboard', 'card'));

-- 5. 뷰를 다시 만듭니다.
--    create or replace view 는 기존 컬럼의 이름과 순서를 바꿀 수 없고 뒤에 덧붙이는 것만
--    됩니다. variant 를 중간에 끼워 넣으므로 반드시 지우고 새로 만들어야 합니다.
--    뷰에는 데이터가 없어 지워도 잃는 것이 없습니다.
drop view if exists public.session_summary;

create view public.session_summary
  with (security_invoker = on) as
select
  s.id                as session_id,
  s.created_at,
  s.variant,
  s.deck_size,
  s.budget,
  s.time_limit,
  s.radius_m,
  s.cuisines,
  s.location_source,
  p.swipes_before,
  p.cards_seen,
  p.pair_position,
  p.decision_ms,
  p.input             as pick_input,
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
-- 두 버전 비교하기
-- ===========================================================================

-- 버전별 핵심 지표 한 번에
--   select variant,
--          count(*)                                             as 검색수,
--          count(*) filter (where picked)                       as 선택수,
--          round(100.0 * count(*) filter (where picked) / count(*), 1) as 선택률,
--          round(avg(cards_seen)  filter (where picked), 1)      as 평균_본식당수,
--          round(avg(swipes_before) filter (where picked), 1)    as 평균_넘김수,
--          round(avg(decision_ms) filter (where picked) / 1000.0, 1) as 평균_초,
--          round(avg(rating), 2)                                as 평균_만족도
--   from public.session_summary
--   group by variant order by variant;

-- pair 버전에서 왼쪽·오른쪽 중 어느 쪽을 더 고르는가
--   select pair_position, count(*)
--   from public.picks where pair_position is not null
--   group by 1 order by 1;

-- 어떤 방식으로 고르는가 (카드 클릭 / 키보드)
--   select variant, pick_input, count(*)
--   from public.session_summary where picked
--   group by 1, 2 order by 1, 3 desc;
