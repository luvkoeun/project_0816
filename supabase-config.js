// Supabase 연결 정보. 두 값을 채우면 사용 기록이 DB로 함께 쌓입니다.
// 비워두면 앱은 그대로 동작하고 기록만 브라우저 localStorage에 남습니다.
//
// 값 위치: Supabase 대시보드 > Project Settings > API
//   url     = Project URL       (예: https://abcdefghijkl.supabase.co)
//   anonKey = Project API keys 의 anon public 키
//
// anon 키는 브라우저에 공개되는 것을 전제로 만들어진 키입니다.
// supabase/schema.sql 의 RLS 정책이 INSERT만 허용하므로,
// 이 키로는 쌓인 기록을 읽거나 지울 수 없습니다.
window.HANKKIPICK_SUPABASE = {
  url: "",
  anonKey: "",
};
