/* =========================================================
 * Pika Park — config.js (Firebase 설정값 전용 파일)
 *
 * Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹)에서 복사한 값을 넣으세요.
 * game.js를 새 버전으로 바꿔도 이 파일은 그대로 두면 됩니다.
 *
 * 이 값들은 공개되어도 괜찮은 "클라이언트 식별 정보"입니다.
 * 서비스 계정 키, 관리자 키, 데이터베이스 비밀값은 절대 넣지 마세요.
 * 데이터 보호는 database.rules.json 보안 규칙이 담당합니다.
 * ========================================================= */
window.PIKA_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDYo9StwyC18_SXAIx2In8VXOPwFspnLeI",
  authDomain: "pokepika-9052f.firebaseapp.com",
  databaseURL: "https://pokepika-9052f-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "pokepika-9052f",
  appId: "1:870330758109:web:f7dbb3eb0cdd29ad8bbc34"
};

/* 운영진 가상 이메일 도메인
 * 운영진 로그인 칸에 아이디만 입력하면(예: admin1) 이 도메인을 붙여
 * admin1@pikapark.admin 으로 로그인합니다. 실제로 존재하는 메일 주소일 필요는 없어요.
 * Firebase 콘솔에서 운영진 계정을 만들 때도 같은 형식(아이디@이 도메인)을 쓰세요. */
window.PIKA_SETTINGS = {
  adminEmailDomain: "pikapark.admin"
};
