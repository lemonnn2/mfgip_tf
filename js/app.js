/* =====================================================================
   가품매장 관제 지도
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
let activeInfoWindow = null;
let radiusKm = 5;

// 마커 클러스터러 (우리매장=파랑 계열, 가품매장=빨강 계열)
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
  if (saved) {
    fakeStores = saved.fakeStores || [];
    ourStores = saved.ourStores || [];
    return;
  }
  try {
    const res = await fetch(DATA_FILE, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      fakeStores = data.fakeStores || [];
      ourStores = data.ourStores || [];
    }
  } catch (e) {
    console.warn("기본 데이터 로드 실패, 빈 데이터로 시작합니다.", e);
    fakeStores = [];
    ourStores = [];
  }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fakeStores, ourStores }));
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
  if (activeInfoWindow) { activeInfoWindow.close(); activeInfoWindow = null; }
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
  const product = document.getElementById("productFilter").value;

  return fakeStores.filter(s => {
    const typeOk = type === "ALL" || s.type === type;
    const opOk = operating === "ALL" || operatingLabel(s) === operating;
    const areaOk = area === "ALL" || s.area === area;
    const productOk = product === "ALL" || s.product === product;
    return typeOk && opOk && areaOk && productOk && matchSearch(s);
  });
}

function getVisibleOurStores() {
  // 우리매장은 검색어에만 반응 (필터는 가품 대상)
  return ourStores.filter(matchSearch);
}

function populateFilters() {
  fillSelect("typeFilter", "유형 전체", uniq(fakeStores.map(s => s.type)));
  fillSelect("operatingFilter", "영업여부 전체", uniq(fakeStores.map(operatingLabel)));
  fillSelect("areaFilter", "상권 전체", uniq(fakeStores.map(s => s.area)));
  fillSelect("productFilter", "판매상품 전체", uniq(fakeStores.map(s => s.product)));
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
      clearSelection();
      renderMarkers();
    };
  });
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
  ["typeFilter", "operatingFilter", "areaFilter", "productFilter"].forEach(id => {
    document.getElementById(id).onchange = () => {
      if (id === "typeFilter") syncChipsFromSelect();
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
    ["typeFilter", "operatingFilter", "areaFilter", "productFilter"]
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

      // '지도'는 목록 패널을 닫고 지도를 본다 (특히 모바일)
      if (v === "map") {
        if (isMobile()) closeMobilePanel();
        else document.querySelector(".app").classList.add("panel-collapsed");
        setTimeout(() => map && map.relayout(), 300);
        return;
      }

      // 그 외(우리/가품/현황)는 패널 열기
      openPanel();
      if (v === "our" || v === "fake") {
        const tab = document.querySelector(`.list-tab[data-list="${v}"]`);
        if (tab) tab.click();
      }
    };
  });

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

  // 내 위치
  document.getElementById("locBtn").onclick = () => {
    if (!navigator.geolocation) { alert("이 브라우저는 위치 기능을 지원하지 않습니다."); return; }
    navigator.geolocation.getCurrentPosition(
      pos => map.panTo(new kakao.maps.LatLng(pos.coords.latitude, pos.coords.longitude)),
      () => alert("위치 정보를 가져올 수 없습니다.")
    );
  };

  // 이 지역 다시 검색 = 전체 보기
  document.getElementById("searchHere").onclick = fitAllMarkers;
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
  activeInfoWindow = new kakao.maps.InfoWindow({
    content: ourInfoHtml(store, nearby), removable: true, position: center
  });
  openInfoAt(center);
}

function selectFakeStore(store) {
  if (!isValidCoordinate(store.lat, store.lng)) return;
  clearSelection();
  const center = new kakao.maps.LatLng(store.lat, store.lng);
  drawCircle(center, isClosed(store) ? "#8e8e93" : "#FF3B30");

  const nearby = getNearby(store, ourStores);
  const impact = getImpactLevel(nearby);
  activeInfoWindow = new kakao.maps.InfoWindow({
    content: fakeInfoHtml(store, nearby, impact), removable: true, position: center
  });
  openInfoAt(center);
}

/* 인포윈도우를 좌표 위치에 열고, 클러스터가 묶여 있으면 풀리도록 확대 */
function openInfoAt(center) {
  // 모바일: 목록에서 선택하면 지도가 보이도록 패널을 닫음
  if (isMobile()) closeMobilePanel();
  // 클러스터 최소 레벨(6)보다 축소돼 있으면 개별 마커가 보이도록 확대
  if (map.getLevel() >= 6) map.setLevel(5, { anchor: center });
  setTimeout(() => {
    activeInfoWindow.open(map);
    map.panTo(center);
  }, isMobile() ? 320 : 0); // 패널 닫힘 애니메이션 후 relayout 반영
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
      <div class="info-title">🏬 ${esc(store.name)}</div>
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
    : `<div class="empty-nearby">반경 ${radiusKm}km 내 우리매장이 없습니다.</div>`;

  const impactClass = impact === "높음" ? "impact-high" : impact === "중간" ? "impact-mid" : "impact-low";

  const row = (label, val) => val ? `<div class="info-row"><b>${label}:</b> ${esc(val)}</div>` : "";

  return `
    <div class="info-window">
      <div class="info-title">🚩 ${esc(store.name || store.code || "가품매장")}</div>
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
        반경 ${radiusKm}km 내 우리매장 ${nearbyOur.length}개<br/>
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
  if (!stores.length) { list.innerHTML = `<div class="store-meta">표시할 우리매장이 없습니다.</div>`; return; }

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
        ${radiusKm}km 내 우리매장 <b>${nearby.length}</b>개
      </div>`;
    card.onclick = () => selectFakeStore(store);
    list.appendChild(card);
  });
}

function updateMetrics() {
  document.getElementById("fakeCount").textContent = fakeStores.length;
  document.getElementById("ourCount").textContent = ourStores.length;
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
   9. 유틸
   ===================================================================== */
function isClosed(store) {
  const v = String(store.operating || store.operatingStatus || "").trim();
  return v === "종료" || v === "폐점" || v === "X" || v === "N" || v === "false";
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
  "매장코드": "code", "코드": "code", "code": "code",
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
  "현재영업여부": "operating", "영업여부": "operating", "영업상태": "operating", "operating": "operating",
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
    if (field) out[field] = row[rawKey];
  });
  // 숫자 변환
  if (out.lat !== undefined) out.lat = parseFloat(String(out.lat).replace(/[^0-9.\-]/g, "")) || undefined;
  if (out.lng !== undefined) out.lng = parseFloat(String(out.lng).replace(/[^0-9.\-]/g, "")) || undefined;
  if (out.monthlySales !== undefined) out.monthlySales = Number(String(out.monthlySales).replace(/[^0-9.\-]/g, "")) || 0;
  return out;
}

function readSheet(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        resolve(rows);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
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

  const ok = mapped.filter(r => isValidCoordinate(r.lat, r.lng)).length;
  const fail = mapped.length - ok;
  setStatus(`✅ ${kind === "our" ? "우리매장" : "가품매장"} ${mapped.length}건 반영 (좌표 성공 ${ok}, 실패 ${fail})`);
  hideGeoProgress();
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

async function geocodeAll(items) {
  showGeoProgress();
  for (let i = 0; i < items.length; i++) {
    updateGeoProgress(i + 1, items.length);
    const coord = await geocodeAddress(items[i].address);
    if (coord) { items[i].lat = coord.lat; items[i].lng = coord.lng; }
    await sleep(120); // API 부하 방지
  }
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

  XLSX.utils.book_append_sheet(wb, ourSheet, "우리매장");
  XLSX.utils.book_append_sheet(wb, fakeSheet, "가품매장");
  XLSX.writeFile(wb, "매장데이터_양식.xlsx");
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
  document.getElementById("adminLock").textContent = isAdmin ? "🔓" : "🔒";
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
    renderMarkers();
    fitAllMarkers();
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
}

main();
