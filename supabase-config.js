// Supabase 연결 정보.
//
// 배포(Vercel)에서는 이 파일을 건드리지 않습니다.
// 빌드할 때 scripts/build-config.mjs 가 환경변수를 읽어 이 파일을 덮어씁니다.
//   SUPABASE_URL       = https://<프로젝트>.supabase.co
//   SUPABASE_ANON_KEY  = anon public 키
//
// 로컬에서 잠깐 붙여보고 싶을 때만 아래 두 값을 직접 채우세요.
// 비어 있으면 앱은 그대로 동작하고 기록은 브라우저 localStorage 에만 남습니다.
//
// anon 키는 브라우저에 공개되는 것을 전제로 만들어진 키입니다.
// supabase/schema.sql 의 RLS 정책이 INSERT 만 허용하므로,
// 이 키로는 쌓인 기록을 읽거나 지울 수 없습니다.
window.HANKKIPICK_SUPABASE = {
  url: "",
  anonKey: "",
};
