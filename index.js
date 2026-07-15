/**
 * 태양광 패널 발전량 시뮬레이터 및 날씨 추적 로직 (index.js)
 * API 키는 백엔드 서버(server.js)가 관리합니다.
 */

// 정적 계수 설정값
const CONSTANTS = {
    moduleEfficiency: 0.18,      // η (모듈 효율, 18%)
    tempCoefficient: -0.004,     // γ (온도 계수, -0.4%/°C)
    humidityLossCoeff: 0.0007,   // β (습도 손실 계수, 0.07%/%)
    baseHumidity: 20.0,          // RHref (기준 습도, 20%)
    noct: 45.0                   // NOCT (태양광 모듈 명목 동작 온도, 표준 값 45°C)
};

// 동적으로 수집되는 변수들
let dynamicWeather = {
    temp: 25.0,               // 현재 기온 (°C)
    humidity: 50.0,           // 현재 상대 습도 (%)
    solarRadiation: 400.0,    // 현재 일사강도 (W/m^2)
};

// 사용자 위치 정보
let userLocation = {
    latitude: 37.5665,        // 서울 기준 기본값
    longitude: 126.9780,
    address: "서울특별시 중구 (기본값)",
    gridX: 60,
    gridY: 127
};

// 태양광 패널 정보
let panelArea = 15; // m^2 단위

// --- 디버그 상태 ---
const _debug = {
    active: false,
    hour: 0,
    minute: 0,
    second: 0
};

// 24시간 5개 영역 시간대 정의
const TIME_ZONES = {
    DAWN:    { name: "새벽", startHour:  0, endHour:  5, bg: "src/Dawn.png"    },
    MORNING: { name: "아침", startHour:  6, endHour: 10, bg: "src/Morning.png" },
    NOON:    { name: "정오", startHour: 11, endHour: 15, bg: "src/Noon.png"    },
    EVENING: { name: "저녁", startHour: 16, endHour: 19, bg: "src/Evening.png" },
    NIGHT:   { name: "밤",   startHour: 20, endHour: 23, bg: "src/Night.png"   }
};

// --- 1. 유틸리티 함수: 위경도 -> 기상청 격자 좌표 변환 ---
function convertGrid(lat, lon) {
    const RE = 6371.00877; // 지구 반경(km)
    const GRID = 5.0; // 격자 간격(km)
    const SLAT1 = 30.0; // 투영 위도1(degree)
    const SLAT2 = 60.0; // 투영 위도2(degree)
    const OLON = 126.0; // 기준점 경도(degree)
    const OLAT = 38.0; // 기준점 위도(degree)
    const XO = 43; // 기준점 X좌표(grid)
    const YO = 136; // 기준점 Y좌표(grid)

    const DEGRAD = Math.PI / 180.0;
    
    const re = RE / GRID;
    const slat1 = SLAT1 * DEGRAD;
    const slat2 = SLAT2 * DEGRAD;
    const olon = OLON * DEGRAD;
    const olat = OLAT * DEGRAD;

    let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
    sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
    let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
    sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
    let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
    ro = re * sf / Math.pow(ro, sn);
    
    let rs = {};
    let ra = Math.tan(Math.PI * 0.25 + (lat) * DEGRAD);
    ra = re * sf / Math.pow(ra, sn);
    let theta = lon * DEGRAD - olon;
    if (theta > Math.PI) theta -= 2.0 * Math.PI;
    if (theta < -Math.PI) theta += 2.0 * Math.PI;
    theta *= sn;
    
    rs['x'] = Math.floor(ra * Math.sin(theta) + XO + 0.5);
    rs['y'] = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
    return rs;
}

// --- 2. 백그라운드 이미지 선택 및 시간대 식별 함수 ---
function updateTimeAndBackground() {
    // 디버그 모드일 때는 가상 시간 사용, 아닐 때는 실제 시간 사용
    let currentHour, currentMin, currentSec, timeString;

    if (_debug.active) {
        currentHour = _debug.hour;
        currentMin  = _debug.minute;
        currentSec  = _debug.second;
        const hh = String(currentHour).padStart(2, '0');
        const mm = String(currentMin).padStart(2, '0');
        const ss = String(currentSec).padStart(2, '0');
        timeString = `⚠️ [DEBUG] ${hh}:${mm}:${ss}`;
    } else {
        const now = new Date();
        currentHour = now.getHours();
        currentMin  = now.getMinutes();
        currentSec  = now.getSeconds();
        timeString  = now.toLocaleTimeString('ko-KR', { hour12: false });
    }

    document.getElementById('current-time').textContent = timeString;

    let selectedZone = TIME_ZONES.NIGHT;
    if      (currentHour >= TIME_ZONES.DAWN.startHour    && currentHour <= TIME_ZONES.DAWN.endHour)    selectedZone = TIME_ZONES.DAWN;
    else if (currentHour >= TIME_ZONES.MORNING.startHour && currentHour <= TIME_ZONES.MORNING.endHour) selectedZone = TIME_ZONES.MORNING;
    else if (currentHour >= TIME_ZONES.NOON.startHour    && currentHour <= TIME_ZONES.NOON.endHour)    selectedZone = TIME_ZONES.NOON;
    else if (currentHour >= TIME_ZONES.EVENING.startHour && currentHour <= TIME_ZONES.EVENING.endHour) selectedZone = TIME_ZONES.EVENING;

    const bgContainer = document.getElementById('bg-container');
    const targetBg = `url("${selectedZone.bg}")`;
    if (bgContainer.style.backgroundImage !== targetBg) {
        bgContainer.style.backgroundImage = targetBg;
    }

    // 유리창 글자색 테마 변경
    const glassPanel = document.getElementById('glass-panel');
    glassPanel.className = glassPanel.className.split(' ').filter(c => !c.startsWith('tz-')).join(' ');
    if      (selectedZone === TIME_ZONES.DAWN)    glassPanel.classList.add('tz-dawn');
    else if (selectedZone === TIME_ZONES.MORNING) glassPanel.classList.add('tz-morning');
    else if (selectedZone === TIME_ZONES.NOON)    glassPanel.classList.add('tz-noon');
    else if (selectedZone === TIME_ZONES.EVENING) glassPanel.classList.add('tz-evening');
    else                                          glassPanel.classList.add('tz-night');

    adjustDefaultRadiation(currentHour);
}

// 시간대에 따른 기본 일사강도 설정 (API 응답에서 일사량이 안 들어올 때의 fallback)
function adjustDefaultRadiation(hour) {
    if (dynamicWeather.solarRadiation === 0 || isNaN(dynamicWeather.solarRadiation)) {
        if (hour >= 6 && hour <= 18) {
            const rad = Math.max(0, Math.sin((hour - 6) / 12 * Math.PI) * 800);
            dynamicWeather.solarRadiation = Math.round(rad);
        } else {
            dynamicWeather.solarRadiation = 0;
        }
    }
}

// --- 3. 태양광 발전 전력 계산 공식 함수 ---
function calculateSolarPower(
    solarIrradiance,
    area,
    efficiency,
    tempCoeff,
    currentTemp,
    currentHumidity,
    baseHumidity,
    humidityLossCoeff,
    noct
) {
    const S_ratio = solarIrradiance / 1000; 
    const I = S_ratio;                      
    
    const cellTemp = currentTemp + ((800 / noct - 20) * S_ratio);
    const tempDifference = cellTemp - 20;
    const tempCorrection = 1 - (tempCoeff * tempDifference);
    
    const powerKW = I * area * efficiency * tempCorrection;
    let powerW = powerKW * 1000;

    if (currentHumidity > baseHumidity) {
        const humidityDifference = currentHumidity - baseHumidity;
        const humidityLoss = humidityLossCoeff * humidityDifference * (I * area * efficiency * 1000);
        powerW = powerW - humidityLoss;
    }
    
    // 생동감 실시간 오차 변동 (+/- 1.5%)
    if (powerW > 0) {
        const variation = (Math.random() * 0.03 - 0.015) * powerW;
        powerW = powerW + variation;
    }
    
    return Math.max(0, powerW); 
}

// 실시간 생산 전력 및 UI 요소 갱신
function updatePowerCalculation() {
    const power = calculateSolarPower(
        dynamicWeather.solarRadiation,
        panelArea,
        CONSTANTS.moduleEfficiency,
        CONSTANTS.tempCoefficient,
        dynamicWeather.temp,
        dynamicWeather.humidity,
        CONSTANTS.baseHumidity,
        CONSTANTS.humidityLossCoeff,
        CONSTANTS.noct
    );

    document.getElementById('generated-power').textContent = power.toFixed(2);
    document.getElementById('weather-temp').textContent = `${dynamicWeather.temp} °C`;
    document.getElementById('weather-humidity').textContent = `${dynamicWeather.humidity} %`;
    document.getElementById('solar-radiation').textContent = `${dynamicWeather.solarRadiation} W/m²`;
}

// --- 4. 사용자 위치 추적 및 행정구역명 변환 ---
function trackUserLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                userLocation.latitude = position.coords.latitude;
                userLocation.longitude = position.coords.longitude;
                
                userLocation.address = `위도: ${userLocation.latitude.toFixed(4)}, 경도: ${userLocation.longitude.toFixed(4)}`;
                document.getElementById('user-location').textContent = "지역명 조회 중...";

                try {
                    const response = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${userLocation.latitude}&longitude=${userLocation.longitude}&localityLanguage=ko`);
                    if (response.ok) {
                        const geoData = await response.json();
                        const locality = geoData.locality || "";
                        const principalSubdivision = geoData.principalSubdivision || "";
                        
                        if (locality || principalSubdivision) {
                            userLocation.address = `${principalSubdivision} ${locality}`.trim();
                        }
                    }
                } catch (e) {
                    console.warn("지역명 API 조회 실패, 위경도 좌표로 대체합니다.", e);
                }

                const grid = convertGrid(userLocation.latitude, userLocation.longitude);
                userLocation.gridX = grid.x;
                userLocation.gridY = grid.y;

                document.getElementById('user-location').textContent = userLocation.address;
                console.log("위치 추적 성공:", userLocation);
                
                fetchKMAWeatherData();
            },
            (error) => {
                console.error("위치 추적 실패:", error);
                document.getElementById('user-location').textContent = `서울특별시 중구 (위치 정보 권한 필요)`;
                fetchKMAWeatherData();
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    } else {
        document.getElementById('user-location').textContent = "서울특별시 중구 (기본값)";
        fetchKMAWeatherData();
    }
}

// --- 5. 기상청 실시간 지상 관측 API 연동 (Express proxy 서버 우회) ---
async function fetchKMAWeatherData() {
    const statusEl = document.getElementById('api-status-msg');
    statusEl.textContent = "날씨 정보 수신 중...";
    statusEl.style.display = "block";

    // 백엔드 Express 프록시 서버 호출 (키는 서버가 관리)
    const url = `/api/weather?lat=${userLocation.latitude}&lon=${userLocation.longitude}`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const resJson = await response.json();
        
        if (resJson.success && resJson.data) {
            dynamicWeather.temp = resJson.data.temp;
            dynamicWeather.humidity = resJson.data.humidity;
            
        if (resJson.data.solarRadiation !== undefined && !isNaN(resJson.data.solarRadiation) && resJson.data.solarRadiation >= 0) {
            dynamicWeather.solarRadiation = resJson.data.solarRadiation;
        }

            statusEl.style.display = "none";
            console.log("기상청 API 연동 성공:", dynamicWeather);
        } else {
            // 데이터 있지만 success:false (관측자료 준비 중)
            if (resJson.data) {
                dynamicWeather.temp = resJson.data.temp;
                dynamicWeather.humidity = resJson.data.humidity;
            }
            statusEl.textContent = resJson.message || "관측자료 수신 중...";
            statusEl.style.display = "block";
            console.warn("기상청 API 응답:", resJson);
        }
    } catch (err) {
        console.error("기상청 API 호출 에러:", err);
        statusEl.textContent = "백엔드 서버에 연결할 수 없습니다 (node server.js 실행 필요)";
        statusEl.style.display = "block";
    } finally {
        updatePowerCalculation();
    }
}

// --- 6. 초기화 ---
function loadEnvAndInit() {
    // API 키는 백엔드(server.js)가 관리하므로 프론트엔드에서는 바로 초기화
    document.getElementById('api-status-msg').style.display = "none";
    updateTimeAndBackground();
    trackUserLocation();
    updatePowerCalculation();
}

// --- 7. 이벤트 리스너 및 실시간 바인딩 ---
document.addEventListener("DOMContentLoaded", () => {
    loadEnvAndInit();

    // 1초마다 시각 업데이트, 5개 영역 시간대 체크 및 예측 발전량 갱신 (초당 오차 실시간 변동)
    setInterval(() => {
        updateTimeAndBackground();
        updatePowerCalculation();
    }, 1000);

    // 10분마다 날씨 정보 리프레시
    setInterval(fetchKMAWeatherData, 600000);

    // 패널 면적 슬라이더 핸들러
    const areaSlider = document.getElementById('panel-area-slider');
    const areaVal = document.getElementById('panel-area-val');
    areaSlider.addEventListener('input', (e) => {
        panelArea = parseInt(e.target.value);
        areaVal.textContent = panelArea;
        updatePowerCalculation();
    });
});

// ============================================================
// 터미널(F12 콘솔)에서 사용하는 디버그 API
// 사용법: solarDebug.enable()
// ============================================================
window.solarDebug = {
    /**
     * 디버그 모드 활성화
     * 예: debug.enable()
     */
    enable() {
        _debug.active = true;
        const now = new Date();
        _debug.hour   = now.getHours();
        _debug.minute = now.getMinutes();
        _debug.second = now.getSeconds();
        console.log('%c⚠️ 디버그 모드 활성화', 'color:#f90;font-weight:bold;font-size:14px');
        console.log('다음 명령어를 사용하세요:');
        console.table([
            { 명령어: 'debug.setHour(h)',        설명: '시간대 테스트 (h: 0~23)' },
            { 명령어: 'debug.setTime(h, m, s)',  설명: '시분초 직접 지정 (m,s 생략 가능)' },
            { 명령어: 'debug.next()',            설명: '다음 시간대로 이동' },
            { 명령어: 'debug.prev()',            설명: '이전 시간대로 이동' },
            { 명령어: 'debug.status()',          설명: '현재 디버그 상태 확인' },
            { 명령어: 'debug.disable()',         설명: '디버그 모드 종료' },
        ]);
        updateTimeAndBackground();
    },

    /**
     * 시 (hour)만 지정하여 시간대 전환
     * 예: debug.setHour(3)  → 새벽
     *      debug.setHour(8)  → 아침
     *      debug.setHour(13) → 정오
     *      debug.setHour(18) → 저녁
     *      debug.setHour(22) → 밤
     */
    setHour(h) {
        if (!_debug.active) { console.warn('먼저 debug.enable() 을 호출하세요.'); return; }
        h = ((h % 24) + 24) % 24;
        _debug.hour   = h;
        _debug.minute = 0;
        _debug.second = 0;
        const zone = _getZoneName(h);
        console.log(`%c⏰ 시간 설정: ${String(h).padStart(2,'0')}:00:00  → [${zone}]`, 'color:#4fc3f7;font-weight:bold');
        updateTimeAndBackground();
        updatePowerCalculation();
    },

    /**
     * 시분초를 직접 지정
     * 예: debug.setTime(14, 30)
     *      debug.setTime(2, 15, 45)
     */
    setTime(h, m = 0, s = 0) {
        if (!_debug.active) { console.warn('먼저 debug.enable() 을 호출하세요.'); return; }
        h = ((h % 24) + 24) % 24;
        m = Math.min(59, Math.max(0, m));
        s = Math.min(59, Math.max(0, s));
        _debug.hour   = h;
        _debug.minute = m;
        _debug.second = s;
        const hh = String(h).padStart(2,'0'), mm = String(m).padStart(2,'0'), ss = String(s).padStart(2,'0');
        const zone = _getZoneName(h);
        console.log(`%c⏰ 시간 설정: ${hh}:${mm}:${ss}  → [${zone}]`, 'color:#4fc3f7;font-weight:bold');
        updateTimeAndBackground();
        updatePowerCalculation();
    },

    /** 다음 시간대 시작 시각으로 점프 */
    next() {
        if (!_debug.active) { console.warn('먼저 debug.enable() 을 호출하세요.'); return; }
        const zones = [TIME_ZONES.DAWN, TIME_ZONES.MORNING, TIME_ZONES.NOON, TIME_ZONES.EVENING, TIME_ZONES.NIGHT];
        const cur = zones.findIndex(z => _debug.hour >= z.startHour && _debug.hour <= z.endHour);
        const next = zones[(cur + 1) % zones.length];
        this.setHour(next.startHour);
    },

    /** 이전 시간대 시작 시각으로 점프 */
    prev() {
        if (!_debug.active) { console.warn('먼저 debug.enable() 을 호출하세요.'); return; }
        const zones = [TIME_ZONES.DAWN, TIME_ZONES.MORNING, TIME_ZONES.NOON, TIME_ZONES.EVENING, TIME_ZONES.NIGHT];
        const cur = zones.findIndex(z => _debug.hour >= z.startHour && _debug.hour <= z.endHour);
        const prev = zones[(cur - 1 + zones.length) % zones.length];
        this.setHour(prev.startHour);
    },

    /** 현재 디버그 상태 확인 */
    status() {
        if (!_debug.active) { console.log('디버그 모드 비활성화 상태'); return; }
        const hh = String(_debug.hour).padStart(2,'0');
        const mm = String(_debug.minute).padStart(2,'0');
        const ss = String(_debug.second).padStart(2,'0');
        console.log(`%c[DEBUG STATUS]  시각: ${hh}:${mm}:${ss}  시간대: ${_getZoneName(_debug.hour)}`, 'color:#a5d6a7;font-weight:bold');
    },

    /** 디버그 모드 종료 → 실제 시간으로 복구 */
    disable() {
        _debug.active = false;
        console.log('%c✅ 디버그 모드 종료 — 실제 시간으로 복구됨', 'color:#81c784;font-weight:bold');
        updateTimeAndBackground();
        updatePowerCalculation();
    }
};

// 내부 헬퍼: 현재 시각으로 시간대 이름 반환
function _getZoneName(h) {
    if (h >= TIME_ZONES.DAWN.startHour    && h <= TIME_ZONES.DAWN.endHour)    return `새벽 (${TIME_ZONES.DAWN.startHour}~${TIME_ZONES.DAWN.endHour}시)`;
    if (h >= TIME_ZONES.MORNING.startHour && h <= TIME_ZONES.MORNING.endHour) return `아침 (${TIME_ZONES.MORNING.startHour}~${TIME_ZONES.MORNING.endHour}시)`;
    if (h >= TIME_ZONES.NOON.startHour    && h <= TIME_ZONES.NOON.endHour)    return `정오 (${TIME_ZONES.NOON.startHour}~${TIME_ZONES.NOON.endHour}시)`;
    if (h >= TIME_ZONES.EVENING.startHour && h <= TIME_ZONES.EVENING.endHour) return `저녁 (${TIME_ZONES.EVENING.startHour}~${TIME_ZONES.EVENING.endHour}시)`;
    return `밤 (${TIME_ZONES.NIGHT.startHour}~${TIME_ZONES.NIGHT.endHour}시)`;
}

console.log('%c태양광 시뮬레이터 로드 완료 — 디버그 모드: solarDebug.enable()', 'color:#ffb74d;font-weight:bold;font-size:13px');

