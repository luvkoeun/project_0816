#!/usr/bin/env node
// Vercel 빌드 때 환경변수를 읽어 supabase-config.js 를 다시 만듭니다.
//
// 정적 사이트라 환경변수가 브라우저로 자동으로 넘어가지 않습니다.
// 그래서 배포 시점에 값을 파일로 구워 넣습니다.
//
//   SUPABASE_URL       = https://<프로젝트>.supabase.co
//   SUPABASE_ANON_KEY  = anon public 키
//
// 로컬에서는 실행할 필요가 없습니다. 저장소에 들어 있는 빈 껍데기가 그대로 쓰이고,
// 값이 비어 있으면 앱은 정상 동작하면서 기록만 localStorage 에 남깁니다.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "supabase-config.js");

const rawUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();

// 대시보드에서 끝 슬래시나 /rest/v1 까지 함께 복사해 넣는 경우가 많습니다.
// 그대로 두면 /rest/v1/rest/v1 로 요청이 나가 404가 나므로 여기서 정리합니다.
const url = rawUrl
  .replace(/\/+$/, "")
  .replace(/\/rest\/v1$/i, "")
  .replace(/\/+$/, "");
const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();

function fail(message) {
  console.error(`\n[supabase-config] ${message}\n`);
  process.exit(1);
}

// 이 파일은 브라우저로 그대로 내려갑니다. 비밀 키가 섞이면 배포를 중단시킵니다.
function assertPublishableKey(key) {
  if (!key) return;
  if (key.startsWith("sb_secret_")) {
    fail("secret 키가 들어왔습니다. 공개되는 파일이므로 anon(publishable) 키를 넣어주세요.");
  }
  const payload = key.split(".")[1];
  if (!payload) return; // JWT 형식이 아니면 새 형식의 publishable 키로 보고 넘어갑니다.
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims.role && claims.role !== "anon") {
      fail(`키의 role 이 "${claims.role}" 입니다. 공개되는 파일이므로 anon 키만 넣어야 합니다.`);
    }
  } catch {
    // 디코딩이 안 되면 판단하지 않고 통과시킵니다.
  }
}

assertPublishableKey(anonKey);

if (Boolean(url) !== Boolean(anonKey)) {
  fail("SUPABASE_URL 과 SUPABASE_ANON_KEY 는 둘 다 설정해야 합니다. 지금은 한쪽만 들어와 있습니다.");
}

if (url && url !== rawUrl) {
  console.log(`[supabase-config] URL 을 정리했습니다: ${rawUrl} -> ${url}`);
}

if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url)) {
  console.warn(`[supabase-config] URL 형태가 예상과 다릅니다: ${url}`);
}

writeFileSync(TARGET, `// 이 파일은 빌드할 때 scripts/build-config.mjs 가 다시 만듭니다. 직접 고치지 마세요.
// 값은 배포 환경변수 SUPABASE_URL / SUPABASE_ANON_KEY 에서 가져옵니다.
window.HANKKIPICK_SUPABASE = {
  url: ${JSON.stringify(url)},
  anonKey: ${JSON.stringify(anonKey)},
};
`, "utf8");

console.log(url
  ? `[supabase-config] 사용 기록 수집 켬 — ${url}`
  : "[supabase-config] 환경변수가 없어 수집을 끈 채로 만듭니다. 기록은 브라우저에만 남습니다.");
