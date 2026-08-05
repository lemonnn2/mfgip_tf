/* =====================================================================
   가품 매장 침해대응 지도
   - 카카오 지도(services 라이브러리로 주소→좌표 지오코딩)
   - 엑셀/CSV 업로드로 데이터 갱신 (코드 수정 불필요)
   - 검색 / 필터 / 반경 조절 / 반경 내 상대매장 분석
   - 업로드 데이터는 브라우저(localStorage)에 저장되어 새로고침해도 유지
   ===================================================================== */

const DATA_FILE = "./map-data.json";
const STORAGE_KEY = "fakeStoreMapData_v1";

/* ---- 관리자 설정 ----
   ⚠️ 정적 사이트 특성상 이 비밀번호는 완벽한 보안이 아닙니다(사내 실무자 구분용).
   진짜 보안이 필요하면 배포 후 플랫폼 접근제어(로그인 계정 기반)를 사용하세요. */
const ADMIN_PASSWORD = "admin1234";           // 여기서 관리자 비밀번호를 변경하세요
const ADMIN_SESSION_KEY = "fakeStoreAdmin_v1";
let isAdmin = false;

/* ---- 상태 ---- */
let map;
let geocoder = null;

let fakeStores = [];
let ourStores = [];

let fakeMarkers = [];
let ourMarkers = [];
let fakeMarkerMap = new Map();
let ourMarkerMap = new Map();

let radiusCircle = null;
let radiusKm = 5;

// 마커 클러스터러 (정품매장=파랑 계열, 가품매장=빨강 계열)
let ourClusterer = null;
let fakeClusterer = null;

/* =====================================================================
   1. 카카오 SDK 로드
   ===================================================================== */
function loadKakaoSdk() {
  return new Promise((resolve, reject) => {
    const key = window.KAKAO_JAVASCRIPT_KEY;
    if (!key || key === "YOUR_KAKAO_JAVASCRIPT_KEY") {
      reject(new Error("카카오 JavaScript 키를 index.html 에 입력하세요."));
      return;
    }
    const script = document.getElementById("kakao-sdk");
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${key}&autoload=false&libraries=services,clusterer`;
    script.onload = () => {
      if (!window.kakao || !window.kakao.maps) {
        reject(new Error("카카오맵 객체를 찾지 못했습니다."));
        return;
      }
      kakao.maps.load(() => resolve());
    };
    script.onerror = () => reject(new Error("카카오맵 SDK 로드 실패 (도메인 등록/키 확인)"));
  });
}

/* =====================================================================
   2. 데이터 로드 (localStorage 우선 → 없으면 map-data.json)
   ===================================================================== */
async function loadData() {
  const saved = loadFromStorage();
  let base = null;
  try {
    const res = await fetch(DATA_FILE, { cache: "no-store" });
    if (res.ok) base = await res.json();
  } catch (e) {
    console.warn("기본 데이터(map-data.json) 로드 실패", e);
  }

  // 브라우저 저장본과 저장소 파일 중 더 최신 데이터 사용
  // (내려받은 map-data.json을 저장소에 덮어쓰면 exportedAt이 갱신됨)
  const savedAt = saved && saved.savedAt ? saved.savedAt : 0;
  const baseAt = base && base.exportedAt ? base.exportedAt : 0;
  const use = saved && savedAt >= baseAt ? saved : base;

  fakeStores = (use && use.fakeStores) || [];
  ourStores = (use && use.ourStores) || [];
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fakeStores, ourStores, savedAt: Date.now() }));
  } catch (e) { console.warn("저장 실패", e); }
}
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/* =====================================================================
   3. 지도 초기화
   ===================================================================== */
function initMap() {
  const mapContainer = document.getElementById("map");
  const center = new kakao.maps.LatLng(36.5, 127.8); // 전국 중심
  map = new kakao.maps.Map(mapContainer, { center, level: 12 });
  geocoder = new kakao.maps.services.Geocoder();

  kakao.maps.event.addListener(map, "click", () => clearSelection());

  // 줌 레벨이 바뀌면 마커 크기를 자동으로 조절
  kakao.maps.event.addListener(map, "zoom_changed", () => refreshMarkerSizes());

  // 마커 클러스터러 생성 (개별 마커가 가까이 있으면 숫자 뭉치로 묶음)
  ourClusterer = new kakao.maps.MarkerClusterer({
    map, averageCenter: true, minLevel: 6, disableClickZoom: false,
    styles: clusterStyles("#007AFF")
  });
  fakeClusterer = new kakao.maps.MarkerClusterer({
    map, averageCenter: true, minLevel: 6, disableClickZoom: false,
    styles: clusterStyles("#FF3B30")
  });

  setTimeout(() => { map.relayout(); }, 300);

  // 화면 리사이즈/회전 시 지도 재정렬 (중심 유지)
  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const c = map.getCenter();
      map.relayout();
      map.setCenter(c);
    }, 200);
  });
}

/* =====================================================================
   4. 마커
   ===================================================================== */
/* 클러스터 뱃지 스타일 (개수 구간별 크기). color=매장 색상 */
function clusterStyles(color) {
  const base = {
    color: "#fff",
    textAlign: "center",
    fontWeight: "800",
    borderRadius: "999px",
    border: "2px solid rgba(255,255,255,0.85)",
    boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
    background: color
  };
  const make = (size, font) => ({
    ...base,
    width: size + "px",
    height: size + "px",
    lineHeight: size + "px",
    fontSize: font + "px",
    opacity: "0.92"
  });
  return [
    make(34, 12),  // ~10개
    make(42, 13),  // ~100개
    make(52, 14),  // ~1000개
    make(62, 15)   // 그 이상
  ];
}

/* 줌 레벨(1=최대확대 ~ 14=최대축소)에 따라 마커 픽셀 크기 계산.
   확대할수록 크게, 축소할수록 작게(점처럼). */
function markerWidthForLevel(level) {
  const lv = Number(level) || 8;
  if (lv <= 4) return 34;   // 동네 단위 확대
  if (lv <= 6) return 28;
  if (lv <= 8) return 22;
  if (lv <= 10) return 16;
  if (lv <= 12) return 11;  // 전국 보기
  return 8;                 // 최대 축소
}

// 이미지 캐시: `${color}_${width}` → MarkerImage
const markerImageCache = new Map();

function markerImage(color, width) {
  const w = width || 22;
  const key = `${color}_${w}`;
  if (markerImageCache.has(key)) return markerImageCache.get(key);

  const h = Math.round(w * 48 / 36); // 원본 비율 유지
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 36 48">
      <path d="M18 0C8.1 0 0 8.1 0 18c0 13.5 18 30 18 30s18-16.5 18-30C36 8.1 27.9 0 18 0z" fill="${color}"/>
      <circle cx="18" cy="18" r="6.5" fill="white"/>
    </svg>`;
  const url = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
  const img = new kakao.maps.MarkerImage(url, new kakao.maps.Size(w, h), {
    offset: new kakao.maps.Point(Math.round(w / 2), h)
  });
  markerImageCache.set(key, img);
  return img;
}

/* 현재 줌 레벨에 맞춰 모든 마커 이미지 크기 갱신 */
function refreshMarkerSizes() {
  if (!map) return;
  const w = markerWidthForLevel(map.getLevel());

  const fakeOpenImg = markerImage("#FF3B30", w);
  const fakeClosedImg = markerImage("#8e8e93", w);
  const ourImg = markerImage("#007AFF", w);

  fakeMarkers.forEach(m => {
    m.setImage(m.__closed ? fakeClosedImg : fakeOpenImg);
  });
  ourMarkers.forEach(m => m.setImage(ourImg));
}

function renderMarkers() {
  clearMarkers();

  const visibleFake = getVisibleFakeStores();
  const visibleOur = getVisibleOurStores();

  const w = markerWidthForLevel(map.getLevel());
  const fakeOpenImg = markerImage("#FF3B30", w);
  const fakeClosedImg = markerImage("#8e8e93", w);
  const ourImg = markerImage("#007AFF", w);

  visibleFake.forEach(store => {
    if (!isValidCoordinate(store.lat, store.lng)) return;
    const closed = isClosed(store);
    const marker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(store.lat, store.lng),
      title: store.name, image: closed ? fakeClosedImg : fakeOpenImg
    });
    marker.__closed = closed; // 줌 변경 시 색상 유지용
    kakao.maps.event.addListener(marker, "click", () => selectFakeStore(store));
    fakeMarkers.push(marker);
    fakeMarkerMap.set(getStoreKey(store), marker);
  });

  visibleOur.forEach(store => {
    if (!isValidCoordinate(store.lat, store.lng)) return;
    const marker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(store.lat, store.lng),
      title: store.name, image: ourImg
    });
    kakao.maps.event.addListener(marker, "click", () => selectOurStore(store));
    ourMarkers.push(marker);
    ourMarkerMap.set(getStoreKey(store), marker);
  });

  // 클러스터러에 마커 등록 (지도 표시는 클러스터러가 관리)
  if (fakeClusterer) fakeClusterer.addMarkers(fakeMarkers);
  if (ourClusterer) ourClusterer.addMarkers(ourMarkers);

  renderOurStoreList(visibleOur);
  renderFakeStoreList(visibleFake);
  updateMetrics();
  updateFilterPill(visibleFake.length);
}

/* 필터·검색으로 지도에서 숨겨진 가품매장 수를 배지로 알림 */
function updateFilterPill(visibleCount) {
  const pill = document.getElementById("filterPill");
  if (!pill) return;
  const hidden = fakeStores.length - visibleCount;
  if (hidden > 0) {
    pill.innerHTML = `필터로 가품매장 <b>${hidden}개</b> 숨김 · 전체 보기 ↺`;
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }
}

function clearMarkers() {
  if (fakeClusterer) fakeClusterer.clear();
  if (ourClusterer) ourClusterer.clear();
  fakeMarkers.forEach(m => m.setMap(null));
  ourMarkers.forEach(m => m.setMap(null));
  fakeMarkers = []; ourMarkers = [];
  fakeMarkerMap = new Map(); ourMarkerMap = new Map();
}

function clearSelection() {
  if (radiusCircle) { radiusCircle.setMap(null); radiusCircle = null; }
  hideDetail();
}

/* =====================================================================
   5. 검색 / 필터
   ===================================================================== */
function getSearchTerm() {
  return (document.getElementById("searchInput").value || "").trim().toLowerCase();
}

function matchSearch(store) {
  const term = getSearchTerm();
  if (!term) return true;
  const haystack = [
    store.name, store.address, store.product, store.area,
    store.type, store.code, store.channel, store.note
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(term);
}

function getVisibleFakeStores() {
  const type = document.getElementById("typeFilter").value;
  const operating = document.getElementById("operatingFilter").value;
  const area = document.getElementById("areaFilter").value;

  return fakeStores.filter(s => {
    const typeOk = type === "ALL" || s.type === type;
    const opOk = operating === "ALL" || operatingLabel(s) === operating;
    const areaOk = area === "ALL" || s.area === area;
    return typeOk && opOk && areaOk && matchSearch(s);
  });
}

function getVisibleOurStores() {
  // 정품매장은 검색어에만 반응 (필터는 가품 대상)
  return ourStores.filter(matchSearch);
}

function populateFilters() {
  fillSelect("typeFilter", "유형 전체", uniq(fakeStores.map(s => s.type)));
  fillSelect("operatingFilter", "영업여부 전체", uniq(fakeStores.map(operatingLabel)));
  fillSelect("areaFilter", "상권 전체", uniq(fakeStores.map(s => s.area)));
  buildChips();
}

/* 지도 상단 카테고리 칩 = 가품매장 유형(단기행사/입점매장 등) */
function buildChips() {
  const bar = document.getElementById("chipBar");
  const types = uniq(fakeStores.map(s => s.type));
  bar.innerHTML = `<button type="button" class="chip active" data-chip="ALL">전체</button>`;
  types.forEach(t => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.dataset.chip = t;
    b.textContent = t;
    bar.appendChild(b);
  });
  bar.querySelectorAll(".chip").forEach(chip => {
    chip.onclick = () => {
      bar.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      // 칩 = 유형 필터와 동기화
      document.getElementById("typeFilter").value = chip.dataset.chip;
      showFakeListTab();
      clearSelection();
      renderMarkers();
    };
  });
}

/* 필터는 가품매장 대상이므로, 결과가 보이도록 가품매장 목록 탭 활성화 */
function showFakeListTab() {
  const tab = document.querySelector('.list-tab[data-list="fake"]');
  if (tab && !tab.classList.contains("active")) tab.click();
}

function fillSelect(id, allLabel, values) {
  const el = document.getElementById(id);
  el.innerHTML = `<option value="ALL">${allLabel}</option>`;
  values.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v;
    el.appendChild(opt);
  });
}

function uniq(arr) {
  return [...new Set(arr.filter(v => v !== undefined && v !== null && String(v).trim() !== ""))];
}

function bindControls() {
  const rerender = () => { clearSelection(); renderMarkers(); };

  // 필터 셀렉트 (유형 셀렉트는 칩과도 동기화)
  // 필터는 가품매장 대상 → 변경 시 가품매장 목록 탭으로 전환해 결과가 바로 보이게 함
  ["typeFilter", "operatingFilter", "areaFilter"].forEach(id => {
    document.getElementById(id).onchange = () => {
      if (id === "typeFilter") syncChipsFromSelect();
      showFakeListTab();
      rerender();
    };
  });

  // 검색어 입력 + 지우기 버튼
  const searchInput = document.getElementById("searchInput");
  const searchClear = document.getElementById("searchClear");
  let t;
  searchInput.addEventListener("input", () => {
    searchClear.hidden = !searchInput.value;
    clearTimeout(t);
    t = setTimeout(rerender, 200);
  });
  searchClear.onclick = () => {
    searchInput.value = ""; searchClear.hidden = true; rerender();
  };

  // 반경 슬라이더
  const range = document.getElementById("radiusRange");
  range.addEventListener("input", () => {
    radiusKm = Number(range.value);
    document.getElementById("radiusLabel").textContent = radiusKm;
    renderMarkers();
  });

  // 초기화
  document.getElementById("resetBtn").onclick = () => {
    searchInput.value = ""; searchClear.hidden = true;
    ["typeFilter", "operatingFilter", "areaFilter"]
      .forEach(id => (document.getElementById(id).value = "ALL"));
    syncChipsFromSelect();
    clearSelection();
    renderMarkers();
    fitAllMarkers();
  };

  // 목록 탭 전환
  document.querySelectorAll(".list-tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll(".list-tab").forEach(x => x.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.dataset.list;
      document.getElementById("ourStoreList").hidden = which !== "our";
      document.getElementById("fakeStoreList").hidden = which !== "fake";
    };
  });

  // 좌측 레일/하단 탭바: 뷰 전환
  document.querySelectorAll('.rail-item[data-view]').forEach(item => {
    item.onclick = () => {
      document.querySelectorAll(".rail-item[data-view]").forEach(x => x.classList.remove("active"));
      item.classList.add("active");
      const v = item.dataset.view;

      // '현황'은 대시보드 오버레이 표시
      if (v === "stats") { openStats(); return; }
      closeStats();

      // '지도'는 목록 패널을 닫고 지도를 본다 (특히 모바일)
      if (v === "map") {
        if (isMobile()) closeMobilePanel();
        else document.querySelector(".app").classList.add("panel-collapsed");
        setTimeout(() => map && map.relayout(), 300);
        return;
      }

      // '목록'은 검색·목록 패널 열기 (정품매장/가품매장 전환은 패널 안 탭에서)
      openPanel();
      // 모바일: peek 상태로는 목록이 가려지므로 시트를 완전히 펼침
      if (v === "list" && isMobile()) expandMobilePanel();
    };
  });

  // 현황 닫기 → 지도 보기로 복귀
  document.getElementById("statsClose").onclick = () => {
    closeStats();
    const mapItem = document.querySelector('.rail-item[data-view="map"]');
    document.querySelectorAll(".rail-item[data-view]").forEach(x => x.classList.remove("active"));
    if (mapItem) mapItem.classList.add("active");
  };

  // 패널 접기/펼치기
  document.getElementById("panelToggle").onclick = () => {
    document.querySelector(".app").classList.toggle("panel-collapsed");
    setTimeout(() => map && map.relayout(), 300);
  };

  // 지도 컨트롤: 줌
  document.getElementById("zoomIn").onclick = () => map && map.setLevel(map.getLevel() - 1);
  document.getElementById("zoomOut").onclick = () => map && map.setLevel(map.getLevel() + 1);

  // 지도 타입 전환
  document.querySelectorAll(".ctrl-btn[data-maptype]").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".ctrl-btn[data-maptype]").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      const type = btn.dataset.maptype === "HYBRID"
        ? kakao.maps.MapTypeId.HYBRID : kakao.maps.MapTypeId.ROADMAP;
      map.setMapTypeId(type);
    };
  });

  // 내 위치: 파란 점 마커를 찍고 그 위치로 확대 이동
  document.getElementById("locBtn").onclick = () => {
    if (!navigator.geolocation) { alert("이 브라우저는 위치 기능을 지원하지 않습니다."); return; }
    const btn = document.getElementById("locBtn");
    btn.classList.add("loading");
    navigator.geolocation.getCurrentPosition(
      pos => {
        btn.classList.remove("loading");
        btn.classList.add("active");
        showMyLocation(new kakao.maps.LatLng(pos.coords.latitude, pos.coords.longitude));
      },
      err => {
        btn.classList.remove("loading");
        const why = err && err.code === 1
          ? "브라우저에서 위치 권한을 허용해 주세요."
          : "위치 정보를 가져올 수 없습니다.";
        alert(why);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // 이 지역 다시 검색 = 전체 보기
  document.getElementById("searchHere").onclick = fitAllMarkers;

  // 필터 배지 클릭 = 필터·검색 초기화(전체 보기)
  document.getElementById("filterPill").onclick = () => document.getElementById("resetBtn").click();
}

/* 내 위치 마커 (파란 점 + 펄스) */
let myLocOverlay = null;
function showMyLocation(latlng) {
  if (myLocOverlay) { myLocOverlay.setMap(null); myLocOverlay = null; }
  const el = document.createElement("div");
  el.className = "my-loc";
  el.innerHTML = `
    <div class="my-loc-pulse"></div>
    <div class="my-loc-dot"></div>`;
  myLocOverlay = new kakao.maps.CustomOverlay({
    position: latlng, content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: 5
  });
  myLocOverlay.setMap(map);
  if (map.getLevel() > 5) map.setLevel(5);
  map.panTo(latlng);
}

/* 유형 셀렉트 값에 맞춰 상단 칩 active 동기화 */
function syncChipsFromSelect() {
  const val = document.getElementById("typeFilter").value;
  document.querySelectorAll(".chip").forEach(c => {
    c.classList.toggle("active", c.dataset.chip === val);
  });
  // 매칭되는 칩이 없으면 '전체' 칩 활성화(값이 ALL일 때)
  if (val === "ALL") {
    const all = document.querySelector('.chip[data-chip="ALL"]');
    if (all) all.classList.add("active");
  }
}

function openPanel() {
  const app = document.querySelector(".app");
  app.classList.remove("panel-collapsed");
  if (isMobile()) openMobilePanel();
  setTimeout(() => map && map.relayout(), 300);
}

/* =====================================================================
   6. 매장 선택 (반경 + 인포윈도우)
   ===================================================================== */
function selectOurStore(store) {
  if (!isValidCoordinate(store.lat, store.lng)) return;
  clearSelection();
  const center = new kakao.maps.LatLng(store.lat, store.lng);
  drawCircle(center, "#007AFF");

  const nearby = getNearby(store, fakeStores);
  showDetail(ourInfoHtml(store, nearby), center);
}

function selectFakeStore(store) {
  if (!isValidCoordinate(store.lat, store.lng)) return;
  clearSelection();
  const center = new kakao.maps.LatLng(store.lat, store.lng);
  drawCircle(center, isClosed(store) ? "#8e8e93" : "#FF3B30");

  const nearby = getNearby(store, ourStores);
  const impact = getImpactLevel(nearby);
  showDetail(fakeInfoHtml(store, nearby, impact), center);
}

/* 상세 카드를 열고, 클러스터가 묶여 있으면 풀리도록 확대.
   (기존 지도 위 인포윈도우 대체: 화면 고정 카드라 내부 스크롤이 지도와 분리됨) */
function showDetail(html, center) {
  const body = document.getElementById("detailBody");
  body.innerHTML = html;
  body.scrollTop = 0;
  document.getElementById("detailCard").hidden = false;

  // 모바일: 목록에서 선택하면 지도가 보이도록 패널을 닫음
  if (isMobile()) closeMobilePanel();
  // 클러스터 최소 레벨(6)보다 축소돼 있으면 개별 마커가 보이도록 확대
  if (map.getLevel() >= 6) map.setLevel(5, { anchor: center });
  setTimeout(() => {
    map.panTo(center);
    // 모바일: 하단 카드에 마커가 가리지 않도록 살짝 위로 이동
    if (isMobile()) setTimeout(() => map.panBy(0, 130), 340);
  }, isMobile() ? 320 : 0); // 패널 닫힘 애니메이션 후 relayout 반영
}

function hideDetail() {
  const card = document.getElementById("detailCard");
  if (card) card.hidden = true;
}

/* 상세 카드 닫기: X 버튼 / ESC / (모바일) 핸들 탭·아래로 스와이프 / 지도 클릭 */
function bindDetailCard() {
  document.getElementById("detailClose").onclick = clearSelection;
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !document.getElementById("detailCard").hidden) clearSelection();
  });

  const handle = document.getElementById("detailHandle");
  let startY = null;
  handle.addEventListener("touchstart", e => { startY = e.touches[0].clientY; }, { passive: true });
  handle.addEventListener("touchend", e => {
    if (startY == null) return;
    if (e.changedTouches[0].clientY - startY > 24) clearSelection();
    startY = null;
  });
  handle.addEventListener("click", clearSelection);
}

function drawCircle(center, color) {
  radiusCircle = new kakao.maps.Circle({
    center, radius: radiusKm * 1000,
    strokeWeight: 2, strokeColor: color, strokeOpacity: 0.9, strokeStyle: "solid",
    fillColor: color, fillOpacity: 0.12
  });
  radiusCircle.setMap(map);
}

function ourInfoHtml(store, nearbyFake) {
  const list = nearbyFake.length
    ? nearbyFake.map(item => `
      <div class="nearby-item">
        <div class="nearby-name">${esc(item.name)} <span class="store-meta">(${item.distanceKm.toFixed(2)}km)</span></div>
        <div>영업여부: ${operatingBadge(item)} · 유형: ${esc(item.type || "-")}</div>
        <div>판매상품: ${esc(item.product || "-")}</div>
        <div>주소: ${esc(item.address || "-")}</div>
      </div>`).join("")
    : `<div class="empty-nearby">반경 ${radiusKm}km 내 가품매장이 없습니다.</div>`;

  return `
    <div class="info-window">
      <div class="info-title"><span class="dot dot-blue"></span>${esc(store.name)}</div>
      <div class="info-row"><b>주소:</b> ${esc(store.address || "-")}</div>
      <div class="info-row"><b>${esc(store.salesMonth || "월")} 매출:</b> ${money(store.monthlySales)}</div>
      <div class="nearby-summary">반경 ${radiusKm}km 내 가품매장 ${nearbyFake.length}개</div>
      <div class="nearby-list">${list}</div>
    </div>`;
}

function fakeInfoHtml(store, nearbyOur, impact) {
  const list = nearbyOur.length
    ? nearbyOur.map(item => `
      <div class="nearby-item">
        <div class="nearby-name">${esc(item.name)} <span class="store-meta">(${item.distanceKm.toFixed(2)}km)</span></div>
        <div>${esc(item.salesMonth || "월")} 매출: ${money(item.monthlySales)}</div>
        <div>주소: ${esc(item.address || "-")}</div>
      </div>`).join("")
    : `<div class="empty-nearby">반경 ${radiusKm}km 내 정품매장이 없습니다.</div>`;

  const impactClass = impact === "높음" ? "impact-high" : impact === "중간" ? "impact-mid" : "impact-low";

  const row = (label, val) => val ? `<div class="info-row"><b>${label}:</b> ${esc(val)}</div>` : "";

  return `
    <div class="info-window">
      <div class="info-title"><span class="dot ${isClosed(store) ? "dot-gray" : "dot-red"}"></span>${esc(store.name || store.code || "가품매장")}</div>
      <div class="info-row"><b>영업여부:</b> ${operatingBadge(store)}</div>
      ${row("매장코드", store.code)}
      ${row("주소", store.address)}
      ${row("유형", store.type)}
      ${row("판매상품", store.product)}
      ${row("상권", store.area)}
      ${row("영업시작", store.openDate)}
      ${row("영업종료", store.closeDate)}
      ${row("인테리어유형", store.interior)}
      ${row("간판유형", store.signage)}
      ${row("비고", store.note)}
      <div class="nearby-summary">
        반경 ${radiusKm}km 내 정품매장 ${nearbyOur.length}개<br/>
        매출 영향도: <span class="${impactClass}">${impact}</span>
      </div>
      <div class="nearby-list">${list}</div>
    </div>`;
}

/* =====================================================================
   7. 거리 / 근접 / 영향도
   ===================================================================== */
function getNearby(base, stores) {
  return stores
    .filter(s => isValidCoordinate(s.lat, s.lng))
    .map(s => ({ ...s, distanceKm: distanceKm(base.lat, base.lng, s.lat, s.lng) }))
    .filter(s => s.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLng = toRad(Number(lng2) - Number(lng1));
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(d) { return d * Math.PI / 180; }

function getImpactLevel(nearbyStores) {
  const weighted = nearbyStores.reduce((sum, s) => {
    let w = 0;
    if (s.distanceKm <= 1) w = 1.0;
    else if (s.distanceKm <= 3) w = 0.7;
    else w = 0.4;
    return sum + Number(s.monthlySales || 0) * w;
  }, 0);
  if (nearbyStores.length >= 3 || weighted >= 150000000) return "높음";
  if (nearbyStores.length >= 1 || weighted >= 50000000) return "중간";
  return "낮음";
}

/* =====================================================================
   8. 목록 렌더
   ===================================================================== */
function renderOurStoreList(stores) {
  const list = document.getElementById("ourStoreList");
  document.getElementById("ourListCount").textContent = stores.length;
  list.innerHTML = "";
  if (!stores.length) { list.innerHTML = `<div class="store-meta">표시할 정품매장이 없습니다.</div>`; return; }

  stores.forEach(store => {
    const nearby = getNearby(store, fakeStores);
    const card = document.createElement("div");
    card.className = "store-card our";
    card.innerHTML = `
      <div class="store-name">${esc(store.name)}</div>
      <div class="store-meta">
        ${money(store.monthlySales)} · ${esc(store.address || "-")}<br/>
        ${radiusKm}km 내 가품매장 <b>${nearby.length}</b>개
      </div>`;
    card.onclick = () => selectOurStore(store);
    list.appendChild(card);
  });
}

function renderFakeStoreList(stores) {
  const list = document.getElementById("fakeStoreList");
  document.getElementById("fakeListCount").textContent = stores.length;
  list.innerHTML = "";
  if (!stores.length) { list.innerHTML = `<div class="store-meta">조건에 맞는 가품매장이 없습니다.</div>`; return; }

  stores.forEach(store => {
    const nearby = getNearby(store, ourStores);
    const card = document.createElement("div");
    card.className = "store-card fake" + (isClosed(store) ? " closed" : "");
    card.innerHTML = `
      <div class="store-name">${esc(store.name || store.code || "-")}</div>
      <div class="store-meta">
        ${operatingBadge(store)} ${store.type ? `<span class="badge badge-type">${esc(store.type)}</span>` : ""}<br/>
        ${store.product ? esc(store.product) + " · " : ""}${esc(store.area || store.address || "-")}<br/>
        ${radiusKm}km 내 정품매장 <b>${nearby.length}</b>개
      </div>`;
    card.onclick = () => selectFakeStore(store);
    list.appendChild(card);
  });
}

function updateMetrics() {
  const open = fakeStores.filter(s => !isClosed(s));
  document.getElementById("fakeOpenCount").textContent = open.length;
  document.getElementById("ourCount").textContent = ourStores.length;
  document.getElementById("fakeTotal").textContent = `/ 누적 ${fakeStores.length}`;

  // 운영중 매장의 유형별 구분 칩 + 종료 칩
  const byType = new Map();
  open.forEach(s => {
    const t = (String(s.type || "").trim() || "기타").replace(/\s*매장$/, "");
    byType.set(t, (byType.get(t) || 0) + 1);
  });
  const chips = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `<span class="mchip">${esc(t)} ${c}</span>`);
  chips.push(`<span class="mchip muted">종료 ${fakeStores.length - open.length}</span>`);
  document.getElementById("fakeBreakdown").innerHTML = chips.join("");
}

function fitAllMarkers() {
  clearSelection();
  const all = [...fakeStores, ...ourStores].filter(s => isValidCoordinate(s.lat, s.lng));
  if (!all.length) return;
  const bounds = new kakao.maps.LatLngBounds();
  all.forEach(s => bounds.extend(new kakao.maps.LatLng(s.lat, s.lng)));
  map.setBounds(bounds);
}

/* =====================================================================
   8.5 현황 대시보드 (업로드된 가품매장 데이터로 실시간 계산)
   ===================================================================== */
const REGION_SHORT = [
  ["서울특별시", "서울"], ["부산광역시", "부산"], ["대구광역시", "대구"], ["인천광역시", "인천"],
  ["광주광역시", "광주"], ["대전광역시", "대전"], ["울산광역시", "울산"], ["세종특별자치시", "세종"],
  ["경기도", "경기"], ["강원특별자치도", "강원"], ["강원도", "강원"],
  ["충청북도", "충북"], ["충청남도", "충남"], ["전라북도", "전북"], ["전북특별자치도", "전북"],
  ["전라남도", "전남"], ["경상북도", "경북"], ["경상남도", "경남"], ["제주특별자치도", "제주"], ["제주도", "제주"]
];
const REGION_NAMES = ["서울","부산","대구","인천","광주","대전","울산","세종","경기","강원","충북","충남","전북","전남","경북","경남","제주"];

function storeRegion(s) {
  const r = String(s.region || "").trim();
  if (r) return r;
  let addr = String(s.address || "").trim();
  for (const [long, short] of REGION_SHORT) {
    if (addr.startsWith(long)) return short;
  }
  const head = addr.slice(0, 2);
  return REGION_NAMES.includes(head) ? head : "기타";
}

/* 인입월 키 "YYYY-MM" (인입월 → 인입일자 → 영업시작일 순으로 사용) */
function storeMonth(s) {
  const v = String(s.inflowMonth || s.inflowDate || s.openDate || "").trim();
  return /^\d{4}-\d{2}/.test(v) ? v.slice(0, 7) : "";
}

/* 1차 조치 완료 = 1차 방문(채증) 일자가 기록된 매장 */
function isFirstActionDone(s) {
  const v = String(s.visitDate || "").trim();
  return v !== "" && v !== "-";
}

function computeDashboard() {
  const total = fakeStores.length;
  const openCnt = fakeStores.filter(s => !isClosed(s)).length;
  const closedCnt = total - openCnt;

  const hasVisit = fakeStores.some(isFirstActionDone);
  const doneCnt = fakeStores.filter(isFirstActionDone).length;

  // 월별 신규 인입 (빈 달은 0으로 채워 시간축 왜곡 방지)
  const byMonth = new Map();
  fakeStores.forEach(s => {
    const k = storeMonth(s);
    if (k) byMonth.set(k, (byMonth.get(k) || 0) + 1);
  });
  const keys = [...byMonth.keys()].sort();
  const months = [];
  if (keys.length) {
    let [y, m] = keys[0].split("-").map(Number);
    const [ey, em] = keys[keys.length - 1].split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      const k = `${y}-${String(m).padStart(2, "0")}`;
      months.push({ key: k, label: `${String(y).slice(2)}.${String(m).padStart(2, "0")}`, count: byMonth.get(k) || 0 });
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  let cum = 0;
  months.forEach(mo => { cum += mo.count; mo.cum = cum; });

  const nowKey = new Date().toISOString().slice(0, 7);
  const newThisMonth = byMonth.get(nowKey) || 0;

  // 권역별 (운영중/종료)
  const byRegion = new Map();
  fakeStores.forEach(s => {
    const r = storeRegion(s);
    if (!byRegion.has(r)) byRegion.set(r, { open: 0, closed: 0 });
    byRegion.get(r)[isClosed(s) ? "closed" : "open"]++;
  });
  const regions = [...byRegion.entries()]
    .map(([label, v]) => ({ label, ...v, total: v.open + v.closed }))
    .sort((a, b) => b.total - a.total);

  // 유형별 (운영중/종료)
  const byType = new Map();
  fakeStores.forEach(s => {
    const t = String(s.type || "").trim() || "미분류";
    if (!byType.has(t)) byType.set(t, { open: 0, closed: 0 });
    byType.get(t)[isClosed(s) ? "closed" : "open"]++;
  });
  const types = [...byType.entries()]
    .map(([label, v]) => ({ label, ...v, total: v.open + v.closed }))
    .sort((a, b) => b.total - a.total);

  return { total, openCnt, closedCnt, hasVisit, doneCnt, months, newThisMonth, regions, types };
}

function donutSvg(ratio, color, centerText) {
  const r = 42, c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, ratio)) * c;
  return `
    <svg viewBox="0 0 110 110" role="img" aria-label="${Math.round(ratio * 100)}%">
      <circle cx="55" cy="55" r="${r}" fill="none" stroke="#e5e5ea" stroke-width="12"/>
      <circle cx="55" cy="55" r="${r}" fill="none" stroke="${color}" stroke-width="12"
        stroke-linecap="round" stroke-dasharray="${filled} ${c}" transform="rotate(-90 55 55)"/>
      <text x="55" y="61" text-anchor="middle" font-size="19" font-weight="800" fill="#1d1d1f">${centerText}</text>
    </svg>`;
}

/* 월별 신규 인입(막대) + 누적(라인) — 축이 달라 위/아래 패널로 분리 */
function monthlyChartSvg(months) {
  if (!months.length) return `<div class="stats-empty">인입월 데이터가 없습니다.</div>`;
  const W = 640, padL = 30, padR = 34;
  const plotW = W - padL - padR;
  const n = months.length;
  const step = plotW / n;
  const barW = Math.min(30, step * 0.55);
  const maxCum = Math.max(...months.map(m => m.cum));
  const maxCnt = Math.max(...months.map(m => m.count), 1);

  // 상단: 누적 라인 (y 18~108) / 하단: 월별 막대 (y 138~226)
  const cy = v => 108 - (v / maxCum) * 90;
  const by = v => 226 - (v / maxCnt) * 88;
  const cx = i => padL + step * i + step / 2;

  const linePts = months.map((m, i) => `${cx(i).toFixed(1)},${cy(m.cum).toFixed(1)}`).join(" ");
  const areaPts = `${padL + step / 2},108 ${linePts} ${cx(n - 1).toFixed(1)},108`;

  const bars = months.map((m, i) => `
    <rect x="${(cx(i) - barW / 2).toFixed(1)}" y="${by(m.count).toFixed(1)}" width="${barW.toFixed(1)}"
      height="${(226 - by(m.count)).toFixed(1)}" rx="4" fill="#007AFF">
      <title>${m.label} 신규 ${m.count}건</title>
    </rect>
    ${m.count ? `<text x="${cx(i).toFixed(1)}" y="${(by(m.count) - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="#48484a">${m.count}</text>` : ""}`).join("");

  const last = months[n - 1];
  const xLabels = months.map((m, i) => {
    if (n > 8 && i % 2 === 1 && i !== n - 1) return "";
    return `<text x="${cx(i).toFixed(1)}" y="242" text-anchor="middle" font-size="9.5" fill="#8e8e93">${m.label}</text>`;
  }).join("");

  return `
    <svg viewBox="0 0 ${W} 250" role="img" aria-label="월별 인입 추이">
      <text x="${padL}" y="12" font-size="10.5" font-weight="700" fill="#8e8e93">누적 인입</text>
      <polygon points="${areaPts}" fill="rgba(0,122,255,0.08)"/>
      <polyline points="${linePts}" fill="none" stroke="#1d1d1f" stroke-width="2" stroke-linejoin="round"/>
      ${months.map((m, i) => `<circle cx="${cx(i).toFixed(1)}" cy="${cy(m.cum).toFixed(1)}" r="2.5" fill="#1d1d1f"><title>${m.label} 누적 ${m.cum}건</title></circle>`).join("")}
      <text x="${(cx(n - 1) + 7).toFixed(1)}" y="${(cy(last.cum) + 4).toFixed(1)}" font-size="11" font-weight="800" fill="#1d1d1f">${last.cum}</text>
      <line x1="${padL}" y1="108" x2="${W - padR}" y2="108" stroke="#e5e5ea"/>
      <text x="${padL}" y="132" font-size="10.5" font-weight="700" fill="#8e8e93">월별 신규 인입</text>
      ${bars}
      <line x1="${padL}" y1="226" x2="${W - padR}" y2="226" stroke="#e5e5ea"/>
      ${xLabels}
    </svg>`;
}

function hbarListHtml(rows) {
  if (!rows.length) return `<div class="stats-empty">데이터가 없습니다.</div>`;
  const max = Math.max(...rows.map(r => r.total));
  return `<div class="hbar-list">${rows.map(r => {
    const segs = [
      r.open ? `<div class="hbar-seg open" style="flex:${r.open}" title="${esc(r.label)} 운영중 ${r.open}개">${r.open / max > 0.05 ? r.open : ""}</div>` : "",
      r.closed ? `<div class="hbar-seg closed" style="flex:${r.closed}" title="${esc(r.label)} 영업종료 ${r.closed}개">${r.closed / max > 0.05 ? r.closed : ""}</div>` : ""
    ].join("");
    return `
      <div class="hbar-row">
        <span class="hbar-label">${esc(r.label)}</span>
        <div><div class="hbar-track" style="width:${(r.total / max * 100).toFixed(1)}%">${segs}</div></div>
        <span class="hbar-total">${r.total}</span>
      </div>`;
  }).join("")}</div>`;
}

const OPEN_CLOSED_LEGEND = `
  <div class="chart-legend">
    <span class="legend-item"><span class="legend-swatch" style="background:#FF3B30"></span>운영중</span>
    <span class="legend-item"><span class="legend-swatch" style="background:#8e8e93"></span>영업종료</span>
  </div>`;

function renderDashboard() {
  const body = document.getElementById("statsBody");
  document.getElementById("statsDate").textContent = new Date().toISOString().slice(0, 10);

  if (!fakeStores.length) {
    body.innerHTML = `<div class="stats-empty">가품매장 데이터가 없습니다.<br/>관리자 메뉴에서 가품매장 파일을 업로드하세요.</div>`;
    return;
  }

  const d = computeDashboard();
  const doneRate = d.total ? d.doneCnt / d.total : 0;
  const closeRate = d.total ? d.closedCnt / d.total : 0;

  body.innerHTML = `
    <p class="stats-section-title">I. 총괄 현황</p>
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label"><span class="dot dot-blue"></span>인입 매장</div>
        <div class="kpi-value">${d.total}<small>건</small></div>
        <div class="kpi-hint">당월 신규 ${d.newThisMonth}건</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span class="dot dot-green"></span>1차 조치 완료</div>
        <div class="kpi-value">${d.hasVisit ? d.doneCnt + '<small>건</small>' : "-"}</div>
        <div class="kpi-hint">${d.hasVisit ? `완료율 ${(doneRate * 100).toFixed(1)}%` : "방문일자 데이터 없음"}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span class="dot dot-red"></span>운영중 매장</div>
        <div class="kpi-value alert">${d.openCnt}<small>건</small></div>
        <div class="kpi-hint">영업종료 ${d.closedCnt}건</div>
      </div>
    </div>

    <p class="stats-section-title">II. 단계별 대응 추이</p>
    <div class="chart-card">
      <p class="chart-title">침해 매장 인입(적발) 현황</p>
      ${monthlyChartSvg(d.months)}
    </div>
    <div class="chart-grid-2">
      <div class="chart-card">
        <p class="chart-title">1차 조치 완료율</p>
        <div class="donut-row">
          ${donutSvg(doneRate, "#007AFF", d.hasVisit ? (doneRate * 100).toFixed(1) + "%" : "-")}
          <div class="donut-desc">${d.hasVisit
            ? `완료 <b>${d.doneCnt}건</b> / ${d.total}건`
            : "방문일자 데이터가 없습니다.<br/>DB 원본(.xlsm)을 업로드하면 표시됩니다."}</div>
        </div>
      </div>
      <div class="chart-card">
        <p class="chart-title">영업종료(종결)율</p>
        <div class="donut-row">
          ${donutSvg(closeRate, "#34c759", (closeRate * 100).toFixed(1) + "%")}
          <div class="donut-desc">종료 <b>${d.closedCnt}건</b> / ${d.total}건<br/>현재 운영중 <b style="color:#FF3B30">${d.openCnt}건</b></div>
        </div>
      </div>
    </div>

    <p class="stats-section-title">III. 매장 실태 분석</p>
    <div class="chart-grid-2">
      <div class="chart-card">
        <p class="chart-title">권역별 침해 매장 현황</p>
        ${OPEN_CLOSED_LEGEND}
        ${hbarListHtml(d.regions)}
      </div>
      <div class="chart-card">
        <p class="chart-title">임대 유형별 침해 매장 현황</p>
        ${OPEN_CLOSED_LEGEND}
        ${hbarListHtml(d.types)}
      </div>
    </div>`;
}

function openStats() {
  if (isMobile()) closeMobilePanel();
  clearSelection();
  renderDashboard();
  document.getElementById("statsOverlay").hidden = false;
  document.body.classList.add("stats-open");
}
function closeStats() {
  document.getElementById("statsOverlay").hidden = true;
  document.body.classList.remove("stats-open");
}

/* =====================================================================
   9. 유틸
   ===================================================================== */
function isClosed(store) {
  const v = String(store.operating || store.operatingStatus || "").trim();
  return v.includes("종료") || v === "폐점" || v === "X" || v === "N" || v === "false";
}
function operatingLabel(store) { return isClosed(store) ? "종료" : "영업중"; }
function operatingBadge(store) {
  return isClosed(store)
    ? `<span class="badge badge-closed">종료</span>`
    : `<span class="badge badge-open">영업중</span>`;
}
function getStoreKey(store) {
  return String(store.id || store.code || `${store.name}-${store.lat}-${store.lng}`);
}
function isValidCoordinate(lat, lng) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Number(lat) !== 0 && Number(lng) !== 0;
}
function money(v) {
  const n = Number(v || 0);
  if (!n) return "-";
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, "") + "억원";
  if (n >= 10000) return Math.round(n / 10000).toLocaleString("ko-KR") + "만원";
  return n.toLocaleString("ko-KR") + "원";
}
function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

/* =====================================================================
   10. 엑셀/CSV 업로드 & 컬럼 매핑
   ===================================================================== */

// 한글 헤더 → 내부 필드명 매핑 (여러 표현 허용)
const OUR_HEADER_MAP = {
  "매장명": "name", "매장이름": "name", "점포명": "name", "name": "name",
  "주소": "address", "매장주소": "address", "address": "address",
  "매출": "monthlySales", "매출액": "monthlySales", "월매출": "monthlySales", "월매출액": "monthlySales", "월별매출액": "monthlySales", "monthlysales": "monthlySales",
  "매출월": "salesMonth", "기준월": "salesMonth", "월": "salesMonth",
  "위도": "lat", "lat": "lat", "latitude": "lat",
  "경도": "lng", "lng": "lng", "lon": "lng", "longitude": "lng",
  "id": "id", "코드": "id"
};

const FAKE_HEADER_MAP = {
  "매장코드": "code", "코드": "code", "번호": "code", "code": "code",
  "매장명": "name", "매장이름": "name", "name": "name",
  "주소": "address", "가품매장주소": "address", "매장주소": "address", "address": "address",
  "판매상품": "product", "판매중인상품": "product", "상품": "product", "product": "product",
  "유형": "type", "매장유형": "type", "type": "type",
  "상권": "area", "area": "area",
  "영업시작일": "openDate", "영업시작": "openDate", "시작일": "openDate", "opendate": "openDate",
  "영업종료일": "closeDate", "영업종료": "closeDate", "종료일": "closeDate", "closedate": "closeDate",
  "비고": "note", "메모": "note", "note": "note",
  "인테리어유형": "interior", "인테리어": "interior", "interior": "interior",
  "간판유형": "signage", "간판": "signage", "signage": "signage",
  "현재영업여부": "operating", "영업여부": "operating", "영업상태": "operating", "운영여부": "operating", "operating": "operating",
  "인입월": "inflowMonth", "인입일자": "inflowDate",
  "지역": "region",
  "현재단계": "stage",
  "방문일자": "visitDate",
  "법적조치여부": "legalStatus",
  "위도": "lat", "lat": "lat", "경도": "lng", "lng": "lng",
  "id": "id"
};

function normalizeKey(k) {
  return String(k || "").trim().toLowerCase().replace(/\s|_|\(.*?\)/g, "");
}

function mapRow(row, headerMap) {
  const out = {};
  Object.keys(row).forEach(rawKey => {
    const nk = normalizeKey(rawKey);
    const field = headerMap[nk] || headerMap[String(rawKey).trim()];
    if (!field) return;
    const val = fmtCellDate(row[rawKey]);
    // 이미 값이 있는 필드를 빈 값으로 덮어쓰지 않음
    // (예: '법적조치여부(2차)'가 비어 있어도 1차 값 유지)
    if (out[field] !== undefined && String(val).trim() === "") return;
    out[field] = val;
  });
  // 숫자 변환
  if (out.lat !== undefined) out.lat = parseFloat(String(out.lat).replace(/[^0-9.\-]/g, "")) || undefined;
  if (out.lng !== undefined) out.lng = parseFloat(String(out.lng).replace(/[^0-9.\-]/g, "")) || undefined;
  if (out.monthlySales !== undefined) out.monthlySales = Number(String(out.monthlySales).replace(/[^0-9.\-]/g, "")) || 0;
  return out;
}

/* 엑셀 날짜 셀(Date 객체) → "YYYY-MM-DD" 문자열.
   SheetJS의 날짜 변환은 몇 초~몇 분 어긋나 전날 23:59로 나올 수 있어
   12시간을 더해 가장 가까운 날짜로 반올림한다(값이 순수 날짜라는 전제). */
function fmtCellDate(v) {
  if (v instanceof Date && !isNaN(v)) {
    const d = new Date(v.getTime() + 12 * 60 * 60 * 1000);
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }
  return v;
}

function readSheet(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array", cellDates: true });
        // '가품매장관리 DB' 원본(.xlsm)을 그대로 올려도 되도록 DB 시트 우선 사용
        const sheetName = wb.SheetNames.includes("DB") ? "DB" : wb.SheetNames[0];
        resolve(sheetToRows(wb.Sheets[sheetName]));
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/* 시트 → 행 객체 배열.
   헤더가 첫 행이 아닌 경우(DB 시트는 3행에 헤더)에도 '매장명' 셀이 있는
   행을 찾아 헤더로 사용하고, 그 아래 행들을 데이터로 읽는다. */
function sheetToRows(ws) {
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  let headerIdx = grid.findIndex(row => row.some(c => String(c).trim() === "매장명"));
  if (headerIdx < 0) headerIdx = 0;
  const headers = (grid[headerIdx] || []).map(h => String(h).trim());
  return grid.slice(headerIdx + 1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i] ?? ""; });
    return obj;
  });
}

async function handleUpload(file, kind) {
  setStatus(`"${file.name}" 읽는 중...`);
  const rows = await readSheet(file);
  if (!rows.length) { setStatus("행이 없습니다. 파일을 확인하세요.", true); return; }

  const map_ = kind === "our" ? OUR_HEADER_MAP : FAKE_HEADER_MAP;
  let mapped = rows.map(r => mapRow(r, map_)).filter(r => r.name || r.address || r.code);

  // 좌표 없는 항목 → 주소 지오코딩
  const needGeo = mapped.filter(r => !isValidCoordinate(r.lat, r.lng) && r.address);
  if (needGeo.length) {
    await geocodeAll(needGeo);
  }

  if (kind === "our") ourStores = mapped;
  else fakeStores = mapped;

  saveToStorage();
  populateFilters();
  clearSelection();
  renderMarkers();
  fitAllMarkers();
  // 현황 대시보드가 열려 있으면 새 데이터로 갱신
  if (!document.getElementById("statsOverlay").hidden) renderDashboard();

  const ok = mapped.filter(r => isValidCoordinate(r.lat, r.lng)).length;
  const fail = mapped.length - ok;
  setStatus(`✅ ${kind === "our" ? "정품매장" : "가품매장"} ${mapped.length}건 반영 (좌표 성공 ${ok}, 실패 ${fail})`);
  hideGeoProgress();

  // 자동 반영이 켜져 있으면 저장소의 map-data.json까지 갱신
  const gh = loadGhConfig();
  if (gh.auto && gh.owner && gh.repo && gh.token) await pushToGithub();
}

/* 카카오 지오코더 (주소 → 좌표), 초당 과요청 방지용 딜레이 */
function geocodeAddress(address) {
  return new Promise(resolve => {
    if (!geocoder) { resolve(null); return; }
    geocoder.addressSearch(address, (result, status) => {
      if (status === kakao.maps.services.Status.OK && result[0]) {
        resolve({ lat: parseFloat(result[0].y), lng: parseFloat(result[0].x) });
      } else {
        resolve(null);
      }
    });
  });
}

/* 주소별 좌표 캐시: 재업로드 시 이미 변환한 주소는 지오코딩을 건너뜀 */
const GEO_CACHE_KEY = "fakeStoreGeoCache_v1";
function loadGeoCache() {
  try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY)) || {}; } catch { return {}; }
}
function saveGeoCache(cache) {
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache)); } catch (e) { console.warn("좌표 캐시 저장 실패", e); }
}

async function geocodeAll(items) {
  const cache = loadGeoCache();
  const misses = items.filter(it => {
    const hit = cache[String(it.address).trim()];
    if (hit && isValidCoordinate(hit.lat, hit.lng)) {
      it.lat = hit.lat; it.lng = hit.lng;
      return false;
    }
    return true;
  });
  if (!misses.length) return;

  showGeoProgress();
  for (let i = 0; i < misses.length; i++) {
    updateGeoProgress(i + 1, misses.length);
    const coord = await geocodeAddress(misses[i].address);
    if (coord) {
      misses[i].lat = coord.lat; misses[i].lng = coord.lng;
      cache[String(misses[i].address).trim()] = coord;
    }
    await sleep(120); // API 부하 방지
  }
  saveGeoCache(cache);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* =====================================================================
   11. 엑셀 템플릿 다운로드
   ===================================================================== */
function downloadTemplate() {
  const wb = XLSX.utils.book_new();

  const ourSheet = XLSX.utils.json_to_sheet([
    { "매장명": "강남 플래그십", "매장주소": "서울시 강남구 테헤란로 123", "매출월": "2026-06", "월별매출액": 120000000, "위도": "", "경도": "" }
  ]);
  const fakeSheet = XLSX.utils.json_to_sheet([
    {
      "매장코드": "F-0001", "매장명": "OO몰 매대", "가품매장주소": "서울시 강동구 고덕동 353-23",
      "판매상품": "가방", "유형": "단기행사", "상권": "고덕", "영업시작일": "2026-05-01",
      "영업종료일": "", "인테리어유형": "부스형", "간판유형": "현수막", "현재영업여부": "영업중", "비고": ""
    }
  ]);

  XLSX.utils.book_append_sheet(wb, ourSheet, "정품매장");
  XLSX.utils.book_append_sheet(wb, fakeSheet, "가품매장");
  XLSX.writeFile(wb, "매장데이터_양식.xlsx");
}

/* 저장소에 올릴 map-data.json 본문 */
function mapDataJson() {
  return JSON.stringify({ exportedAt: Date.now(), fakeStores, ourStores }, null, 2);
}

/* 현재 데이터(좌표 포함)를 map-data.json 형식으로 내려받기.
   GitHub 저장소의 map-data.json에 덮어쓰면 모든 사용자의 기본 데이터가 됨 */
function exportMapData() {
  const payload = mapDataJson();
  const blob = new Blob([payload], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "map-data.json";
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`map-data.json 내려받음 (가품 ${fakeStores.length} · 정품 ${ourStores.length}건) — GitHub 저장소에 덮어쓰면 전체 공유됩니다.`);
}

/* =====================================================================
   11.5 GitHub 저장소 자동 반영
   업로드한 데이터를 저장소의 map-data.json에 직접 커밋해서
   모든 기기·모든 사용자가 같은 데이터를 보도록 만든다.
   토큰은 이 브라우저(localStorage)에만 저장되고 저장소 코드에는 포함되지 않는다.
   ===================================================================== */
const GH_KEY = "fakeStoreGh_v1";

function loadGhConfig() {
  try { return JSON.parse(localStorage.getItem(GH_KEY)) || {}; } catch { return {}; }
}
function saveGhConfig(cfg) {
  try { localStorage.setItem(GH_KEY, JSON.stringify(cfg)); } catch (e) { console.warn("GitHub 설정 저장 실패", e); }
}

/* 한글이 포함된 UTF-8 문자열 → base64 (GitHub API가 요구하는 형식) */
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000; // 큰 파일에서 스택 초과 방지
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function pushToGithub() {
  const cfg = loadGhConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    setStatus("GitHub 설정(아이디·저장소·토큰)을 먼저 입력하고 저장하세요.", true);
    return false;
  }
  const branch = cfg.branch || "main";
  const path = cfg.path || "map-data.json";
  const api = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  setStatus("GitHub 저장소에 반영 중...");
  try {
    // 기존 파일이 있으면 sha 필요 (없으면 새로 생성)
    let sha;
    const cur = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers, cache: "no-store" });
    if (cur.ok) sha = (await cur.json()).sha;
    else if (cur.status === 401) { setStatus("토큰이 유효하지 않습니다. 다시 발급해 주세요.", true); return false; }
    else if (cur.status !== 404) { setStatus(`저장소를 찾을 수 없습니다 (${cur.status}). 아이디·저장소·브랜치를 확인하세요.`, true); return false; }

    const body = {
      message: `데이터 갱신: 가품 ${fakeStores.length} · 정품 ${ourStores.length}건`,
      content: toBase64Utf8(mapDataJson()),
      branch
    };
    if (sha) body.sha = sha;

    const res = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const msg = await res.text();
      const hint = res.status === 403 ? " (토큰 권한에 Contents: Read and write 가 필요합니다)" : "";
      setStatus(`반영 실패 (${res.status})${hint}: ${msg.slice(0, 120)}`, true);
      return false;
    }
    setStatus(`✅ 저장소에 반영 완료 (가품 ${fakeStores.length} · 정품 ${ourStores.length}건). 1~2분 후 사이트에 적용됩니다.`);
    return true;
  } catch (e) {
    setStatus("반영 실패: " + e.message, true);
    return false;
  }
}

function bindGithubPanel() {
  const cfg = loadGhConfig();
  const el = id => document.getElementById(id);
  // 브라우저가 이전 버전 HTML을 캐시한 경우 요소가 없을 수 있음 → 앱 전체가 멈추지 않도록 건너뜀
  if (!el("ghOwner")) { console.warn("GitHub 패널 요소 없음(캐시된 구버전 HTML). 새로고침하세요."); return; }
  el("ghOwner").value = cfg.owner || "";
  el("ghRepo").value = cfg.repo || "";
  el("ghBranch").value = cfg.branch || "";
  el("ghToken").value = cfg.token || "";
  el("ghAuto").checked = !!cfg.auto;
  updateGhState();

  el("ghSaveBtn").onclick = () => {
    saveGhConfig({
      owner: el("ghOwner").value.trim(),
      repo: el("ghRepo").value.trim(),
      branch: el("ghBranch").value.trim() || "main",
      path: "map-data.json",
      token: el("ghToken").value.trim(),
      auto: el("ghAuto").checked
    });
    updateGhState();
    setStatus("GitHub 설정을 저장했습니다.");
  };
  el("ghPushBtn").onclick = () => pushToGithub();
  el("ghClearBtn").onclick = () => {
    if (!confirm("저장된 GitHub 설정과 토큰을 삭제할까요?")) return;
    localStorage.removeItem(GH_KEY);
    ["ghOwner", "ghRepo", "ghBranch", "ghToken"].forEach(i => (el(i).value = ""));
    el("ghAuto").checked = false;
    updateGhState();
    setStatus("GitHub 설정을 삭제했습니다.");
  };
}

function updateGhState() {
  const cfg = loadGhConfig();
  const on = !!(cfg.owner && cfg.repo && cfg.token);
  const badge = document.getElementById("ghState");
  if (!badge) return;
  badge.textContent = on ? (cfg.auto ? "자동 반영 켜짐" : "설정됨") : "미설정";
  badge.classList.toggle("on", on);
}

/* =====================================================================
   12. UI 헬퍼
   ===================================================================== */
function setStatus(msg, isError) {
  const el = document.getElementById("dataStatus");
  el.textContent = msg;
  el.style.color = isError ? "#FF3B30" : "#248a3d";
}
function showGeoProgress() { document.getElementById("geoProgress").hidden = false; }
function hideGeoProgress() { setTimeout(() => (document.getElementById("geoProgress").hidden = true), 800); }
function updateGeoProgress(cur, total) {
  document.getElementById("geoProgress").textContent = `주소 → 좌표 변환 중... ${cur} / ${total}`;
}

function bindDataPanel() {
  const modal = document.getElementById("adminModal");
  const openModal = () => { modal.hidden = false; };
  const closeModal = () => { modal.hidden = true; };

  // 레일의 '관리자' 버튼 + 숨은 트리거로 모달 열기
  document.getElementById("railAdmin").onclick = openModal;
  document.getElementById("dataToggle").onclick = openModal;
  document.getElementById("adminClose").onclick = closeModal;
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });

  // ---- 관리자 로그인 ----
  isAdmin = sessionStorage.getItem(ADMIN_SESSION_KEY) === "1";
  applyAdminState();

  const pwInput = document.getElementById("adminPassword");
  const loginBtn = document.getElementById("adminLoginBtn");
  const tryLogin = () => {
    const err = document.getElementById("loginError");
    if (pwInput.value === ADMIN_PASSWORD) {
      isAdmin = true;
      sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
      pwInput.value = "";
      err.textContent = "";
      applyAdminState();
    } else {
      err.textContent = "비밀번호가 올바르지 않습니다.";
    }
  };
  loginBtn.onclick = tryLogin;
  pwInput.addEventListener("keydown", e => { if (e.key === "Enter") tryLogin(); });

  document.getElementById("adminLogoutBtn").onclick = () => {
    isAdmin = false;
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    applyAdminState();
  };

  // ---- 데이터 관리 도구 (관리자만 동작) ----
  document.getElementById("ourFile").onchange = e => {
    if (e.target.files[0]) handleUpload(e.target.files[0], "our").catch(err => setStatus(err.message, true));
  };
  document.getElementById("fakeFile").onchange = e => {
    if (e.target.files[0]) handleUpload(e.target.files[0], "fake").catch(err => setStatus(err.message, true));
  };
  document.getElementById("downloadTemplateBtn").onclick = downloadTemplate;
  document.getElementById("exportDataBtn").onclick = exportMapData;
  bindGithubPanel();
  document.getElementById("clearDataBtn").onclick = () => {
    if (!confirm("업로드한 데이터를 지우고 기본 데이터로 되돌립니다. 진행할까요?")) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  };
}

/* 관리자 여부에 따라 로그인 폼 / 데이터 도구 전환 */
function applyAdminState() {
  document.getElementById("adminLogin").hidden = isAdmin;
  document.getElementById("adminTools").hidden = !isAdmin;
  // 자물쇠 아이콘: 로그인 시 열림
  const shackle = isAdmin ? 'M8 11V8a4 4 0 0 1 7.9-.9' : 'M8 11V8a4 4 0 0 1 8 0v3';
  document.getElementById("adminLock").innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="${shackle}"/>
    </svg>`;
}

function isMobile() {
  return window.matchMedia("(max-width: 900px)").matches;
}

/* 바텀시트는 3단계: 닫힘 / peek(살짝, 지도 위주) / expanded(크게)
   openMobilePanel()은 항상 peek 상태로 연다 → 지도를 덜 가림 */
function openMobilePanel() {
  const panel = document.getElementById("panel");
  panel.classList.add("open");
  panel.classList.remove("expanded"); // 기본은 peek
  document.body.classList.add("panel-open");
}
function expandMobilePanel() {
  const panel = document.getElementById("panel");
  panel.classList.add("open", "expanded");
  document.body.classList.add("panel-open");
}
function closeMobilePanel() {
  const panel = document.getElementById("panel");
  panel.classList.remove("open", "expanded");
  document.body.classList.remove("panel-open");
}

function bindMobileSidebar() {
  const btn = document.getElementById("mobileSidebarToggle");
  if (btn) btn.onclick = openMobilePanel;

  const closeBtn = document.getElementById("panelClose");
  if (closeBtn) closeBtn.onclick = closeMobilePanel;

  const panel = document.getElementById("panel");
  const handle = document.getElementById("sheetHandle");

  // 핸들 제스처: 위로 끌면 확장, 아래로 끌면 축소(peek)→닫힘
  if (handle) {
    let startY = null;
    const onStart = e => { startY = (e.touches ? e.touches[0].clientY : e.clientY); };
    const onEnd = e => {
      if (startY == null) return;
      const endY = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY);
      const dy = endY - startY;
      if (dy < -40) {
        expandMobilePanel();            // 위로 끌기 → 확장
      } else if (dy > 40) {
        if (panel.classList.contains("expanded")) openMobilePanel(); // 확장→peek
        else closeMobilePanel();        // peek→닫힘
      } else {
        // 탭(거의 안 움직임): peek↔expanded 토글
        if (panel.classList.contains("expanded")) openMobilePanel();
        else expandMobilePanel();
      }
      startY = null;
    };
    handle.addEventListener("touchstart", onStart, { passive: true });
    handle.addEventListener("touchend", onEnd);
    handle.addEventListener("click", () => {
      if (panel.classList.contains("expanded")) openMobilePanel();
      else expandMobilePanel();
    });
  }

  // 검색창을 탭하면 자동 확장(입력하기 편하게)
  const search = document.getElementById("searchInput");
  if (search) search.addEventListener("focus", () => { if (isMobile()) expandMobilePanel(); });
}

/* =====================================================================
   13. 시작
   ===================================================================== */
async function main() {
  try {
    await loadKakaoSdk();
    await loadData();
    initMap();
    populateFilters();
    bindControls();
    bindDataPanel();
    bindMobileSidebar();
    bindDetailCard();
    renderMarkers();
    fitAllMarkers();
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

main();
