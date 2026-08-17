(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const USAGE_KEY = "hankkipick_usage_v2";
  const SERVICE_VERSION = "v4-pair-cards";
  // 한 번에 몇 곳을 보여주는지. DB에는 variant 로 기록해 이전 버전과 나눠 볼 수 있게 합니다.
  const PAIR_SIZE = 2;
  const VARIANT = "pair";
  const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
  const WIKIDATA_ENDPOINT = "https://www.wikidata.org/w/api.php";
  const COMMONS_FILE_URL = "https://commons.wikimedia.org/wiki/Special:FilePath/";

  const PENDING_KEY = "hankkipick_pending_v1";
  const PENDING_LIMIT = 300;

  const state = {
    criteria: { budget: 15000, time: 60, cuisines: ["한식", "일식"] },
    location: null,
    deck: [],
    index: 0,
    sessionId: null,
    swipes: 0,
    startedAt: null,
    chosen: null,
    rating: 0,
    feedbackTags: [],
    feedbackRecorded: false,
    animating: false,
    dragging: false,
    locating: false,
    geocoding: false,
    loading: false,
  };

  let toastTimer;
  let locationResults = [];
  let usage = loadUsage();

  function loadUsage() {
    try {
      return {
        sessions: 0,
        passes: 0,
        selections: 0,
        feedback: [],
        events: [],
        ...JSON.parse(localStorage.getItem(USAGE_KEY) || "{}"),
      };
    } catch {
      return { sessions: 0, passes: 0, selections: 0, feedback: [], events: [] };
    }
  }

  function recordEvent(type, detail = {}) {
    usage.events.unshift({ version: SERVICE_VERSION, type, ...detail, at: Date.now() });
    usage.events = usage.events.slice(0, 100);
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  }

  // ---------------------------------------------------------------------------
  // Supabase 사용 기록
  // supabase-config.js 를 채우면 켜지고, 비어 있으면 조용히 localStorage만 씁니다.
  // 라이브러리 없이 PostgREST 엔드포인트로 바로 INSERT 합니다.
  // ---------------------------------------------------------------------------
  const supabaseConfig = window.HANKKIPICK_SUPABASE || {};
  const DIAGNOSTIC_TAG = "__diagnostic__";

  // 대시보드에서 값을 가져올 때 끝 슬래시나 /rest/v1 까지 함께 복사되는 경우가 많습니다.
  // 그대로 두면 //rest/v1 이나 /rest/v1/rest/v1 로 요청이 나가 404가 납니다.
  function normalizeSupabaseUrl(value) {
    return String(value || "").trim()
      .replace(/\/+$/, "")
      .replace(/\/rest\/v1$/i, "")
      .replace(/\/+$/, "");
  }

  const supabaseUrl = normalizeSupabaseUrl(supabaseConfig.url);
  const supabaseKey = String(supabaseConfig.anonKey || "").trim();

  function analyticsEnabled() {
    return Boolean(supabaseUrl && supabaseKey);
  }

  // 실패했을 때 무엇을 고쳐야 하는지 바로 알 수 있게 상태코드를 말로 옮깁니다.
  function describeStatus(status) {
    if (!status) return "서버에 닿지 못했습니다. URL이 맞는지, Supabase 프로젝트가 일시정지 상태는 아닌지 확인하세요.";
    if (status === 404) return "표가 없습니다. supabase/schema.sql 전체를 SQL Editor에서 실행하세요.";
    if (status === 401) return "키가 거부됐습니다. Project Settings > API 의 anon public 키가 맞는지 확인하세요.";
    if (status === 403) return "RLS 정책에 막혔습니다. schema.sql 의 정책 부분을 다시 실행하세요.";
    if (status === 400) return "보낸 값이 표 구조와 맞지 않습니다.";
    if (status === 429) return "요청이 많아 잠시 뒤 다시 보냅니다.";
    return "서버 오류입니다. 잠시 뒤 다시 보냅니다.";
  }

  function newSessionId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // file:// 처럼 randomUUID를 못 쓰는 환경을 위한 대체 구현입니다.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function loadPending() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  let pending = loadPending();
  let flushing = false;

  function savePending() {
    // 오래 쌓이면 앞쪽부터 버립니다. 기록 때문에 저장소가 가득 차면 안 됩니다.
    pending = pending.slice(-PENDING_LIMIT);
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch {
      pending = [];
    }
  }

  async function insertRows(table, rows) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
      keepalive: true,
    });
    if (response.ok) return;
    const error = new Error(`${table} ${response.status}`);
    error.status = response.status;
    throw error;
  }

  async function flushPending() {
    if (flushing || !analyticsEnabled() || !pending.length) return;
    flushing = true;
    try {
      // sessions가 swipes·picks보다 먼저 들어가야 외래키가 맞으므로 순서를 지킵니다.
      // 같은 테이블이 연속으로 있으면 한 번에 묶어 보냅니다.
      while (pending.length) {
        const { table } = pending[0];
        const batch = [];
        while (pending.length && pending[0].table === table) batch.push(pending.shift().row);
        try {
          await insertRows(table, batch);
        } catch (error) {
          // 400대는 몇 번을 보내도 같은 이유로 거절당합니다. 큐가 영영 막히지 않도록 버리고 넘어갑니다.
          // 네트워크 오류나 500대는 되돌려 놓고 다음 기회에 다시 시도합니다.
          const permanent = error.status >= 400 && error.status < 500 && error.status !== 429;
          // 조용히 버리면 왜 기록이 안 쌓이는지 알 수 없으므로 이유는 남깁니다.
          console.warn(
            `[한끼픽] ${table} 기록 ${batch.length}건 전송 실패 (${error.status || "network"})`
            + `\n  ${describeStatus(error.status)}`
            + `\n  ${permanent ? "이번 기록은 버립니다." : "큐에 남겨 두고 다시 시도합니다."}`
            + "\n  자세히 보려면 콘솔에서 HankkiPick.testRemote() 를 실행하세요.",
          );
          if (!permanent) {
            pending = batch.map((row) => ({ table, row })).concat(pending);
            throw error;
          }
        }
        savePending();
      }
    } catch {
      // 다음 이벤트나 다음 접속 때 다시 보냅니다. 실패해도 앱 동작에는 영향이 없습니다.
    } finally {
      savePending();
      flushing = false;
    }
  }

  function queueRow(table, row) {
    if (!analyticsEnabled()) return;
    pending.push({ table, row });
    savePending();
    flushPending();
  }

  // 카드에서 기록으로 넘길 값만 추립니다. 좌표와 주소는 보내지 않습니다.
  function restaurantColumns(restaurant) {
    return {
      restaurant_id: restaurant.id,
      restaurant_name: restaurant.name,
      cuisine: restaurant.cuisine,
      price: restaurant.price,
      distance_m: restaurant.distance,
      within_budget: withinBudget(restaurant),
    };
  }

  // 기록이 안 쌓일 때 원인을 한 번에 짚어 주는 진단입니다.
  // 읽기 한 번으로 표와 키를 확인하고, 마지막에 실제로 한 줄을 넣어 쓰기까지 확인합니다.
  async function testRemote() {
    const report = (ok, message, hint = "") => {
      console[ok ? "log" : "warn"](`[한끼픽 진단] ${message}${hint ? `\n  → ${hint}` : ""}`);
      return { ok, message, hint };
    };

    if (!analyticsEnabled()) {
      return report(false, "설정이 비어 있어 아무것도 보내지 않는 상태입니다.",
        "Vercel 환경변수 SUPABASE_URL / SUPABASE_ANON_KEY 를 넣고 재배포하세요. "
        + "배포주소/supabase-config.js 를 열면 실제로 실린 값을 볼 수 있습니다.");
    }
    if (!/^https:\/\/[^\s/]+$/i.test(supabaseUrl)) {
      return report(false, `URL 형태가 이상합니다: ${supabaseUrl}`,
        "https://<프로젝트>.supabase.co 형태여야 합니다.");
    }

    let response;
    try {
      response = await fetch(`${supabaseUrl}/rest/v1/sessions?select=id&limit=1`, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      });
    } catch {
      return report(false, "서버에 닿지 못했습니다.",
        "URL 오타이거나 Supabase 프로젝트가 일시정지(Paused) 상태일 수 있습니다.");
    }
    if (!response.ok) {
      return report(false, `표를 확인하지 못했습니다 (${response.status}).`, describeStatus(response.status));
    }

    // 표와 키는 정상입니다. 남은 것은 INSERT 권한이라 실제로 한 줄 넣어 봅니다.
    try {
      await insertRows("sessions", [{
        id: newSessionId(),
        deck_size: 0,
        budget: 0,
        time_limit: 0,
        radius_m: 0,
        cuisines: [],
        location_source: "manual",
        app_version: DIAGNOSTIC_TAG,
      }]);
    } catch (error) {
      return report(false, `쓰기에 실패했습니다 (${error.status || "network"}).`, describeStatus(error.status));
    }

    return report(true, "정상입니다. 표·키·쓰기 권한 모두 확인했습니다.",
      "확인용으로 sessions 에 한 줄 넣었습니다. 지우려면 SQL Editor에서: "
      + `delete from public.sessions where app_version = '${DIAGNOSTIC_TAG}';`);
  }

  // 화면에는 분석 도구를 노출하지 않지만, 팀이 콘솔에서 익명 사용 기록을 꺼낼 수 있습니다.
  window.HankkiPick = {
    exportUsage: () => JSON.parse(JSON.stringify(usage)),
    clearUsage: () => {
      usage = { sessions: 0, passes: 0, selections: 0, feedback: [], events: [] };
      localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
    },
    remoteStatus: () => ({
      enabled: analyticsEnabled(),
      url: supabaseUrl || "(미설정)",
      keyTail: supabaseKey ? `…${supabaseKey.slice(-6)}` : "(미설정)",
      pending: pending.length,
    }),
    flushRemote: () => flushPending(),
    testRemote,
  };

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function kakaoMapUrl(restaurant) {
    const label = encodeURIComponent(String(restaurant.name || "선택한 식당").replaceAll(",", " "));
    return `https://map.kakao.com/link/map/${label},${restaurant.lat},${restaurant.lng}`;
  }

  function kakaoDirectionsUrl(restaurant) {
    const label = encodeURIComponent(String(restaurant.name || "선택한 식당").replaceAll(",", " "));
    return `https://map.kakao.com/link/to/${label},${restaurant.lat},${restaurant.lng}`;
  }

  function displayAddress(address) {
    return address || "정확한 위치는 지도에서 확인";
  }

  function displayPhone(phone) {
    return phone || "전화번호 정보 없음";
  }

  function formatPrice(value) {
    return `${Number(value).toLocaleString("ko-KR")}원`;
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  function showError(message) {
    const box = $("#connection-error");
    box.textContent = message;
    box.hidden = false;
  }

  function clearError() {
    $("#connection-error").hidden = true;
    $("#connection-error").textContent = "";
  }

  function switchView(viewId) {
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === viewId));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bindChoiceControls() {
    $$('[data-choice-group]').forEach((group) => {
      group.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-value]");
        if (!button) return;
        $$("button", group).forEach((item) => item.classList.remove("selected"));
        button.classList.add("selected");
        state.criteria[group.dataset.choiceGroup] = Number(button.dataset.value);
      });
    });

    $("#cuisine-chips").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button) return;
      button.classList.toggle("selected");
      const selected = $$("button.selected", $("#cuisine-chips")).map((item) => item.dataset.value);
      if (!selected.length) {
        button.classList.add("selected");
        showToast("메뉴를 하나 이상 골라주세요.");
        return;
      }
      state.criteria.cuisines = selected;
    });
  }

  // 현재 위치와 직접 입력한 주소가 같은 경로로 반영되도록 한 곳에서만 위치를 갱신합니다.
  function setLocation(location) {
    state.location = location;
    const summary = $("#location-current");
    summary.textContent = `출발 위치 · ${location.label}`;
    summary.hidden = false;
    $("#location-accuracy").textContent = location.source === "gps"
      ? `오차 약 ${Math.round(location.accuracy)}m`
      : "직접 입력";
    clearError();
  }

  async function geocodeAddress(query) {
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: "5",
      addressdetails: "1",
      countrycodes: "kr",
      "accept-language": "ko",
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${NOMINATIM_ENDPOINT}?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function resultLabel(result) {
    return result.name || String(result.display_name || "").split(",")[0].trim();
  }

  function renderLocationResults(results) {
    const list = $("#location-results");
    if (!results.length) {
      list.hidden = true;
      list.innerHTML = "";
      return;
    }
    list.innerHTML = results.map((result, index) => `
      <li>
        <button type="button" data-index="${index}">
          <strong>${escapeHTML(resultLabel(result))}</strong>
          <small>${escapeHTML(result.display_name || "")}</small>
        </button>
      </li>`).join("");
    list.hidden = false;
  }

  async function searchLocation() {
    const query = $("#location-input").value.trim();
    if (!query) {
      showToast("주소나 장소명을 입력해주세요.");
      return;
    }
    if (state.geocoding) return;

    state.geocoding = true;
    const button = $("#location-search");
    button.disabled = true;
    button.textContent = "검색 중…";
    clearError();

    try {
      locationResults = await geocodeAddress(query);
      renderLocationResults(locationResults);
      if (!locationResults.length) showToast("검색 결과가 없어요. 다른 주소나 장소명으로 찾아보세요.");
    } catch {
      renderLocationResults([]);
      showError("주소 검색 서버에 연결하지 못했습니다. 잠시 후 다시 시도하거나 현재 위치를 사용해주세요.");
    } finally {
      state.geocoding = false;
      button.disabled = false;
      button.textContent = "검색";
    }
  }

  function chooseLocationResult(index) {
    const result = locationResults[index];
    if (!result) return;
    const lat = Number(result.lat);
    const lng = Number(result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    setLocation({ lat, lng, label: resultLabel(result), address: result.display_name || "", source: "manual" });
    $("#location-input").value = resultLabel(result);
    $("#location-label").textContent = "출발 위치 직접 지정됨";
    $("#location-help").textContent = "다시 누르면 현재 위치로 바꿀 수 있어요";
    renderLocationResults([]);
    showToast("출발 위치를 설정했어요.");
  }

  function requestCurrentLocation() {
    if (state.locating) return Promise.reject(new Error("LOCATION_PENDING"));
    if (!navigator.geolocation) {
      const error = new Error("이 브라우저에서는 현재 위치를 확인할 수 없습니다. 출발 위치를 직접 입력해주세요.");
      error.code = "LOCATION_UNSUPPORTED";
      return Promise.reject(error);
    }

    state.locating = true;
    const button = $("#location-button");
    button.classList.add("loading");
    $("#location-help").textContent = "현재 좌표를 확인하고 있어요…";
    clearError();

    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setLocation({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            label: "내 현재 위치",
            source: "gps",
          });
          $("#location-label").textContent = "현재 위치 확인됨";
          $("#location-help").textContent = "위치는 주변 검색에만 사용하고 저장하지 않아요";
          renderLocationResults([]);
          button.classList.remove("loading");
          state.locating = false;
          showToast("현재 위치를 불러왔어요.");
          resolve(state.location);
        },
        (geolocationError) => {
          const denied = geolocationError.code === geolocationError.PERMISSION_DENIED;
          const message = denied
            ? "위치 권한이 거부됐어요. 아래에서 출발 위치를 직접 입력해주세요."
            : "현재 위치를 확인하지 못했습니다. 다시 시도하거나 출발 위치를 직접 입력해주세요.";
          $("#location-label").textContent = "현재 위치가 필요해요";
          $("#location-help").textContent = message;
          button.classList.remove("loading");
          state.locating = false;
          const error = new Error(message);
          error.code = denied ? "LOCATION_DENIED" : "LOCATION_FAILED";
          reject(error);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
      );
    });
  }

  // 앞쪽 규칙이 우선합니다. 어느 규칙에도 걸리지 않으면 억지로 분류하지 않고 null을 돌려줍니다.
  const CUISINE_RULES = [
    ["일식", /japanese|sushi|ramen|udon|soba|donburi|tempura|izakaya|yakitori|tonkatsu|sashimi|okonomiyaki|일식|초밥|스시|사시미|회덮밥|라멘|우동|소바|돈까스|돈카츠|규동|이자카야|오마카세|텐동|가츠/],
    ["중식", /chinese|dim_?sum|dumpling|hot_?pot|sichuan|szechuan|중식|중화|중국|마라|양꼬치|짜장|자장|짬뽕|탕수육|훠궈|딤섬|만두|양장피/],
    ["양식", /italian|french|american|western|pasta|pizza|steak|burger|hamburger|mexican|spanish|german|greek|chicken|양식|이탈리|프렌치|파스타|피자|스테이크|버거|햄버거|브런치|멕시칸|치킨|스파게티|리조또/],
    ["분식", /kimbap|gimbap|tteokbokki|street_food|분식|떡볶이|김밥|순대(?!국)|튀김|어묵|라면|토스트|핫도그/],
    ["샐러드", /salad|sandwich|healthy|vegetarian|vegan|poke|샐러드|샌드위치|건강식|포케|비건|채식/],
    ["한식", /korean|bibimbap|bulgogi|gukbap|samgyetang|barbecue|한식|한정식|백반|국밥|김치|비빔밥|불고기|삼겹살|고깃집|갈비|찌개|전골|곰탕|설렁탕|해장국|냉면|칼국수|족발|보쌈|감자탕|쌈밥|정육식당|생선구이|추어탕|삼계탕|낙지|아구찜|보리밥/],
  ];

  const CUISINE_STYLES = {
    한식: ["🍲", "#f6bd68"], 일식: ["🍱", "#f4a6a1"], 중식: ["🍜", "#f09b73"],
    양식: ["🍝", "#f1cb83"], 분식: ["🌶️", "#ef8e82"], 샐러드: ["🥗", "#9fd3a8"],
  };
  const UNKNOWN_CUISINE_STYLE = ["🍽️", "#cbbfae"];

  function matchCuisine(text) {
    const value = String(text || "").toLowerCase();
    if (!value.trim()) return null;
    for (const [label, pattern] of CUISINE_RULES) {
      if (pattern.test(value)) return label;
    }
    return null;
  }

  // cuisine 태그가 가장 정확하므로 먼저 보고, 없을 때만 상호명으로 추정합니다.
  function deriveCuisine(tags = {}) {
    return matchCuisine(tags.cuisine)
      ?? matchCuisine(`${tags["name:ko"] || ""} ${tags.name || ""} ${tags.brand || ""}`);
  }

  function cuisineStyle(cuisine) {
    return CUISINE_STYLES[cuisine] || UNKNOWN_CUISINE_STYLE;
  }

  // 선택한 메뉴 > 종류 미상 > 선택하지 않은 메뉴 순으로 정렬합니다.
  function preferenceRank(cuisine) {
    if (!cuisine) return 1;
    return state.criteria.cuisines.includes(cuisine) ? 2 : 0;
  }

  // OpenStreetMap에는 메뉴 가격 태그가 없습니다. 그래서 상호명과 cuisine 태그에 드러난
  // 대표메뉴를 찾아 1인 기준 시세를 붙입니다. 실제 가격은 카카오맵에서 확인하도록 안내합니다.
  const MENU_PRICES = [
    [/omakase|오마카세/, "오마카세", 60000],
    [/이자카야|izakaya/, "안주 한 상", 25000],
    [/훠궈|hot_?pot/, "훠궈", 25000],
    [/양꼬치/, "양꼬치", 20000],
    [/스테이크|steak/, "스테이크", 32000],
    [/족발|보쌈/, "족발·보쌈", 22000],
    [/아구찜|해물찜/, "아구찜", 22000],
    [/갈비(?!탕)/, "갈비", 20000],
    [/갈비탕/, "갈비탕", 11000],
    [/삼계탕|samgyetang/, "삼계탕", 18000],
    [/초밥|스시|sushi/, "초밥 세트", 20000],
    [/탕수육/, "탕수육", 20000],
    [/치킨|chicken/, "후라이드 치킨", 20000],
    [/피자|pizza/, "피자", 19000],
    [/삼겹살|고깃집|정육식당|barbecue/, "삼겹살 1인분", 17000],
    [/브런치|brunch/, "브런치 플레이트", 18000],
    [/파스타|pasta|스파게티|리조또/, "파스타", 16000],
    [/낙지|곱창|막창/, "낙지·곱창 볶음", 16000],
    [/딤섬|dim_?sum/, "딤섬 세트", 14000],
    [/포케|poke/, "포케 볼", 13000],
    [/생선구이|장어/, "생선구이 정식", 13000],
    [/돈까스|돈카츠|tonkatsu|가츠/, "등심 돈까스", 12000],
    [/마라탕|마라샹궈|마라/, "마라탕", 12000],
    [/냉면/, "물냉면", 12000],
    [/추어탕/, "추어탕", 12000],
    [/한정식|백반|쌈밥/, "백반 정식", 12000],
    [/라멘|ramen/, "라멘", 11000],
    [/규동|덮밥|donburi|회덮밥/, "덮밥", 11000],
    [/샐러드|salad/, "샐러드 볼", 11000],
    [/설렁탕|곰탕/, "설렁탕", 11000],
    [/비빔밥|bibimbap/, "비빔밥", 10000],
    [/불고기|bulgogi/, "불고기 정식", 14000],
    [/감자탕/, "감자탕", 10000],
    [/해장국|국밥|순대국|gukbap/, "국밥", 10000],
    [/짬뽕/, "짬뽕", 10000],
    [/우동|소바|udon|soba/, "우동", 10000],
    [/찌개|전골|김치찜/, "김치찌개", 9500],
    [/칼국수|수제비/, "칼국수", 9500],
    [/버거|burger|hamburger/, "버거 세트", 9000],
    [/짜장|자장/, "짜장면", 8000],
    [/샌드위치|sandwich/, "샌드위치", 8000],
    [/만두|dumpling/, "만두", 8000],
    [/떡볶이|tteokbokki/, "떡볶이", 6000],
    [/김밥|kimbap|gimbap/, "김밥·분식 세트", 6000],
    [/라면/, "라면", 5000],
    [/토스트|핫도그/, "토스트", 4500],
  ];

  const CUISINE_DEFAULT_MENU = {
    한식: ["대표 한식 한 그릇", 11000],
    일식: ["대표 일식 한 그릇", 14000],
    중식: ["대표 중식 한 그릇", 9000],
    양식: ["대표 양식 한 접시", 16000],
    분식: ["대표 분식 세트", 6500],
    샐러드: ["대표 샐러드·포케", 11000],
  };

  function estimateMenu(tags, cuisine) {
    const text = `${tags["name:ko"] || ""} ${tags.name || ""} ${tags.cuisine || ""} ${tags.brand || ""}`.toLowerCase();
    const matched = MENU_PRICES.find(([pattern]) => pattern.test(text));
    if (matched) return { menu: matched[1], price: matched[2], fromName: true };

    // 패스트푸드는 같은 종류라도 단품 가격대가 낮아 업종 평균보다 먼저 적용합니다.
    if (tags.amenity === "fast_food") return { menu: "대표 단품", price: 8000, fromName: false };

    const fallback = CUISINE_DEFAULT_MENU[cuisine] || ["대표메뉴", 11000];
    return { menu: fallback[0], price: fallback[1], fromName: false };
  }

  function withinBudget(restaurant) {
    return restaurant.price <= state.criteria.budget;
  }

  // 예산을 먼저 맞추고, 그다음 선호 메뉴를 봅니다. 높은 값이 먼저 나옵니다.
  function selectionTier(restaurant) {
    return (withinBudget(restaurant) ? 4 : 0) + preferenceRank(restaurant.cuisine);
  }

  function searchRadius() {
    if (state.criteria.time <= 40) return 1200;
    if (state.criteria.time <= 60) return 2000;
    return 3000;
  }

  function distanceInMeters(lat1, lon1, lat2, lon2) {
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const earthRadius = 6371000;
    const deltaLat = toRadians(lat2 - lat1);
    const deltaLon = toRadians(lon2 - lon1);
    const a = Math.sin(deltaLat / 2) ** 2
      + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2;
    return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }

  function osmAddress(tags = {}) {
    if (tags["addr:full"]) return tags["addr:full"];
    const parts = [tags["addr:city"], tags["addr:district"], tags["addr:street"], tags["addr:housenumber"]].filter(Boolean);
    return parts.join(" ");
  }

  // 같은 가게가 노드와 건물(way)로 두 번 등록된 경우를 걸러내기 위한 반경입니다.
  const DUPLICATE_RADIUS_M = 200;
  const DECK_SIZE = 30;
  const MAX_SAME_CUISINE_RUN = 2;
  const DRAG_THRESHOLD_PX = 6;

  function nameKeyOf(name) {
    return String(name).toLowerCase().replace(/[\s·.,'"`()\[\]\-_&]/g, "");
  }

  function amenityLabel(amenity) {
    if (amenity === "fast_food") return "패스트푸드";
    if (amenity === "food_court") return "푸드코트";
    return "음식점";
  }

  function commonsPhotoUrl(file) {
    const name = String(file).replace(/^file:/i, "").trim();
    return name ? `${COMMONS_FILE_URL}${encodeURIComponent(name)}?width=900` : null;
  }

  // OSM에 사진이 직접 달린 경우와 위키미디어에 연결된 경우만 실제 사진을 쓸 수 있습니다.
  function taggedPhoto(tags) {
    if (/^https:\/\//i.test(tags.image || "")) return { url: tags.image, credit: "OpenStreetMap" };
    if (/^file:/i.test(tags.wikimedia_commons || "")) {
      return { url: commonsPhotoUrl(tags.wikimedia_commons), credit: "Wikimedia Commons" };
    }
    return { url: null, credit: "" };
  }

  function toRestaurant(element) {
    const tags = element.tags || {};
    const lat = Number(element.lat ?? element.center?.lat);
    const lng = Number(element.lon ?? element.center?.lon);
    const name = tags["name:ko"] || tags.name;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const cuisine = deriveCuisine(tags);
    const [emoji, color] = cuisineStyle(cuisine);
    const distance = distanceInMeters(state.location.lat, state.location.lng, lat, lng);
    const { menu, price, fromName } = estimateMenu(tags, cuisine);
    const photo = taggedPhoto(tags);
    return {
      id: `${element.type}-${element.id}`,
      nameKey: nameKeyOf(name),
      name,
      cuisine,
      category: cuisine ? `${cuisine} · ${amenityLabel(tags.amenity)}` : amenityLabel(tags.amenity),
      distance,
      walkMinutes: Math.max(1, Math.ceil(distance / 70)),
      menu,
      price,
      priceFromName: fromName,
      phone: tags["contact:phone"] || tags.phone || "",
      address: osmAddress(tags),
      lat,
      lng,
      photoUrl: photo.url,
      photoCredit: photo.credit,
      wikidataId: tags.wikidata || tags["brand:wikidata"] || "",
      emoji,
      color,
    };
  }

  // 중복으로 걸러낸 쪽이 더 자세한 정보를 갖고 있을 수 있어 빈 항목만 채워 넣습니다.
  function mergeDuplicate(kept, dropped) {
    if (!kept.address && dropped.address) kept.address = dropped.address;
    if (!kept.phone && dropped.phone) kept.phone = dropped.phone;
    if (!kept.photoUrl && dropped.photoUrl) {
      kept.photoUrl = dropped.photoUrl;
      kept.photoCredit = dropped.photoCredit;
    }
    if (!kept.wikidataId && dropped.wikidataId) kept.wikidataId = dropped.wikidataId;
    if (!kept.priceFromName && dropped.priceFromName) {
      kept.menu = dropped.menu;
      kept.price = dropped.price;
      kept.priceFromName = true;
    }
    if (!kept.cuisine && dropped.cuisine) {
      kept.cuisine = dropped.cuisine;
      const [emoji, color] = cuisineStyle(dropped.cuisine);
      kept.emoji = emoji;
      kept.color = color;
      kept.category = `${dropped.cuisine} · ${kept.category.split(" · ").pop()}`;
    }
  }

  function dedupeRestaurants(list) {
    const accepted = [];
    list.forEach((restaurant) => {
      // 같은 상호라도 200m 밖이면 다른 지점이므로 둘 다 남깁니다.
      const existing = accepted.find((item) => item.nameKey === restaurant.nameKey
        && distanceInMeters(item.lat, item.lng, restaurant.lat, restaurant.lng) <= DUPLICATE_RADIUS_M);
      if (existing) {
        mergeDuplicate(existing, restaurant);
        return;
      }
      accepted.push(restaurant);
    });
    return accepted;
  }

  // 거리순을 유지하되, 같은 종류가 3개 이상 연달아 나오면 다른 종류를 먼저 끼워 넣습니다.
  function spreadCuisines(list) {
    const pending = [...list];
    const ordered = [];
    let runCuisine = null;
    let runLength = 0;

    while (pending.length) {
      let pick = 0;
      if (runLength >= MAX_SAME_CUISINE_RUN) {
        const alternative = pending.findIndex((item) => (item.cuisine || "기타") !== runCuisine);
        if (alternative > -1) pick = alternative;
      }
      const [next] = pending.splice(pick, 1);
      const key = next.cuisine || "기타";
      runLength = key === runCuisine ? runLength + 1 : 1;
      runCuisine = key;
      ordered.push(next);
    }
    return ordered;
  }

  function convertOsmElements(elements) {
    const byId = new Map();
    elements.forEach((element) => {
      const restaurant = toRestaurant(element);
      if (restaurant && !byId.has(restaurant.id)) byId.set(restaurant.id, restaurant);
    });

    const nearestFirst = [...byId.values()].sort((a, b) => a.distance - b.distance);
    const unique = dedupeRestaurants(nearestFirst);

    const tiers = [...new Set(unique.map(selectionTier))].sort((a, b) => b - a);
    return tiers
      .flatMap((tier) => spreadCuisines(unique.filter((item) => selectionTier(item) === tier)))
      .slice(0, DECK_SIZE);
  }

  async function fetchNearbyRestaurants() {
    const { lat, lng } = state.location;
    const radius = searchRadius();
    const query = `[out:json][timeout:15];nwr["amenity"~"^(restaurant|fast_food|food_court)$"]["name"](around:${radius},${lat},${lng});out center 60;`;
    const endpoints = [
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
      "https://overpass.private.coffee/api/interpreter",
      "https://overpass-api.de/api/interpreter",
    ];
    let lastError;

    for (const endpoint of endpoints) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 18000);
      try {
        const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return convertOsmElements(data.elements || []);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(`주변 식당 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 눌러주세요. (${lastError?.name || "network"})`);
  }

  // 위키데이터에 연결된 곳(주로 체인점)은 대표 이미지를 가져올 수 있습니다. 한 번에 모아서 요청합니다.
  async function fetchWikidataPhotos(ids) {
    const params = new URLSearchParams({
      action: "wbgetentities",
      ids: ids.join("|"),
      props: "claims",
      format: "json",
      origin: "*",
    });
    const response = await fetch(`${WIKIDATA_ENDPOINT}?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    const photos = new Map();
    Object.entries(data.entities || {}).forEach(([id, entity]) => {
      const file = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (file) photos.set(id, commonsPhotoUrl(file));
    });
    return photos;
  }

  async function enrichPhotos(deck) {
    const pending = deck.filter((item) => !item.photoUrl && item.wikidataId);
    if (!pending.length) return;

    // wbgetentities는 한 번에 50개까지 받습니다.
    const ids = [...new Set(pending.map((item) => item.wikidataId))].slice(0, 50);
    try {
      const photos = await fetchWikidataPhotos(ids);
      let updated = false;
      pending.forEach((item) => {
        const url = photos.get(item.wikidataId);
        if (!url) return;
        item.photoUrl = url;
        item.photoCredit = "Wikimedia Commons";
        updated = true;
      });
      // 카드를 넘기는 중에 다시 그리면 조작이 끊기므로 안정된 상태에서만 갱신합니다.
      if (updated && !state.animating && !state.dragging && $("#deck-view").classList.contains("active")) {
        renderDeck();
      }
    } catch {
      // 사진은 보조 정보라서 실패해도 카드는 그대로 보여줍니다.
    }
  }

  async function startSession(event) {
    event?.preventDefault();
    if (state.locating || state.loading) return;
    state.loading = true;
    const button = $("#start-button");
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = "<span>실제 주변 식당을 찾는 중…</span><span>⌖</span>";
    clearError();

    try {
      if (!state.location) await requestCurrentLocation();
      const restaurants = await fetchNearbyRestaurants();
      if (!restaurants.length) throw new Error(`${searchRadius()}m 안에서 음식점을 찾지 못했습니다. 검색 시간을 늘려 다시 시도해주세요.`);

      state.deck = restaurants;
      state.index = 0;
      state.sessionId = newSessionId();
      state.swipes = 0;
      state.startedAt = Date.now();
      state.chosen = null;
      state.rating = 0;
      state.feedbackTags = [];
      state.feedbackRecorded = false;
      usage.sessions += 1;
      recordEvent("session_started", {
        criteria: { ...state.criteria },
        resultCount: restaurants.length,
      });
      queueRow("sessions", {
        id: state.sessionId,
        deck_size: restaurants.length,
        budget: state.criteria.budget,
        time_limit: state.criteria.time,
        radius_m: searchRadius(),
        cuisines: state.criteria.cuisines,
        location_source: state.location.source,
        variant: VARIANT,
        app_version: SERVICE_VERSION,
      });
      renderCriteria();
      renderDeck();
      switchView("deck-view");
      enrichPhotos(state.deck);
    } catch (error) {
      showError(error.message || "주변 식당을 불러오지 못했습니다.");
    } finally {
      state.loading = false;
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  function renderCriteria() {
    const rows = [
      ["위치", state.location?.label || "내 현재 위치"],
      ["예산", `대표메뉴 ${formatPrice(state.criteria.budget)} 이하`],
      ["검색 반경", `${searchRadius().toLocaleString("ko-KR")}m`],
      ["우선 메뉴", state.criteria.cuisines.join(" · ")],
    ];
    $("#criteria-list").innerHTML = rows.map(([label, value]) => `
      <div class="criteria-item"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>
    `).join("");
  }

  function photoMarkup(restaurant, className) {
    if (!restaurant.photoUrl) return "";
    return `<img class="${className}" src="${escapeHTML(restaurant.photoUrl)}" alt="${escapeHTML(restaurant.name)} 사진" loading="lazy" referrerpolicy="no-referrer" />`;
  }

  // 이미지가 실제로 뜬 뒤에만 이모지 대신 사진을 보여주고, 깨지면 조용히 되돌립니다.
  function bindPhotoFallback(root) {
    $$("img.food-photo, img.chosen-photo", root).forEach((image) => {
      if (image.complete && image.naturalWidth) {
        image.classList.add("is-loaded");
        return;
      }
      image.addEventListener("load", () => image.classList.add("is-loaded"));
      image.addEventListener("error", () => image.remove());
    });
  }

  function cardMarkup(restaurant, position) {
    const preferred = state.criteria.cuisines.includes(restaurant.cuisine);
    const affordable = withinBudget(restaurant);
    return `
      <article class="restaurant-card" data-id="${escapeHTML(restaurant.id)}" data-position="${position}" style="--card-color:${restaurant.color}" tabindex="0" role="button" aria-label="${escapeHTML(restaurant.name)} 선택하기">
        <div class="food-visual">
          <span class="pick-hint">${position + 1}</span>
          ${photoMarkup(restaurant, "food-photo")}
          <span class="food-emoji" aria-hidden="true">${restaurant.emoji}</span>
          ${restaurant.photoCredit ? `<span class="photo-credit">사진 · ${escapeHTML(restaurant.photoCredit)}</span>` : ""}
        </div>
        <div class="card-body">
          <div class="card-title-row">
            <div><h3>${escapeHTML(restaurant.name)}</h3><p class="category">${escapeHTML(restaurant.category)}</p></div>
            <div class="price"><strong>${formatPrice(restaurant.price)}</strong><small>${escapeHTML(restaurant.menu)} 예상</small></div>
          </div>
          <div class="fit-badges">
            <span class="highlight">${restaurant.distance.toLocaleString("ko-KR")}m · 도보 ${restaurant.walkMinutes}분</span>
            <span class="${affordable ? "budget-ok" : "budget-over"}">${affordable ? "예산 내" : "예산 초과"}</span>
            ${preferred ? `<span>${escapeHTML(restaurant.cuisine)} 취향</span>` : ""}
          </div>
          <div class="card-footer">
            <span>${escapeHTML(displayAddress(restaurant.address))}</span>
            <a href="${kakaoMapUrl(restaurant)}" target="_blank" rel="noopener">메뉴·가격 ↗</a>
          </div>
          <span class="pick-cta">이 식당으로 결정 →</span>
        </div>
      </article>`;
  }

  function currentPair() {
    return state.deck.slice(state.index, state.index + PAIR_SIZE);
  }

  function renderDeck() {
    const total = state.deck.length;
    const pair = currentPair();
    const shown = Math.min(total, state.index + pair.length);
    $("#deck-progress-label").textContent = state.index >= total ? "모두 확인했어요" : `${shown} / ${total}`;
    $("#deck-progress-bar").style.width = `${total ? Math.min(100, (shown / total) * 100) : 0}%`;

    if (!pair.length) {
      renderDeckComplete();
      $("#swipe-controls").hidden = true;
      return;
    }

    $("#swipe-controls").hidden = false;
    $("#deck-stage").innerHTML = `
      <div class="card-pair${pair.length === 1 ? " single" : ""}" id="card-pair">
        ${pair.map((restaurant, position) => cardMarkup(restaurant, position)).join("")}
      </div>`;
    bindPhotoFallback($("#deck-stage"));
    attachPairGestures($("#card-pair"));
  }

  function renderDeckComplete() {
    $("#deck-stage").innerHTML = `
      <div class="deck-complete">
        <span>🍽️</span>
        <h3>주변 식당을 모두 봤어요</h3>
        <p class="deck-complete-note">한 곳도 고르지 않으셨네요.</p>
        <p>같은 조건으로 처음부터 다시 보거나 조건을 넓혀 검색할 수 있어요.</p>
        <div class="choice-list">
          <button class="primary-button" id="replay-deck" type="button"><span>처음부터 다시 보기</span><span>↻</span></button>
          <button class="text-button result-restart" id="change-conditions" type="button">조건을 바꿔 다시 검색하기</button>
        </div>
      </div>`;
    $("#replay-deck").addEventListener("click", () => {
      state.index = 0;
      renderDeck();
    });
    $("#change-conditions").addEventListener("click", returnToSetup);
  }

  // 두 장을 한 묶음으로 다룹니다. 밀면 두 곳 모두 넘기고, 카드를 누르면 그 곳으로 정합니다.
  function attachPairGestures(pair) {
    if (!pair) return;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let pointerId = null;
    let pressing = false;
    let captured = false;

    pair.addEventListener("pointerdown", (event) => {
      if (state.animating) return;
      // 링크 위에서 시작한 누름은 드래그로 보지 않습니다. 포인터를 가로채면
      // 브라우저가 click을 이쪽으로 돌려버려서 링크가 열리지 않습니다.
      if (event.target.closest("a")) return;
      pointerId = event.pointerId;
      pressing = true;
      startX = event.clientX;
      startY = event.clientY;
    });

    pair.addEventListener("pointermove", (event) => {
      if (!pressing || event.pointerId !== pointerId) return;
      dx = event.clientX - startX;
      const dy = event.clientY - startY;

      // 실제로 움직인 뒤에야 포인터를 가져옵니다. 그래야 짧게 누르는 동작이 클릭으로 남습니다.
      if (!captured) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        captured = true;
        state.dragging = true;
        pair.setPointerCapture(pointerId);
        pair.style.transition = "none";
      }
      pair.style.transform = `translate(${dx}px, ${dy * .12}px) rotate(${dx / 60}deg)`;
      pair.style.opacity = `${Math.max(.35, 1 - Math.abs(dx) / 320)}`;
    });

    const release = () => {
      if (!pressing) return;
      const dragged = captured;
      pressing = false;
      captured = false;
      state.dragging = false;
      pointerId = null;

      if (!dragged) {
        dx = 0;
        return; // 움직이지 않았으면 클릭이 그대로 진행되게 둡니다.
      }

      pair.style.transition = "";
      if (Math.abs(dx) >= 85) {
        passPair("drag", dx > 0 ? 1 : -1);
      } else {
        pair.style.transform = "";
        pair.style.opacity = "";
      }
      dx = 0;
    };
    pair.addEventListener("pointerup", release);
    pair.addEventListener("pointercancel", release);

    pair.addEventListener("click", (event) => {
      if (event.target.closest("a")) return; // 지도 링크는 선택으로 치지 않습니다.
      const card = event.target.closest(".restaurant-card");
      if (card) choosePair(Number(card.dataset.position), "card");
    });

    pair.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest(".restaurant-card");
      if (!card) return;
      event.preventDefault();
      choosePair(Number(card.dataset.position), "keyboard");
    });
  }

  // 넘긴 두 곳을 각각 한 줄씩 남깁니다. 어떤 조합에서 넘어갔는지 보려면 둘 다 필요합니다.
  function passPair(input = "button", direction = -1) {
    if (state.animating) return;
    const pair = currentPair();
    if (!pair.length) return;

    state.animating = true;
    $("#card-pair")?.classList.add(direction > 0 ? "fly-right" : "fly-left");

    pair.forEach((restaurant, position) => {
      queueRow("swipes", {
        session_id: state.sessionId,
        deck_index: state.index + position,
        pair_position: position,
        action: "pass",
        input,
        ...restaurantColumns(restaurant),
      });
      usage.passes += 1;
      recordEvent("restaurant_passed", { restaurantId: restaurant.id, input });
    });

    state.swipes += 1;
    setTimeout(() => {
      state.index += pair.length;
      state.animating = false;
      renderDeck();
    }, 260);
  }

  function choosePair(position, input = "card") {
    if (state.animating || !Number.isInteger(position)) return;
    const pair = currentPair();
    const restaurant = pair[position];
    if (!restaurant) return;

    state.animating = true;
    $$(".restaurant-card", $("#deck-stage")).forEach((card, index) => {
      card.classList.add(index === position ? "card-chosen" : "card-dropped");
    });

    usage.selections += 1;
    state.chosen = restaurant;
    const decisionMs = Date.now() - state.startedAt;

    queueRow("swipes", {
      session_id: state.sessionId,
      deck_index: state.index + position,
      pair_position: position,
      action: "choose",
      input,
      ...restaurantColumns(restaurant),
    });
    recordEvent("restaurant_selected", { restaurantId: restaurant.id, input, decisionMs });
    queueRow("picks", {
      session_id: state.sessionId,
      swipes_before: state.swipes,
      deck_index: state.index + position,
      pair_position: position,
      // 두 곳씩 보여주면 넘긴 횟수만으로는 예전 버전과 비교가 안 됩니다.
      // 고르기까지 실제로 본 식당 수를 따로 남겨 두 버전을 같은 잣대로 봅니다.
      cards_seen: state.index + position + 1,
      deck_size: state.deck.length,
      decision_ms: decisionMs,
      input,
      ...restaurantColumns(restaurant),
    });

    setTimeout(() => {
      state.animating = false;
      renderResult();
      switchView("result-view");
    }, 280);
  }

  function renderResult() {
    const item = state.chosen;
    $("#chosen-card").innerHTML = `
      <div class="chosen-visual" style="--chosen-color:${item.color}">
        ${photoMarkup(item, "chosen-photo")}
        <span aria-hidden="true">${item.emoji}</span>
        ${item.photoCredit ? `<span class="photo-credit">사진 · ${escapeHTML(item.photoCredit)}</span>` : ""}
      </div>
      <div class="chosen-info">
        <p class="step-label">ACTUAL PLACE</p>
        <h3>${escapeHTML(item.name)}</h3>
        <p>${escapeHTML(item.category)} · ${escapeHTML(displayAddress(item.address))}</p>
        <div class="chosen-meta"><span>${escapeHTML(item.menu)} 약 ${formatPrice(item.price)}</span><span>${item.distance.toLocaleString("ko-KR")}m · 도보 약 ${item.walkMinutes}분</span><span>${escapeHTML(displayPhone(item.phone))}</span></div>
        <p class="chosen-reason">대표메뉴 ${escapeHTML(item.menu)}를 ${formatPrice(item.price)}로 잡아 예산 ${formatPrice(state.criteria.budget)} 조건과 맞춰본 결과예요. 시세 기반 추정치라 카카오맵에서 실제 메뉴판을 꼭 확인해주세요.</p>
        <div class="chosen-links"><a class="kakao-detail-button" href="${kakaoMapUrl(item)}" target="_blank" rel="noopener">카카오맵에서 메뉴·가격 보기 <span>↗</span></a><a href="${kakaoDirectionsUrl(item)}" target="_blank" rel="noopener">길찾기</a></div>
      </div>`;
    bindPhotoFallback($("#chosen-card"));
    state.rating = 0;
    state.feedbackTags = [];
    $$("#rating button").forEach((button) => button.classList.remove("selected"));
    $$("#feedback-tags button").forEach((button) => button.classList.remove("selected"));
    $("#save-feedback").disabled = true;
    $("#save-feedback").textContent = "만족도 저장하기";
  }

  function selectRating(value) {
    state.rating = value;
    $$("#rating button").forEach((button) => button.classList.toggle("selected", Number(button.dataset.rating) <= value));
    $("#save-feedback").disabled = false;
  }

  function toggleFeedbackTag(button) {
    button.classList.toggle("selected");
    state.feedbackTags = $$("#feedback-tags button.selected").map((item) => item.dataset.value);
  }

  function saveFeedback() {
    if (!state.rating || state.feedbackRecorded) return;
    state.feedbackRecorded = true;
    usage.feedback.push({ restaurantId: state.chosen.id, rating: state.rating, tags: [...state.feedbackTags], at: Date.now() });
    usage.feedback = usage.feedback.slice(-100);
    recordEvent("feedback_saved", { restaurantId: state.chosen.id, rating: state.rating, tags: [...state.feedbackTags] });
    queueRow("feedback", {
      session_id: state.sessionId,
      rating: state.rating,
      tags: [...state.feedbackTags],
    });
    $("#save-feedback").disabled = true;
    $("#save-feedback").textContent = "저장 완료 ✓";
    showToast("평가를 저장했어요. 다음 추천에 반영할게요.");
  }

  function returnToSetup() {
    switchView("setup-view");
  }

  function bindEvents() {
    bindChoiceControls();
    $("#location-button").addEventListener("click", () => requestCurrentLocation().catch((error) => showError(error.message)));
    $("#location-search").addEventListener("click", searchLocation);
    $("#location-input").addEventListener("keydown", (event) => {
      // 입력칸이 폼 안에 있어서 엔터가 검색 대신 전체 제출로 새지 않도록 막습니다.
      if (event.key !== "Enter") return;
      event.preventDefault();
      searchLocation();
    });
    $("#location-results").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-index]");
      if (button) chooseLocationResult(Number(button.dataset.index));
    });
    $("#condition-form").addEventListener("submit", startSession);
    $("#pass-button").addEventListener("click", () => passPair("button"));
    $("#restart-setup").addEventListener("click", returnToSetup);
    $("#new-session").addEventListener("click", returnToSetup);
    $("#home-link").addEventListener("click", (event) => { event.preventDefault(); returnToSetup(); });
    $("#rating").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-rating]");
      if (button) selectRating(Number(button.dataset.rating));
    });
    $("#feedback-tags").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (button) toggleFeedbackTag(button);
    });
    $("#save-feedback").addEventListener("click", saveFeedback);
    document.addEventListener("keydown", (event) => {
      if (!$("#deck-view").classList.contains("active")) return;
      // 좌우는 두 곳 모두 넘기고, 1·2 는 왼쪽·오른쪽 선택입니다.
      if (event.key === "ArrowLeft") { event.preventDefault(); passPair("keyboard", -1); }
      if (event.key === "ArrowRight") { event.preventDefault(); passPair("keyboard", 1); }
      if (event.key === "1") { event.preventDefault(); choosePair(0, "keyboard"); }
      if (event.key === "2") { event.preventDefault(); choosePair(1, "keyboard"); }
    });
  }

  function init() {
    bindEvents();
    // 출발 위치를 직접 고를 수 있으므로 접속하자마자 위치 권한을 묻지 않습니다.
    $("#data-source-note").textContent = "OpenStreetMap 실제 장소 데이터 · 가격은 대표메뉴 시세 기준 추정치";
    // 지난 접속에서 못 보낸 기록이 있으면 먼저 정리합니다.
    flushPending();
    window.addEventListener("pagehide", flushPending);
  }

  init();
})();
