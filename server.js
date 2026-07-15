const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, './')));

// 대한민국 주요 도시별 ASOS 기상관측소 지점 번호 매핑 (기장 가깝거나 대표 지점)
// 서울: 108, 인천: 112, 수원: 119, 부산: 159, 대구: 143, 대전: 133, 광주: 156, 울산: 152, 제주: 184
function getNearestStation(lat, lon) {
    const stations = [
        { id: 108, name: "서울", lat: 37.5714, lon: 126.9658 },
        { id: 112, name: "인천", lat: 37.4776, lon: 126.6244 },
        { id: 119, name: "수원", lat: 37.2723, lon: 126.9853 },
        { id: 133, name: "대전", lat: 36.3720, lon: 127.3742 },
        { id: 156, name: "광주", lat: 35.1729, lon: 126.8916 },
        { id: 143, name: "대구", lat: 35.8779, lon: 128.6529 },
        { id: 159, name: "부산", lat: 35.1047, lon: 129.0320 },
        { id: 152, name: "울산", lat: 35.5822, lon: 129.3347 },
        { id: 184, name: "제주", lat: 33.5141, lon: 126.5297 },
        { id: 101, name: "춘천", lat: 37.9026, lon: 127.7357 },
        { id: 131, name: "청주", lat: 36.6380, lon: 127.4429 },
        { id: 138, name: "포항", lat: 36.0322, lon: 129.3800 },
        { id: 165, name: "목포", lat: 34.8166, lon: 126.3812 },
        { id: 168, name: "여수", lat: 34.7397, lon: 127.7408 },
        { id: 146, name: "전주", lat: 35.8400, lon: 127.1188 }
    ];

    let minOffset = Infinity;
    let closestStationId = 108; // 기본 서울

    stations.forEach(st => {
        const offset = Math.pow(st.lat - lat, 2) + Math.pow(st.lon - lon, 2);
        if (offset < minOffset) {
            minOffset = offset;
            closestStationId = st.id;
        }
    });

    return closestStationId;
}

// 기상청 API허브 typ01 ASOS 관측 데이터 호출 우회 프록시
app.get('/api/weather', async (req, res) => {
    const { lat, lon } = req.query;
    const authKey = process.env.KMA_AUTH_KEY;

    if (!authKey || authKey === "your_kma_auth_key_here" || authKey.trim() === "") {
        return res.status(400).json({
            error: "API_KEY_MISSING",
            message: "서버 .env 파일에 KMA_AUTH_KEY를 올바르게 입력해주세요."
        });
    }

    // 시간 포맷 생성 (현재 시각 기준으로 60분전 관측 데이터 조회 - 정시 기준)
    const now = new Date();
    now.setMinutes(now.getMinutes() - 60); // 60분 전 정시 데이터 조회

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const tm = `${year}${month}${day}${hour}00`; // 분은 항상 00 (정시 관측)

    // 위경도 기반 가까운 관측소 ID 판별
    const stationId = (lat && lon) ? getNearestStation(parseFloat(lat), parseFloat(lon)) : 108;

    // kma_sfctm2.php API 호출 (typ01 리소스)
    const targetUrl = `https://apihub.kma.go.kr/api/typ01/url/kma_sfctm2.php` +
                      `?tm=${tm}` +
                      `&stn=${stationId}` +
                      `&help=0` +
                      `&authKey=${authKey}`;

    try {
        console.log(`기상청 API허브(typ01) 호출: ${targetUrl}`);
        const apiResponse = await fetch(targetUrl);
        
        if (!apiResponse.ok) {
            throw new Error(`기상청 응답 오류: ${apiResponse.statusText}`);
        }

        const rawText = await apiResponse.text();
        
        // typ01 API 데이터는 텍스트 라인 단위로 결과가 옴
        // 기상 데이터 파싱 로직
        const lines = rawText.split('\n');
        let weatherData = null;

        for (let line of lines) {
            line = line.trim();
            // 주석(#)이 아니고 숫자로 시작하는 실 데이터 줄 감지
            if (line && !line.startsWith('#') && /^\d{12}/.test(line)) {
                const parts = line.split(/\s+/);
                // typ01 kma_sfctm2 실제 포맷 (공백 구분 컬럼 인덱스):
                // parts[0]: TM (년월일시분, 12자리)
                // parts[1]: STN (지점번호)
                // parts[2]: WD (풍향)
                // parts[3]: WS (풍속)
                // parts[4]: GST_WD (최대순간풍향)
                // parts[5]: GST_WS (최대순간풍속)
                // parts[6]: GST_TM (최대순간풍속 시각)
                // parts[7]: PA (현지기압)
                // parts[8]: PS (해면기압)
                // parts[9]: PT (기압변화종류)
                // parts[10]: PR (기압변화량)
                // parts[11]: TA (기온 C) ★
                // parts[12]: TD (이슬점온도)
                // parts[13]: HM (상대습도 %) ★
                // parts[29]: SI (일사강도 MJ/m2) ★
                
                const tempVal = parseFloat(parts[11]);
                const humidityVal = parseFloat(parts[13]);
                let solarVal = parseFloat(parts[29]);

                // 기상청 관측값 예외 (-9 또는 누락) 처리
                const temp = isNaN(tempVal) || tempVal <= -9 ? 20.0 : tempVal;
                const humidity = isNaN(humidityVal) || humidityVal <= -9 ? 50.0 : humidityVal;
                
                // 일사강도가 유효하지 않으면 0
                let solarRadiation = 0;
                if (!isNaN(solarVal) && solarVal > 0 && solarVal > -9.0) {
                    // 일사량 단위 환산 (MJ/m^2 -> W/m^2: 1MJ/m^2 = 277.78 Wh/m^2 -> 순간값 근사)
                    solarRadiation = Math.round(solarVal * 277.78);
                }

                console.log(`파싱 결과: TA=${temp}°C, HM=${humidity}%, SI_raw=${solarVal}, SI_W=${solarRadiation}W/m²`);

                weatherData = {
                    temp,
                    humidity,
                    solarRadiation
                };
                break;
            }
        }

        if (weatherData) {
            return res.json({ success: true, data: weatherData });
        } else {
            // 관측 정보가 아직 준비되지 않은 시간대인 경우 대체 모의값 리턴
            console.warn(`해당 시간(${tm}) 관측자료 없음 - 대체 데이터 활용`);
            return res.json({
                success: false,
                message: "해당 시간 관측 자료 준비중",
                data: { temp: 21.0, humidity: 45.0, solarRadiation: 0 }
            });
        }

    } catch (error) {
        console.error("기상청 API Proxy 호출 중 서버 오류:", error);
        return res.status(500).json({
            error: "SERVER_COMMUNICATION_FAILED",
            message: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(` 태양광 시뮬레이터 백엔드 프록시 서버 기동 완료`);
    console.log(` 접속 주소: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
