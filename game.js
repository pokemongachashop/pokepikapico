'use strict';
/* =================================================================
 * Pika Park (피카파크) — game.js
 *
 *  1. 설정            2. 유틸            3. 픽셀 아트(캐릭터·타일)
 *  4. 스테이지 데이터  5. 스테이지 빌더   6. 입력(키보드·터치·봇)
 *  7. 공용 UI         8. Firebase 연결   9. 방 만들기/참가/나가기
 * 10. 게임 진행(운영진·방장) 11. 월드 상태·네트워크 동기화
 * 12. 물리·충돌       13. Phaser 씬·렌더  14. HUD·결과 화면
 * 15. 부트
 *
 * 구조 원칙
 *  - 각 클라이언트는 "자기 캐릭터만" 물리 계산하고 위치를 Firebase에 보낸다.
 *  - 다른 플레이어는 받은 위치를 보간해서 그린다(렌더 주기 ≠ 전송 주기).
 *  - 움직이는 발판/톱니는 "서버 시간 기준 결정론적 함수"라 동기화 트래픽이 없다.
 *  - 방 만들기·게임 시작·다음 스테이지·재도전은 운영진(admins 등록 계정)만 한다.
 *  - 방장(host)은 자동 관리 담당: 끊긴 플레이어 정리, 클리어 판정(트랜잭션).
 *    방장이 나가면 남은 사람이 자동으로 넘겨받으므로 운영진이 잠시 끊겨도 클리어 판정은 계속된다.
 *  - 스테이지마다 seq(세션 번호)가 바뀌고, 퍼즐 상태는 puzzle/s{seq} 아래에
 *    저장되어 지난 스테이지의 늦은 이벤트가 새 스테이지를 덮어쓰지 못한다.
 * ================================================================= */
(function () {

/* -----------------------------------------------------------------
 * 1. 설정
 * ----------------------------------------------------------------- */
const CFG = {
  T: 16,                 // 타일 크기(px)
  VIEW_W: 960, VIEW_H: 540, ZOOM: 2,   // 캔버스 960x540, 월드는 480x270으로 보임
  GRAVITY: 900, JUMP_V: 335, RUN: 92,
  ACCEL: 1000, AIR_ACCEL: 760, FRICTION: 1300,
  MAX_FALL: 420, COYOTE: 0.09, JUMP_BUFFER: 0.12, JUMP_CUT: 0.45,
  PW: 10, PH: 13,        // 캐릭터 충돌 박스
  MIN_PLAYERS: 2, MAX_PLAYERS: 20,
  // 위치 전송 간격: 인원이 많을수록 조금 느리게 (150~250ms)
  SEND_MIN_MS: 70, SEND_BASE_MS: 150, SEND_PER_PLAYER_MS: 5, SEND_MAX_MS: 250,
  INTERP_RATE: 14, EXTRAP_MAX_MS: 250, SNAP_DIST: 80,
  COUNTDOWN_MS: 3000,
  CRUMBLE_SHAKE_MS: 650, CRUMBLE_RESTORE_MS: 3600,
  RESPAWN_MS: 900,
  HOST_TICK_MS: 1000, TAKEOVER_TICK_MS: 2000, HOST_OFFLINE_GRACE_MS: 6000,
  OFFLINE_REMOVE_MS: 90000,      // 90초 이상 끊긴 플레이어는 방장이 정리
  LAST_ACTIVE_MS: 60000,
  ROOM_STALE_MS: 6 * 3600 * 1000, // 6시간 활동 없는 방은 정리 대상
  AUTO_REJOIN_MS: 2 * 3600 * 1000,
  NAME_MAX: 12,
  BG_PARALLAX: 0.35,
};
const T = CFG.T;

// 20명 색상: 비슷한 색이 연달아 배정되지 않도록 순서를 섞어 둠
const PALETTE = [
  { name: '노랑', body: '#f8d030' }, { name: '하늘', body: '#58b8f8' },
  { name: '분홍', body: '#f878b8' }, { name: '초록', body: '#58c858' },
  { name: '주황', body: '#f89838' }, { name: '보라', body: '#a070e0' },
  { name: '민트', body: '#58e0c0' }, { name: '빨강', body: '#e84848' },
  { name: '하양', body: '#f2f2f2' }, { name: '남색', body: '#4a66c8' },
  { name: '연두', body: '#b4e04a' }, { name: '자홍', body: '#d24ccb' },
  { name: '청록', body: '#22a4a4' }, { name: '살구', body: '#f8bc94' },
  { name: '회색', body: '#9a9aa4' }, { name: '황금', body: '#d8a020' },
  { name: '라벤더', body: '#c4acf2' }, { name: '올리브', body: '#8c9c32' },
  { name: '산호', body: '#ff7f6e' }, { name: '코코아', body: '#b48462' },
];

const QS = new URLSearchParams(location.search);
const TEST_MODE = QS.has('test');   // 탭마다 다른 익명 사용자(부하 테스트용)
const BOT_MODE = QS.has('bot');     // 자동으로 움직이는 테스트 봇
const DEBUG = QS.has('debug');

/* -----------------------------------------------------------------
 * 2. 유틸
 * ----------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const approach = (v, t, d) => (v < t ? Math.min(v + d, t) : Math.max(v - d, t));
const log = (...a) => console.log('%c[PikaPark]', 'color:#c9a012', ...a);
const warn = (...a) => console.warn('[PikaPark]', ...a);
const dbg = (...a) => { if (DEBUG) console.log('[PikaPark:debug]', ...a); };
const TS = () => firebase.database.ServerValue.TIMESTAMP;

function randomId(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[arr[i] % chars.length];
  return s;
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 I, O, 0, 1 제외
function randomCode() {
  const arr = new Uint32Array(5);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[arr[i] % CODE_CHARS.length];
  return s;
}
const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m > 0 ? `${m}분 ${r.toFixed(1)}초` : `${r.toFixed(1)}초`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function sanitizeName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, CFG.NAME_MAX);
}
function boxOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
function hOverlap(ax, aw, bx, bw) { return Math.min(ax + aw, bx + bw) - Math.max(ax, bx); }
function vOverlap(ay, ah, by, bh) { return Math.min(ay + ah, by + bh) - Math.max(ay, by); }
function circleBox(cx, cy, r, bx, by, bw, bh) {
  const nx = clamp(cx, bx, bx + bw), ny = clamp(cy, by, by + bh);
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function storageSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* 사생활 보호 모드 등 */ } }

/* -----------------------------------------------------------------
 * 3. 픽셀 아트 (직접 그린 16x16 캐릭터 · 타일)
 *    o=외곽선 k=귀 끝(검정) y=몸(플레이어 색) s=몸 그림자 r=볼(빨강)
 *    e=눈 m=입 n=등 줄무늬(갈색)
 *    → 'y'/'s' 영역만 플레이어 색으로 칠하고 나머지는 고정색이라
 *      귀 끝·볼·줄무늬는 색이 바뀌지 않는다.
 *    나중에 스프라이트 이미지로 바꾸려면 drawPika()만 교체하면 된다.
 * ----------------------------------------------------------------- */
const PIKA_BASE = [
  '...o.......o....',
  '..oko.....oko...',
  '..oko.....oko...',
  '..oyo.....oyo...',
  '..oyyo...oyyo...',
  '..oyyyoooyyyo...',
  '.oyyyyyyyyyyyo..',
  '.oyyyyyyeyyyeo..',
  '.oyyyyyyyyyyyo..',
  '.oyryyyyyymrro..',
  '..oyyyyyyyyyo...',
  '..onyyyyyyyyo...',
  '...oyyyyyyyo....',
  '...oyyyyyyyo....',
  '...ossooosso....',
  '................',
];
const PIKA_FRAMES = {
  idle: {},
  idle2: { shift: 1 },
  walk1: { 14: '..oss....osso...' },
  walk2: { 13: '...oyyyyyyyo....', 14: '....osssso......' },
  jump: { 12: '..oyyyyyyyyyo...', 13: '...oyyyyyyyo....', 14: '....oso.oso.....' },
  fall: { 14: '..oso.....oso...' },
  hurt: { 7: '.oyyyyykkyykko..', 9: '.oyryyyyyykrro..' },
  clear: { 6: '.oyyyyyyeyyyeo..', 7: '.oyyyyyeyeyeyo..', 9: '.oyryyyyyykrro..' },
};
const PIKA_FRAME_NAMES = Object.keys(PIKA_FRAMES);
const PIKA_FIXED = { o: '#2b1b10', k: '#1c1410', r: '#e8483c', e: '#1c1410', m: '#7a2a1a', n: '#8a5a2b', w: '#ffffff' };
// 애니메이션 코드(네트워크 전송용)
const ANIM = { IDLE: 0, WALK: 1, JUMP: 2, FALL: 3, HURT: 4, CLEAR: 5 };

function pikaRows(frame) {
  const f = PIKA_FRAMES[frame] || {};
  let rows = PIKA_BASE.slice();
  for (const k of Object.keys(f)) if (/^\d+$/.test(k)) rows[+k] = f[k];
  if (f.shift) rows = ['.'.repeat(16)].concat(rows.slice(0, 15));
  return rows;
}
function shadeHex(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => clamp(Math.round(v * f), 0, 255).toString(16).padStart(2, '0');
  return '#' + ch((n >> 16) & 255) + ch((n >> 8) & 255) + ch(n & 255);
}
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return c;
}
function mk(w, h, fn) { const c = makeCanvas(w, h); fn(c.getContext('2d'), w, h); return c; }
function px(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); }

function drawPika(colorIdx, frame, scale) {
  scale = scale || 1;
  const body = PALETTE[((colorIdx % PALETTE.length) + PALETTE.length) % PALETTE.length].body;
  const dark = shadeHex(body, 0.7);
  const rows = pikaRows(frame);
  const c = makeCanvas(16 * scale, 16 * scale);
  const g = c.getContext('2d');
  for (let y = 0; y < 16; y++) {
    const row = rows[y] || '';
    for (let x = 0; x < 16; x++) {
      const ch = row[x];
      if (!ch || ch === '.') continue;
      g.fillStyle = ch === 'y' ? body : ch === 's' ? dark : (PIKA_FIXED[ch] || '#ff00ff');
      g.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return c;
}
const PREVIEW_CACHE = {};
function pikaPreviewURL(colorIdx) {
  if (!PREVIEW_CACHE[colorIdx]) PREVIEW_CACHE[colorIdx] = drawPika(colorIdx, 'idle', 2).toDataURL();
  return PREVIEW_CACHE[colorIdx];
}

const PLATE_COLORS = { a: '#e85a5a', b: '#4f8ef0', c: '#47c463', d: '#b072e6', e: '#f2a533', f: '#2fc4c4' };
const THEMES = [
  { sky: '#9fd8f7', cloud: '#ffffff', far: '#a9d9c2', near: '#7cc29d' },
  { sky: '#ffd6ad', cloud: '#fff4e6', far: '#e9ae90', near: '#cf927d' },
  { sky: '#aebcf2', cloud: '#eef0ff', far: '#8f9edb', near: '#7183c6' },
  { sky: '#2d3366', cloud: '#4c5390', far: '#3b4380', near: '#283068', stars: true },
];

let ART = null;
function buildArt() {
  const A = {};
  A.dirt = mk(16, 16, (g) => {
    px(g, 0, 0, 16, 16, '#c98a52');
    [[2, 3], [10, 2], [13, 9], [5, 11], [8, 6], [1, 13], [11, 13]].forEach(([x, y]) => px(g, x, y, 2, 2, '#ad6d3c'));
    [[6, 1], [14, 5], [3, 7], [9, 12]].forEach(([x, y]) => px(g, x, y, 1, 1, '#e3aa74'));
  });
  A.grass = mk(16, 16, (g) => {
    g.drawImage(A.dirt, 0, 0);
    px(g, 0, 0, 16, 4, '#5cbf4a');
    px(g, 0, 0, 16, 1, '#93e56d');
    px(g, 0, 4, 16, 1, '#3d9135');
    [1, 6, 11].forEach((x) => { px(g, x, 4, 2, 2, '#5cbf4a'); px(g, x, 6, 2, 1, '#3d9135'); });
  });
  A.brick = mk(16, 16, (g) => {
    const m = '#6e3020', hi = '#dc8361';
    px(g, 0, 0, 16, 16, '#b95d3d');
    px(g, 0, 7, 16, 1, m); px(g, 0, 15, 16, 1, m);
    px(g, 7, 0, 1, 7, m); px(g, 15, 0, 1, 7, m); px(g, 3, 8, 1, 7, m); px(g, 11, 8, 1, 7, m);
    px(g, 0, 0, 7, 1, hi); px(g, 8, 0, 7, 1, hi); px(g, 0, 8, 3, 1, hi); px(g, 4, 8, 7, 1, hi); px(g, 12, 8, 4, 1, hi);
  });
  A.oneway = mk(16, 16, (g) => {
    px(g, 0, 0, 16, 5, '#7a4b22');
    px(g, 1, 1, 14, 3, '#d89a52');
    px(g, 0, 0, 16, 1, '#f0c27a');
    px(g, 7, 1, 1, 3, '#7a4b22');
    px(g, 2, 5, 2, 2, '#7a4b22'); px(g, 12, 5, 2, 2, '#7a4b22');
  });
  A.spike = mk(16, 16, (g) => {
    for (let i = 0; i < 2; i++) {
      const ox = i * 8;
      for (let r = 0; r < 7; r++) {
        const half = Math.floor(r / 2) + 1;
        px(g, ox + 4 - half, 8 + r, half * 2, 1, r === 0 ? '#ffffff' : '#d7d9e3');
        px(g, ox + 4 - half, 8 + r, 1, 1, '#8a8da0');
      }
    }
    px(g, 0, 15, 16, 1, '#5b5e70');
  });
  const crumbleBase = (g) => {
    px(g, 0, 0, 16, 16, '#e3c27a');
    px(g, 0, 0, 16, 1, '#f6dfa4'); px(g, 0, 0, 1, 16, '#f0d494');
    px(g, 0, 15, 16, 1, '#9a7a3a'); px(g, 15, 0, 1, 16, '#9a7a3a');
    px(g, 5, 3, 1, 4, '#b08c48'); px(g, 6, 6, 3, 1, '#b08c48'); px(g, 11, 9, 1, 4, '#b08c48');
  };
  A.crumble = mk(16, 16, crumbleBase);
  A.crumble2 = mk(16, 16, (g) => {
    crumbleBase(g);
    px(g, 2, 9, 5, 1, '#7d5f26'); px(g, 6, 9, 1, 5, '#7d5f26'); px(g, 9, 2, 1, 6, '#7d5f26'); px(g, 9, 7, 5, 1, '#7d5f26');
  });
  A.door = {}; A.plate = {};
  for (const l of Object.keys(PLATE_COLORS)) {
    const c = PLATE_COLORS[l], dark = shadeHex(c, 0.5), light = shadeHex(c, 1.35);
    A.door[l] = mk(16, 16, (g) => {
      px(g, 1, 0, 14, 16, dark);
      px(g, 2, 0, 12, 16, c);
      px(g, 2, 0, 12, 1, light);
      px(g, 5, 0, 1, 16, dark); px(g, 10, 0, 1, 16, dark);
      px(g, 7, 6, 2, 3, '#ffffffaa');
    });
    A.plate[l] = [false, true].map((pressed) => mk(16, 16, (g) => {
      px(g, 0, 13, 16, 3, '#4b4766'); px(g, 0, 13, 16, 1, '#6c6790');
      if (pressed) { px(g, 2, 12, 12, 1, c); px(g, 2, 12, 12, 1, light); }
      else { px(g, 2, 9, 12, 4, c); px(g, 2, 9, 12, 1, light); px(g, 2, 12, 12, 1, dark); }
    }));
  }
  A.plateOff = mk(16, 16, (g) => { px(g, 0, 13, 16, 3, '#4b4766'); px(g, 2, 12, 12, 1, '#77738f'); });
  A.key = mk(14, 10, (g) => {
    px(g, 0, 1, 6, 8, '#6b4c00'); px(g, 1, 2, 4, 6, '#ffd23f'); px(g, 2, 4, 2, 2, '#6b4c00');
    px(g, 5, 3, 9, 3, '#6b4c00'); px(g, 5, 4, 8, 1, '#ffd23f');
    px(g, 9, 6, 2, 3, '#6b4c00'); px(g, 12, 6, 2, 3, '#6b4c00'); px(g, 9, 6, 1, 2, '#ffd23f');
    px(g, 1, 2, 1, 1, '#fff6c8');
  });
  const exitFrame = (g) => {
    px(g, 0, 0, 16, 32, '#3d2414');
    px(g, 1, 1, 14, 31, '#5a361d');
    px(g, 0, 0, 16, 2, '#6b4024');
  };
  A.exitClosed = mk(16, 32, (g) => {
    exitFrame(g);
    px(g, 3, 3, 10, 29, '#8a5a30');
    px(g, 4, 5, 8, 9, '#9e6a3b'); px(g, 4, 18, 8, 11, '#9e6a3b');
    px(g, 5, 14, 6, 5, '#ffd23f'); px(g, 6, 12, 4, 2, '#6b4c00'); px(g, 7, 13, 2, 1, '#3d2414');
    px(g, 7, 15, 2, 3, '#6b4c00');
  });
  A.exitOpen = mk(16, 32, (g) => {
    exitFrame(g);
    px(g, 3, 3, 10, 29, '#1b1430');
    [[5, 8], [10, 12], [7, 18], [11, 24], [5, 26]].forEach(([x, y]) => px(g, x, y, 1, 1, '#ffd23f'));
    px(g, 6, 13, 4, 1, '#fff6c8'); px(g, 7, 12, 2, 3, '#fff6c8');
  });
  A.flag = [false, true].map((on) => mk(16, 16, (g) => {
    px(g, 3, 1, 2, 15, '#4d4a60'); px(g, 3, 1, 1, 15, '#d0d0d8');
    px(g, 5, 2, 9, 6, on ? '#2f9e57' : '#55536a');
    px(g, 5, 2, 9, 1, on ? '#5ee08a' : '#7d7a90');
    px(g, 1, 15, 6, 1, '#4d4a60');
  }));
  A.saw = mk(16, 16, (g) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d <= 5.6) px(g, x, y, 1, 1, d > 4.4 ? '#5b5e70' : '#b8bccb');
    }
    [[7, 0], [7, 14], [0, 7], [14, 7], [2, 2], [12, 2], [2, 12], [12, 12]].forEach(([x, y]) => px(g, x, y, 2, 2, '#d7d9e3'));
    px(g, 6, 6, 4, 4, '#5b5e70'); px(g, 7, 7, 2, 2, '#e84848');
  });
  return A;
}
function moverCanvas(wTiles) {
  const w = wTiles * T;
  return mk(w, 8, (g) => {
    px(g, 0, 0, w, 8, '#4a3b6a');
    px(g, 1, 1, w - 2, 5, '#8f78c8');
    px(g, 0, 0, w, 2, '#c9b3ff');
    for (let i = 0; i < wTiles; i++) px(g, i * 16 + 7, 3, 2, 2, '#4a3b6a');
  });
}
function makeBackground(themeIdx, worldW, worldH) {
  const th = THEMES[themeIdx % THEMES.length];
  const W = Math.ceil(CFG.VIEW_W / CFG.ZOOM + Math.max(0, worldW - CFG.VIEW_W / CFG.ZOOM) * CFG.BG_PARALLAX) + 32;
  const H = Math.max(worldH, CFG.VIEW_H / CFG.ZOOM) + 8;
  const rnd = mulberry32(1234 + themeIdx * 77);
  return mk(W, H, (g) => {
    px(g, 0, 0, W, H, th.sky);
    if (th.stars) for (let i = 0; i < W / 6; i++) px(g, Math.floor(rnd() * W), Math.floor(rnd() * H * 0.6), 1, 1, rnd() < 0.3 ? '#ffd23f' : '#dfe4ff');
    for (let i = 0; i < W / 110; i++) {
      const cx = Math.floor(rnd() * W), cy = 16 + Math.floor(rnd() * 70), s = 1 + Math.floor(rnd() * 2);
      px(g, cx, cy, 24 * s, 6 * s, th.cloud);
      px(g, cx + 4 * s, cy - 4 * s, 12 * s, 4 * s, th.cloud);
      px(g, cx + 14 * s, cy - 2 * s, 8 * s, 2 * s, th.cloud);
    }
    const hill = (base, amp, f1, f2, color) => {
      for (let x = 0; x < W; x += 4) {
        const h = base + amp * Math.sin(x / f1) + amp * 0.5 * Math.sin(x / f2 + 1.7);
        const y = Math.floor((H - h) / 4) * 4;
        px(g, x, y, 4, H - y, color);
      }
    };
    hill(96, 22, 53, 19, th.far);
    hill(60, 16, 37, 13, th.near);
  });
}

/* -----------------------------------------------------------------
 * 4. 스테이지 데이터 (모두 피카파크 독자 설계)
 *  tiles: [문자, x1, y1, x2?, y2?]  — 사각형으로 채움(포함 범위)
 *   '#' 지면  '%' 벽돌  '-' 아래에서 통과 가능한 발판  '^' 가시
 *   'x' 밟으면 무너지는 블록  '*' 열쇠  '@' 출구(아래쪽 칸 기준, 2칸 높이)
 *   '!' 체크포인트  'S' 시작 지점
 *   'a'~'f' 스위치(같은 글자는 하나의 스위치)  'A'~'F' 문
 *   '3'~'9' 스테이지 시작 인원이 그 숫자 이상일 때만 생기는 벽돌(탑 높이 조절)
 *  movers: 움직이는 발판 {x,y(윗면 타일행),w,dx,dy,ms,ph}
 *  saws:   톱니 {x,y(중심 타일),dx,dy,ms,ph}
 *  need:   스위치별 필요 인원 함수 (기본 1명, 0이면 비활성)
 *  doors:  문이 열리는 조건 [[스위치들 모두]] 중 하나라도 만족하면 열림 (기본: 같은 글자 소문자)
 * ----------------------------------------------------------------- */
const GH = 17; // 스테이지 높이(타일)
const ground = (x1, x2, top) => ['#', x1, top == null ? 13 : top, x2, GH - 1];

const STAGES = [
  { // 1
    title: '첫 걸음',
    hint: '이동하고 점프해서 열쇠를 주워요. 열쇠를 든 사람이 출구 문에 닿으면 문이 열리고, 모두 들어가면 클리어!',
    w: 68, h: GH, theme: 0,
    tiles: [
      ground(0, 17), ground(21, 45), ['%', 27, 11, 28, 12],
      ['%', 36, 10, 39, 10], ['%', 41, 7, 44, 7], ['*', 42, 6],
      ground(49, 67), ['-', 52, 10, 55, 10],
      ['!', 33, 12], ['@', 63, 12], ['S', 3, 12],
    ],
  },
  { // 2
    title: '어깨를 빌려줘',
    hint: '열쇠가 너무 높아요! 친구 머리 위에 올라가서 점프해 보세요.',
    w: 62, h: GH, theme: 0,
    tiles: [
      ground(0, 38), ['%', 22, 9, 25, 12], ['*', 23, 8],
      ['%', 33, 10, 34, 12], ground(42, 61), ['%', 48, 11, 49, 12],
      ['!', 37, 12], ['@', 57, 12], ['S', 3, 12],
    ],
  },
  { // 3
    title: '함께 누르는 스위치',
    hint: '스위치 위 숫자만큼 올라가 있어야 문이 열려요. 먼저 건너간 친구가 문 너머 스위치로 남은 친구를 불러 주세요.',
    w: 64, h: GH, theme: 1,
    tiles: [
      ground(0, 63),
      ['%', 24, 0, 24, 6], ['A', 24, 7, 24, 12],
      ['a', 15, 12, 18, 12],
      ['%', 6, 10, 9, 10], ['c', 6, 9, 9, 9],
      ['b', 28, 12, 30, 12],
      ['%', 36, 11, 37, 12], ['*', 36, 10],
      ['%', 46, 0, 46, 6], ['B', 46, 7, 46, 12],
      ['d', 40, 12, 43, 12], ['e', 50, 12, 52, 12],
      ['!', 33, 12], ['@', 58, 12], ['S', 3, 12],
    ],
    need: {
      a: (n) => (n < 4 ? 1 : Math.floor(n / 3)),
      c: (n) => (n < 4 ? 0 : Math.floor(n / 3)),
      d: (n) => Math.max(1, Math.ceil(n / 2) - 1),
    },
    doors: { A: [['a', 'c'], ['b']], B: [['d'], ['e']] },
  },
  { // 4
    title: '흔들리는 발판',
    hint: '움직이는 발판에 올라타 건너가요. 떨어지면 마지막 체크포인트에서 다시 시작해요.',
    w: 72, h: GH, theme: 0,
    tiles: [
      ground(0, 12), ['^', 13, 16, 25, 16],
      ['#', 26, 12, 29, 16], ['!', 27, 11],
      ['^', 30, 16, 43, 16],
      ['#', 44, 11, 47, 16], ['*', 45, 10], ['!', 46, 10],
      ['^', 48, 16, 52, 16], ground(53, 71),
      ['@', 67, 12], ['S', 3, 12],
    ],
    movers: [
      { x: 14, y: 11, w: 3, dx: 7, dy: 0, ms: 3600 },
      { x: 31, y: 11, w: 3, dx: 8, dy: 0, ms: 3400, ph: 0.5 },
      { x: 48, y: 11, w: 2, dx: 3, dy: 0, ms: 2200 },
    ],
  },
  { // 5
    title: '피카 탑 쌓기',
    hint: '머리 위에 차곡차곡 올라가 벽을 넘어요! 인원이 많을수록 벽이 높아져요. 벽 너머 스위치를 밟으면 아래 문이 열려요.',
    w: 58, h: GH, theme: 2,
    tiles: [
      ground(0, 57),
      ['%', 22, 9, 24, 12], ['A', 22, 11, 24, 12], ['3', 22, 8, 24, 8], ['4', 22, 7, 24, 7],
      ['*', 23, 5],
      ['a', 28, 12, 30, 12], ['!', 33, 12], ['%', 40, 11, 41, 12],
      ['@', 52, 12], ['S', 3, 12],
    ],
  },
  { // 6
    title: '위와 아래',
    hint: '위층 스위치는 아래층 문을, 아래층 스위치는 위층 문을 열어요. 위·아래로 역할을 나눠 보세요!',
    w: 64, h: GH, theme: 1,
    tiles: [
      ground(0, 63), ['%', 7, 10, 8, 12], ['%', 11, 7, 52, 7],
      ['A', 22, 8, 22, 12], ['B', 36, 0, 36, 6],
      ['a', 26, 6, 28, 6], ['b', 28, 12, 30, 12],
      ['*', 44, 6], ['!', 55, 12], ['@', 60, 12], ['S', 3, 12],
    ],
  },
  { // 7
    title: '톱니 주의',
    hint: '움직이는 톱니에 닿으면 체크포인트로 돌아가요. 패턴을 보고 타이밍을 맞춰 지나가요.',
    w: 82, h: GH, theme: 3,
    tiles: [
      ground(0, 81), ['%', 34, 10, 35, 10], ['*', 34, 9], ['!', 37, 12],
      ['%', 41, 0, 53, 9], ['!', 57, 12], ['%', 64, 11, 65, 12],
      ['@', 77, 12], ['S', 3, 12],
    ],
    saws: [
      { x: 14, y: 12, dx: 0, dy: -3, ms: 1800 },
      { x: 21, y: 9, dx: 0, dy: 3, ms: 1600, ph: 0.5 },
      { x: 27, y: 12, dx: 5, dy: 0, ms: 2600 },
      { x: 42, y: 12, dx: 10, dy: 0, ms: 3200 },
      { x: 60, y: 10, dx: 0, dy: 2, ms: 1400 },
      { x: 69, y: 12, dx: 5, dy: 0, ms: 2200, ph: 0.3 },
    ],
  },
  { // 8
    title: '무너지는 다리',
    hint: '밟은 블록은 잠시 뒤 무너지고 몇 초 뒤 다시 생겨요. 너무 붙어 가지 말고 차례로 건너요.',
    w: 72, h: GH, theme: 1,
    tiles: [
      ground(0, 10), ['x', 11, 13, 24, 13], ['^', 11, 16, 24, 16],
      ['#', 25, 13, 28, 16], ['!', 26, 12],
      ['x', 30, 11, 32, 11], ['x', 35, 9, 37, 9], ['*', 36, 8], ['x', 40, 11, 42, 11],
      ['^', 29, 16, 44, 16],
      ['x', 45, 13, 58, 13], ['^', 45, 16, 58, 16],
      ground(59, 71), ['!', 61, 12], ['@', 67, 12], ['S', 3, 12],
    ],
  },
  { // 9
    title: '모두의 힘',
    hint: '스위치, 발판, 무너지는 블록, 탑 쌓기까지! 배운 것을 모두 써 보세요.',
    w: 86, h: GH, theme: 2,
    tiles: [
      ground(0, 26), ['%', 16, 0, 16, 7], ['A', 16, 8, 16, 12],
      ['a', 9, 12, 12, 12], ['b', 19, 12, 21, 12],
      ['^', 27, 16, 44, 16], ['x', 36, 11, 38, 11],
      ground(45, 85), ['!', 47, 12],
      ['%', 55, 9, 57, 12], ['*', 56, 8],
      ['%', 66, 0, 66, 7], ['B', 66, 8, 66, 12], ['c', 59, 12, 62, 12], ['d', 70, 12, 72, 12],
      ['!', 74, 12], ['@', 81, 12], ['S', 3, 12],
    ],
    movers: [
      { x: 27, y: 11, w: 3, dx: 6, dy: 0, ms: 3000 },
      { x: 40, y: 11, w: 2, dx: 3, dy: 0, ms: 2200, ph: 0.5 },
    ],
    need: {
      a: (n) => Math.max(1, Math.floor(n / 3)),
      c: (n) => Math.max(1, Math.ceil(n / 3)),
    },
    doors: { A: [['a'], ['b']], B: [['c'], ['d']] },
  },
  { // 10
    title: '피카파크 대모험',
    hint: '마지막 스테이지! 탑 쌓기 → 발판과 톱니 → 동시 스위치 → 무너지는 다리 → 높은 곳의 열쇠. 다 같이 골인해요!',
    w: 112, h: GH, theme: 3,
    tiles: [
      ground(0, 30), ['%', 14, 9, 15, 12], ['A', 14, 11, 15, 12], ['3', 14, 8, 15, 8], ['4', 14, 7, 15, 7],
      ['a', 19, 12, 21, 12], ['!', 25, 12],
      ['^', 31, 16, 50, 16], ['#', 40, 12, 43, 16],
      ground(51, 70), ['!', 52, 12],
      ['b', 55, 12, 58, 12], ['%', 59, 10, 62, 10], ['c', 59, 9, 62, 9],
      ['%', 65, 0, 65, 7], ['B', 65, 8, 65, 12], ['d', 67, 12, 69, 12],
      ['x', 71, 13, 86, 13], ['^', 71, 16, 86, 16],
      ground(87, 111), ['!', 89, 12],
      ['%', 96, 9, 97, 12], ['3', 96, 8, 97, 8], ['*', 96, 5],
      ['@', 106, 12], ['S', 3, 12],
    ],
    movers: [
      { x: 31, y: 11, w: 3, dx: 5, dy: 0, ms: 3000 },
      { x: 44, y: 11, w: 3, dx: 3, dy: 0, ms: 2600, ph: 0.5 },
    ],
    saws: [
      { x: 41, y: 7, dx: 0, dy: 4, ms: 1600 },
      { x: 79, y: 9, dx: 0, dy: 3, ms: 1300 },
    ],
    need: {
      b: (n) => (n < 3 ? 1 : Math.max(1, Math.floor(n / 4))),
      c: (n) => (n < 3 ? 0 : Math.max(1, Math.floor(n / 4))),
    },
    doors: { A: [['a']], B: [['b', 'c'], ['d']] },
  },
];

/* -----------------------------------------------------------------
 * 5. 스테이지 빌더 — 데이터 → 실행용 구조
 * ----------------------------------------------------------------- */
function buildStage(idx, n) {
  const def = STAGES[idx];
  if (!def) throw new Error('잘못된 스테이지 번호: ' + idx);
  const W = def.w, H = def.h;
  const grid = [];
  for (let y = 0; y < H; y++) grid.push(new Array(W).fill('.'));
  for (const op of def.tiles) {
    const [ch, x1, y1, x2 = x1, y2 = y1] = op;
    for (let y = Math.max(0, y1); y <= Math.min(H - 1, y2); y++) {
      for (let x = Math.max(0, x1); x <= Math.min(W - 1, x2); x++) grid[y][x] = ch;
    }
  }
  const st = {
    idx, def, W, H, grid, n,
    spawn: null, exit: null, key: null, cps: [],
    plates: {}, doors: {}, crumbles: [], crumbleAt: new Map(),
    movers: [], saws: [],
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = grid[y][x];
      if (ch === 'S') { st.spawn = { x, y }; grid[y][x] = '.'; }
      else if (ch === '@') { st.exit = { x, y }; grid[y][x] = '.'; }
      else if (ch === '*') { st.key = { x, y }; grid[y][x] = '.'; }
      else if (ch === '!') { st.cps.push({ x, y }); grid[y][x] = '.'; }
      else if (ch >= '2' && ch <= '9') { grid[y][x] = n >= +ch ? '%' : '.'; }
      else if (ch >= 'a' && ch <= 'f') {
        const p = st.plates[ch] || (st.plates[ch] = { l: ch, tiles: [], minX: x, maxX: x, y });
        p.tiles.push({ x, y });
        p.minX = Math.min(p.minX, x); p.maxX = Math.max(p.maxX, x); p.y = Math.min(p.y, y);
      } else if (ch >= 'A' && ch <= 'F') {
        const d = st.doors[ch] || (st.doors[ch] = { L: ch, tiles: [] });
        d.tiles.push({ x, y });
      } else if (ch === 'x') {
        const c = { id: x + '_' + y, x, y };
        st.crumbles.push(c);
        st.crumbleAt.set(y * W + x, c);
      }
    }
  }
  if (!st.spawn || !st.exit) throw new Error('스테이지 데이터 오류: 시작점/출구 없음');
  st.cps.sort((a, b) => a.x - b.x);
  for (const l of Object.keys(st.plates)) {
    const fn = def.need && def.need[l];
    st.plates[l].needFn = typeof fn === 'function' ? fn : () => 1;
  }
  for (const L of Object.keys(st.doors)) {
    st.doors[L].rule = (def.doors && def.doors[L]) || [[L.toLowerCase()]];
  }
  // 발판: 이동 거리(tx,ty 타일)와 프레임별 이동량(dx,dy px)을 구분해 저장
  st.movers = (def.movers || []).map((m) => ({
    x0: m.x, y0: m.y, tx: m.dx || 0, ty: m.dy || 0, w: m.w || 3, ms: m.ms || 3000, ph: m.ph || 0,
    x: m.x * T, y: m.y * T, dx: 0, dy: 0, init: false,
  }));
  st.saws = (def.saws || []).map((s) => ({ ...s, ph: s.ph || 0, cx: 0, cy: 0 }));
  return st;
}
function tileCh(tx, ty) {
  const st = World.st;
  if (!st || ty < 0 || ty >= st.H || tx < 0 || tx >= st.W) return '.';
  return st.grid[ty][tx];
}
function pingPong(t, ms, ph) {
  const u = (((t / ms) + ph) % 1 + 1) % 1;
  const k = u < 0.5 ? u * 2 : 2 - u * 2;
  return k * k * (3 - 2 * k);
}
function updateMoving(tStage) {
  const st = World.st;
  for (const m of st.movers) {
    const e = pingPong(tStage, m.ms, m.ph);
    const nx = (m.x0 + m.tx * e) * T;
    const ny = (m.y0 + m.ty * e) * T;
    if (!m.init) { m.x = nx; m.y = ny; m.init = true; }
    m.dx = nx - m.x; m.dy = ny - m.y;   // 이번 프레임 이동량(위에 탄 사람을 같이 옮길 때 사용)
    m.x = nx; m.y = ny;
  }
  for (const s of st.saws) {
    const e = pingPong(tStage, s.ms, s.ph);
    s.cx = (s.x + 0.5 + s.dx * e) * T;
    s.cy = (s.y + 0.5 + s.dy * e) * T;
  }
}

/* -----------------------------------------------------------------
 * 6. 입력 (키보드 · 멀티터치 가상 버튼 · 테스트 봇)
 * ----------------------------------------------------------------- */
const Input = {
  kb: { left: false, right: false, jump: false },
  touch: { left: false, right: false, jump: false },
  bot: { left: false, right: false, jump: false },
  left: false, right: false, jumpHeld: false,
  jumpPresses: 0,
  edgeLeft: 0, edgeRight: 0,
  refresh() {
    this.left = this.kb.left || this.touch.left || this.bot.left;
    this.right = this.kb.right || this.touch.right || this.bot.right;
    this.jumpHeld = this.kb.jump || this.touch.jump || this.bot.jump;
  },
  consumeJump() { if (this.jumpPresses > 0) { this.jumpPresses = 0; return true; } return false; },
  reset() {
    for (const src of [this.kb, this.touch]) src.left = src.right = src.jump = false;
    this.jumpPresses = 0;
    document.querySelectorAll('.tbtn.pressed').forEach((b) => b.classList.remove('pressed'));
  },
};
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Space: 'jump', ArrowUp: 'jump', KeyW: 'jump',
};
function isTyping(el) { return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable); }
function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    const act = KEYMAP[e.code];
    if (!act || isTyping(e.target)) return;
    if (App.screen === 'game') e.preventDefault();      // 스크롤 등 브라우저 기본 동작 막기
    if (act === 'jump' && !e.repeat && !Input.kb.jump) Input.jumpPresses++;
    if (act === 'left' && !Input.kb.left) Input.edgeLeft++;
    if (act === 'right' && !Input.kb.right) Input.edgeRight++;
    Input.kb[act] = true;
  });
  window.addEventListener('keyup', (e) => {
    const act = KEYMAP[e.code];
    if (!act) return;
    Input.kb[act] = false;
  });
  window.addEventListener('blur', () => Input.reset());
}
function setupTouch() {
  const coarse = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window) || QS.has('touch');
  App.touchUI = coarse;
  document.querySelectorAll('.tbtn').forEach((btn) => {
    const act = btn.dataset.act;
    const ids = new Set();
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      ids.add(e.pointerId);
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
      if (act === 'jump') Input.jumpPresses++;       // 빠른 연타도 누락되지 않게 카운트
      if (act === 'left' && !Input.touch.left) Input.edgeLeft++;
      if (act === 'right' && !Input.touch.right) Input.edgeRight++;
      Input.touch[act] = true;
      btn.classList.add('pressed');
    });
    const up = (e) => {
      ids.delete(e.pointerId);
      if (ids.size === 0) { Input.touch[act] = false; btn.classList.remove('pressed'); }
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, up));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  // 게임 영역에서 길게 누르기·더블탭 확대 방지
  const wrap = $('game-wrap');
  wrap.addEventListener('contextmenu', (e) => e.preventDefault());
  wrap.addEventListener('touchmove', (e) => { if (e.target.closest('.modal-box')) return; e.preventDefault(); }, { passive: false });
}
const Bot = {
  t: 0, dir: 1, jt: 0,
  update(dt) {
    const me = World.me;
    if (!me || me.inExit) { Input.bot.left = Input.bot.right = Input.bot.jump = false; return; }
    this.t -= dt; this.jt -= dt;
    if (this.t <= 0) {
      this.t = 0.6 + Math.random() * 1.8;
      const r = Math.random();
      this.dir = r < 0.7 ? 1 : r < 0.85 ? -1 : 0;
    }
    Input.bot.left = this.dir < 0;
    Input.bot.right = this.dir > 0;
    if (this.jt <= 0) {
      this.jt = 0.4 + Math.random() * 1.3;
      Input.jumpPresses++;
      Input.bot.jump = true;
      setTimeout(() => { Input.bot.jump = false; }, 150 + Math.random() * 250);
    }
  },
};

/* -----------------------------------------------------------------
 * 7. 공용 UI (화면 전환 · 토스트 · 확인창)
 * ----------------------------------------------------------------- */
function showScreen(name) {
  App.screen = name;
  for (const s of ['title', 'lobby', 'game']) $('screen-' + s).classList.toggle('active', s === name);
  if (PhaserGame) {
    try {
      if (name === 'game') { PhaserGame.loop.wake(); setTimeout(() => PhaserGame && PhaserGame.scale.refresh(), 30); }
      else PhaserGame.loop.sleep();
    } catch (e) { warn('loop', e); }
  }
  $('touch-controls').classList.toggle('hidden', !(name === 'game' && App.touchUI));
  if (name !== 'game') { hideModal('result-modal'); hideModal('menu-modal'); $('countdown').classList.add('hidden'); }
  Input.reset();
  updateRotateTip();
}
let lastToastMsg = '', lastToastAt = 0;
function toast(msg, isErr) {
  const now = Date.now();
  if (msg === lastToastMsg && now - lastToastAt < 2500) return;
  lastToastMsg = msg; lastToastAt = now;
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  const area = $('toast-area');
  area.appendChild(el);
  while (area.children.length > 3) area.removeChild(area.firstChild);
  setTimeout(() => el.remove(), isErr ? 4200 : 2800);
}
function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }
function confirmDialog(text) {
  return new Promise((resolve) => {
    $('confirm-text').textContent = text;
    showModal('confirm-modal');
    const done = (v) => {
      hideModal('confirm-modal');
      $('confirm-yes').onclick = null; $('confirm-no').onclick = null;
      resolve(v);
    };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
  });
}
function fatal(msg) {
  const el = $('fatal');
  el.innerHTML = '';
  const box = document.createElement('div');
  box.textContent = msg;
  el.appendChild(box);
  el.classList.remove('hidden');
}
function setNet(state, text) {
  for (const id of ['net-dot', 'net-dot-2', 'hud-net']) {
    const d = $(id);
    if (d) d.className = 'dot ' + state;
  }
  if (text) { $('net-text').textContent = text; $('net-text-2').textContent = text; }
}
function friendlyError(e) {
  const c = String((e && (e.code || e.message)) || e || '');
  if (/PERMISSION_DENIED|permission/i.test(c)) return '요청이 거절됐어요. 방 상태가 바뀌었을 수 있어요.';
  if (/network|disconnect|unavailable|offline/i.test(c)) return '네트워크 연결을 확인해 주세요.';
  if (/operation-not-allowed/i.test(c)) return 'Firebase 콘솔에서 익명 로그인을 사용 설정해 주세요.';
  return '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';
}
function isPermissionError(e) { return /PERMISSION_DENIED|permission/i.test(String((e && (e.code || e.message)) || '')); }
let lastErrToast = 0;
function reportError(e, where) {
  console.error('[PikaPark] 오류(' + where + ')', e);
  if (Date.now() - lastErrToast > 5000) {
    lastErrToast = Date.now();
    toast('일시적인 오류가 발생했어요. 계속 문제가 있으면 새로고침해 주세요.', true);
  }
}
function netErr(where) { return (e) => warn('네트워크 작업 실패:', where, e && (e.code || e.message)); }
function updateRotateTip() {
  const tip = $('rotate-tip');
  if (!tip) return;
  const portrait = window.innerHeight > window.innerWidth;
  tip.classList.toggle('hidden', !(App.screen === 'game' && App.touchUI && portrait));
}

/* -----------------------------------------------------------------
 * 8. Firebase 연결 · 인증 · 접속 상태
 * ----------------------------------------------------------------- */
const App = {
  screen: 'title', touchUI: false,
  db: null, auth: null, uid: null, tabId: randomId(12),
  connected: false, everConnected: false, serverOffset: 0,
  roomCode: null, leaving: false, suspended: false, busy: false,
  info: null, players: {}, game: null, slotMap: [],
  hostTimer: null, takeoverTimer: null, lastActiveAt: 0, removing: new Set(),
  stageToken: 0,
  isAdmin: false, adminLs: null, authUser: null,
};
const serverNow = () => Date.now() + App.serverOffset;

class ListenerGroup {
  constructor(name) { this.name = name; this.items = []; }
  on(ref, ev, fn) {
    const cb = (snap, prev) => { try { fn(snap, prev); } catch (e) { reportError(e, 'listener:' + this.name); } };
    ref.on(ev, cb, (err) => onListenError(err, this.name));
    this.items.push([ref, ev, cb]);
  }
  clear() { for (const [r, e, c] of this.items) r.off(e, c); this.items = []; }
  get active() { return this.items.length > 0; }
}
const roomLs = new ListenerGroup('room');
const playLs = new ListenerGroup('play');
const puzzleLs = new ListenerGroup('puzzle');

function initFirebase() {
  const cfg = window.PIKA_FIREBASE_CONFIG || {};
  const bad = !cfg.apiKey || !cfg.databaseURL || /YOUR_/.test(JSON.stringify(cfg));
  if (bad) {
    $('config-error').classList.remove('hidden');
    setNet('off', 'Firebase 설정이 필요해요');
    return false;
  }
  if (typeof firebase === 'undefined' || !firebase.database || !firebase.auth) {
    fatal('Firebase 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.');
    return false;
  }
  try {
    firebase.initializeApp(cfg);
    App.db = firebase.database();
    App.auth = firebase.auth();
  } catch (e) {
    console.error(e);
    fatal('Firebase 초기화에 실패했어요. config.js의 설정값을 다시 확인해 주세요.');
    return false;
  }
  if (DEBUG) firebase.database.enableLogging(true);
  App.db.ref('.info/serverTimeOffset').on('value', (s) => { App.serverOffset = s.val() || 0; });
  App.db.ref('.info/connected').on('value', (s) => onConnectedChange(!!s.val()));
  setNet('wait', '로그인 중…');

  const persistence = TEST_MODE ? firebase.auth.Auth.Persistence.SESSION : firebase.auth.Auth.Persistence.LOCAL;
  App.auth.setPersistence(persistence).catch((e) => warn('persistence', e)).then(() => {
    // 모바일에서 팝업이 막혀 리디렉션으로 운영진 로그인한 경우의 결과 처리
    App.auth.getRedirectResult().catch((e) => { warn('redirect login', e && e.code); toast(friendlyError(e), true); });
    App.auth.onAuthStateChanged((user) => {
      App.authUser = user || null;
      if (user) {
        if (App.uid !== user.uid) { App.uid = user.uid; onSignedIn(); }
        updateAdminUi();
      } else {
        // 로그인 정보가 없으면(처음 방문·운영진 로그아웃) 익명 사용자로 시작
        App.uid = null;
        setAdmin(false);
        App.auth.signInAnonymously().catch((e) => {
          console.error(e);
          setNet('off', '로그인 실패');
          toast(friendlyError(e), true);
        });
      }
    });
  });
  return true;
}

/* ---- 운영진(관리자) ----
 * 운영진만 방을 만들고 게임을 시작·진행할 수 있다.
 * 운영진은 구글 계정으로 로그인하고, Firebase 콘솔에서 admins/{uid} = true 로 등록한다.
 * (보안 규칙이 같은 조건을 서버에서 다시 검사하므로 화면을 조작해도 권한이 생기지 않는다.)
 */
function setAdmin(v) {
  if (App.isAdmin === v) { updateAdminUi(); return; }
  App.isAdmin = v;
  updateAdminUi();
  renderLobbySoon();
  updateResultModal();
}
function watchAdmin() {
  if (App.adminLs) { App.adminLs.off(); App.adminLs = null; }
  if (!App.uid) return;
  const ref = App.db.ref('admins/' + App.uid);
  ref.on('value', (s) => setAdmin(s.val() === true), (e) => { warn('운영진 확인 실패', e && e.code); setAdmin(false); });
  App.adminLs = ref;
}
const isGoogleUser = () => !!App.authUser && !App.authUser.isAnonymous;
function updateAdminUi() {
  const google = isGoogleUser();
  $('btn-create').classList.toggle('hidden', !App.isAdmin);
  $('create-note').classList.toggle('hidden', App.isAdmin);
  $('btn-admin-login').classList.toggle('hidden', google);
  $('admin-status').classList.toggle('hidden', !google);
  if (google) {
    const who = App.authUser.email || '구글 계정';
    $('admin-who').textContent = App.isAdmin ? `운영진으로 로그인됨 · ${who}` : `${who} · 운영진으로 등록되지 않은 계정이에요`;
    $('admin-uid-row').classList.toggle('hidden', App.isAdmin);
    $('admin-uid').textContent = App.uid || '';
  }
  if (!App.busy) setBusy(false);
}
async function adminLogin() {
  if (App.roomCode) return;
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await App.auth.signInWithPopup(provider);
  } catch (e) {
    const c = e && e.code;
    if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-this-environment') {
      await App.auth.signInWithRedirect(provider).catch((err) => toast(friendlyError(err), true));
    } else if (c !== 'auth/popup-closed-by-user' && c !== 'auth/cancelled-popup-request') {
      warn('운영진 로그인 실패', c);
      toast(c === 'auth/unauthorized-domain' ? 'Firebase 콘솔의 승인된 도메인에 이 사이트 주소를 추가해 주세요.' : friendlyError(e), true);
    }
  }
}
async function adminLogout() {
  if (App.roomCode) return;
  try { await App.auth.signOut(); toast('운영진 로그아웃했어요'); } catch (e) { toast(friendlyError(e), true); }
}

function onConnectedChange(c) {
  const was = App.connected;
  App.connected = c;
  if (c) {
    setNet('on', '서버에 연결됨');
    if (App.everConnected && !was && App.roomCode) toast('다시 연결됐어요');
    App.everConnected = true;
    if (App.roomCode && !App.suspended) setupPresence();
  } else {
    setNet(App.everConnected ? 'off' : 'wait', App.everConnected ? '연결이 끊겼어요. 다시 연결하는 중…' : '서버에 연결하는 중…');
    if (App.everConnected && App.roomCode) toast('연결이 끊겼어요. 다시 연결하는 중…', true);
  }
}

async function onSignedIn() {
  log('로그인 완료', App.uid.slice(0, 6) + '…', isGoogleUser() ? '(구글 계정)' : '(익명)', TEST_MODE ? '(테스트 모드)' : '');
  $('btn-rejoin').classList.add('hidden');
  watchAdmin();
  setBusy(false);
  // 새로고침 직후라면 이전 방으로 자동 복귀
  const last = storageGet('pika_last_room');
  const lastAt = +storageGet('pika_last_room_at') || 0;
  if (last && CODE_RE.test(last) && !TEST_MODE) {
    try {
      const snap = await App.db.ref(`rooms/${last}/players/${App.uid}`).once('value');
      if (snap.exists()) {
        if (Date.now() - lastAt < CFG.AUTO_REJOIN_MS) {
          toast('이전 방으로 돌아가는 중…');
          await rejoinRoom(last);
          return;
        }
        const b = $('btn-rejoin');
        b.textContent = `이전 방(${last})으로 돌아가기`;
        b.classList.remove('hidden');
        b.onclick = () => rejoinRoom(last);
      } else {
        storageSet('pika_last_room', null);
      }
    } catch (e) { dbg('rejoin check', e); }
  }
  if (BOT_MODE && QS.get('room')) {
    if (!$('input-name').value) $('input-name').value = 'BOT' + randomId(3).toUpperCase();
    joinRoom(String(QS.get('room')).toUpperCase());
  }
}

async function setupPresence() {
  const code = App.roomCode;
  if (!code || !App.uid) return;
  const ref = App.db.ref(`rooms/${code}/players/${App.uid}`);
  try {
    await ref.onDisconnect().update({ online: false, seen: TS() });
    await ref.update({ online: true, seen: TS(), tab: App.tabId });
  } catch (e) {
    warn('접속 상태 등록 실패', e && e.code);
    if (isPermissionError(e) && App.roomCode === code) onKicked();
  }
}

function onListenError(err, name) {
  warn('리스너 오류', name, err && err.code);
  if (App.leaving || !App.roomCode) return;
  if (isPermissionError(err)) onKicked();
  else toast('데이터를 받지 못했어요. 연결을 확인해 주세요.', true);
}

/* -----------------------------------------------------------------
 * 9. 방 만들기 · 참가 · 나가기
 * ----------------------------------------------------------------- */
function getName() {
  const n = sanitizeName($('input-name').value);
  if (!n) { toast('닉네임을 입력해 주세요', true); $('input-name').focus(); return null; }
  storageSet('pika_name', n);
  App.name = n;
  return n;
}
function setBusy(b) {
  App.busy = b;
  for (const id of ['btn-join', 'btn-rejoin', 'btn-admin-login', 'btn-admin-logout']) $(id).disabled = b || !App.uid;
  $('btn-create').disabled = b || !App.uid || !App.isAdmin;
}

async function sweepStaleRooms() {
  // 6시간 넘게 활동이 없는 방을 정리(보안 규칙이 오래된 방만 조회/삭제를 허용)
  try {
    const cutoff = serverNow() - CFG.ROOM_STALE_MS - 3600 * 1000;
    const snap = await App.db.ref('roomIndex').orderByValue().endAt(cutoff).limitToFirst(10).once('value');
    const tasks = [];
    snap.forEach((c) => {
      tasks.push(App.db.ref().update({ [`rooms/${c.key}`]: null, [`roomIndex/${c.key}`]: null }).catch(netErr('sweep')));
    });
    if (tasks.length) { await Promise.all(tasks); log('오래된 방 정리:', tasks.length); }
  } catch (e) { dbg('sweep skipped', e && e.code); }
}

async function createRoom() {
  if (App.busy || !App.uid) return;
  if (!App.isAdmin) { toast('방 만들기는 운영진만 할 수 있어요. 받은 방 코드로 참가해 주세요.', true); return; }
  const name = getName();
  if (!name) return;
  setBusy(true);
  try {
    await sweepStaleRooms();
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode();
      const updates = {};
      updates[`roomIndex/${code}`] = TS();
      updates[`rooms/${code}/info`] = { host: App.uid, createdAt: TS(), lastActive: TS() };
      updates[`rooms/${code}/game`] = { status: 'lobby', stage: 0, seq: 0, sk: 's0' };
      updates[`rooms/${code}/slots/0`] = App.uid;
      updates[`rooms/${code}/players/${App.uid}`] = { name, slot: '0', joinedAt: TS(), online: true, seen: TS(), tab: App.tabId };
      try {
        await App.db.ref().update(updates);
        log('방 생성', code);
        await enterRoom(code);
        return;
      } catch (e) {
        if (isPermissionError(e)) { dbg('코드 충돌, 재시도', code); continue; }
        throw e;
      }
    }
    toast('방을 만들지 못했어요. 잠시 후 다시 시도해 주세요.', true);
  } catch (e) {
    console.error(e);
    toast(friendlyError(e), true);
  } finally { setBusy(false); }
}

async function joinRoom(codeArg) {
  if (App.busy || !App.uid) return;
  const code = String(codeArg || $('input-code').value || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) { toast('방 코드는 5자리 영문/숫자예요', true); return; }
  const name = getName();
  if (!name) return;
  setBusy(true);
  try {
    const base = App.db.ref('rooms/' + code);
    const infoSnap = await base.child('info').once('value');
    if (!infoSnap.exists()) { toast('그런 방을 찾을 수 없어요. 코드를 확인해 주세요.', true); return; }
    const meSnap = await base.child('players/' + App.uid).once('value');
    if (meSnap.exists()) { await base.child('players/' + App.uid).update({ name }); await enterRoom(code); return; }
    const gameSnap = await base.child('game').once('value');
    const g = gameSnap.val();
    if (g && g.status !== 'lobby') { toast('게임이 진행 중인 방이에요. 운영진이 대기실로 돌아오면 참가할 수 있어요.', true); return; }
    const slotsSnap = await base.child('slots').once('value');
    const used = slotsSnap.val() || {};
    for (let i = 0; i < CFG.MAX_PLAYERS; i++) {
      if (used[i]) continue;
      const upd = {};
      upd[`rooms/${code}/slots/${i}`] = App.uid;
      upd[`rooms/${code}/players/${App.uid}`] = { name, slot: String(i), joinedAt: TS(), online: true, seen: TS(), tab: App.tabId };
      try {
        await App.db.ref().update(upd);
        log('방 참가', code, '슬롯', i);
        await enterRoom(code);
        return;
      } catch (e) {
        if (isPermissionError(e)) continue; // 다른 사람이 먼저 차지했거나 게임이 시작됨
        throw e;
      }
    }
    toast('방이 가득 찼어요 (최대 20명)', true);
  } catch (e) {
    console.error(e);
    toast(friendlyError(e), true);
  } finally { setBusy(false); }
}

async function rejoinRoom(code) {
  if (App.busy || !App.uid) return;
  setBusy(true);
  try {
    const snap = await App.db.ref(`rooms/${code}/players/${App.uid}`).once('value');
    if (!snap.exists()) {
      storageSet('pika_last_room', null);
      $('btn-rejoin').classList.add('hidden');
      toast('이전 방에서 이미 정리됐어요', true);
      return;
    }
    await enterRoom(code);
  } catch (e) {
    console.error(e);
    toast(friendlyError(e), true);
  } finally { setBusy(false); }
}

async function enterRoom(code) {
  App.roomCode = code;
  App.leaving = false;
  App.suspended = false;
  App.info = null; App.players = {}; App.game = null; App.slotMap = [];
  storageSet('pika_last_room', code);
  storageSet('pika_last_room_at', String(Date.now()));
  $('btn-rejoin').classList.add('hidden');
  history.replaceState(null, '', location.pathname + '?room=' + code + (TEST_MODE ? '&test' : '') + (BOT_MODE ? '&bot' : '') + (DEBUG ? '&debug' : ''));
  await setupPresence();
  subscribeRoom(code);
  startTimers();
  showScreen('lobby');
  renderLobby();
}

function subscribeRoom(code) {
  roomLs.clear();
  const base = App.db.ref('rooms/' + code);
  roomLs.on(base.child('info'), 'value', (s) => {
    const v = s.val();
    if (!v) { onRoomGone(); return; }
    const wasHost = isHost();
    App.info = v;
    if (!wasHost && isHost()) log('방장(자동 관리 담당)이 됨');
    renderLobbySoon();
    updateResultModal();
  });
  const onPlayer = (s) => {
    App.players[s.key] = s.val();
    rebuildSlotMap();
    renderLobbySoon();
    updateResultModal();
  };
  roomLs.on(base.child('players'), 'child_added', onPlayer);
  roomLs.on(base.child('players'), 'child_changed', onPlayer);
  roomLs.on(base.child('players'), 'child_removed', (s) => {
    delete App.players[s.key];
    rebuildSlotMap();
    if (s.key === App.uid) { onKicked(); return; }
    World.remotes.delete(s.key);
    renderLobbySoon();
  });
  roomLs.on(base.child('players/' + App.uid + '/tab'), 'value', (s) => {
    if (s.exists() && s.val() !== App.tabId) onTabConflict();
  });
  roomLs.on(base.child('game'), 'value', (s) => onGame(s.val()));
}
function rebuildSlotMap() {
  const m = [];
  for (const [uid, p] of Object.entries(App.players)) if (p && p.slot != null) m[+p.slot] = uid;
  App.slotMap = m;
}
function sortedPlayers() {
  return Object.entries(App.players).filter(([, p]) => p).sort((a, b) => (+a[1].slot) - (+b[1].slot));
}
const isOnline = (uid) => !!App.players[uid] && App.players[uid].online !== false;
const activeUids = () => Object.keys(App.players).filter(isOnline);
const isHost = () => !!App.info && App.info.host === App.uid;
// 게임 시작·다음 스테이지·재도전·대기실 복귀는 방에 들어와 있는 운영진만
const canControl = () => App.isAdmin && !!App.roomCode && !!App.players[App.uid];
const mySlot = () => (App.players[App.uid] ? +App.players[App.uid].slot : 0);
const nameOf = (uid) => (App.players[uid] ? App.players[uid].name : '???');

async function leaveRoom(opts) {
  opts = opts || {};
  if (!App.roomCode) return;
  const code = App.roomCode, uid = App.uid;
  const me = App.players[uid];
  const others = Object.entries(App.players).filter(([id]) => id !== uid);
  const onlineOthers = others.filter(([, p]) => p.online !== false).sort((a, b) => (+a[1].slot) - (+b[1].slot));
  const wasHost = isHost();
  App.leaving = true;
  teardownRoomLocal();
  if (!opts.silent) {
    try {
      await App.db.ref(`rooms/${code}/players/${uid}`).onDisconnect().cancel();
      if (others.length === 0) {
        // 마지막 사람: 방 전체 정리
        if (!wasHost) await App.db.ref(`rooms/${code}/info/host`).set(uid).catch(() => {});
        await App.db.ref().update({ [`rooms/${code}`]: null, [`roomIndex/${code}`]: null });
      } else {
        if (wasHost && onlineOthers.length) await App.db.ref(`rooms/${code}/info/host`).set(onlineOthers[0][0]);
        const upd = { [`rooms/${code}/players/${uid}`]: null, [`rooms/${code}/pos/${uid}`]: null };
        if (me && me.slot != null) upd[`rooms/${code}/slots/${me.slot}`] = null;
        await App.db.ref().update(upd);
      }
    } catch (e) { warn('나가기 처리 중 오류', e && e.code); }
  }
  storageSet('pika_last_room', null);
  history.replaceState(null, '', location.pathname + (TEST_MODE ? '?test' : ''));
  App.leaving = false;
  showScreen('title');
}
function teardownRoomLocal() {
  stopTimers();
  roomLs.clear(); playLs.clear(); puzzleLs.clear();
  stopStage();
  App.roomCode = null;
  App.info = null; App.players = {}; App.game = null; App.slotMap = [];
  App.removing.clear();
  World.remotes.clear();
}
function onKicked() {
  if (App.leaving || !App.roomCode) return;
  const code = App.roomCode;
  App.leaving = true;
  App.db.ref(`rooms/${code}/players/${App.uid}`).onDisconnect().cancel().catch(() => {});
  teardownRoomLocal();
  storageSet('pika_last_room', null);
  App.leaving = false;
  showScreen('title');
  toast('방에서 나가게 됐어요. 오래 연결이 끊겼거나 방이 정리됐을 수 있어요.', true);
}
function onRoomGone() {
  if (App.leaving || !App.roomCode) return;
  App.leaving = true;
  teardownRoomLocal();
  storageSet('pika_last_room', null);
  App.leaving = false;
  showScreen('title');
  toast('방이 사라졌어요', true);
}
function onTabConflict() {
  if (App.suspended) return;
  App.suspended = true;
  stopTimers();
  roomLs.clear(); playLs.clear(); puzzleLs.clear();
  stopStage();
  fatal('다른 탭(또는 창)에서 같은 계정으로 이 방에 접속했어요. 중복 참가를 막기 위해 이 탭은 멈췄어요. 이 탭에서 계속하려면 새로고침해 주세요.');
}

/* -----------------------------------------------------------------
 * 10. 게임 진행 (시작·전환은 운영진, 클리어 판정·정리는 방장 · 트랜잭션으로 중복 방지)
 * ----------------------------------------------------------------- */
function startTimers() {
  stopTimers();
  App.hostTimer = setInterval(() => { try { hostTick(); } catch (e) { reportError(e, 'hostTick'); } }, CFG.HOST_TICK_MS);
  App.takeoverTimer = setInterval(() => { try { takeoverTick(); } catch (e) { reportError(e, 'takeover'); } }, CFG.TAKEOVER_TICK_MS);
}
function stopTimers() {
  clearInterval(App.hostTimer); clearInterval(App.takeoverTimer);
  App.hostTimer = App.takeoverTimer = null;
}
function roomRef(path) { return App.db.ref(`rooms/${App.roomCode}/${path}`); }

function hostTick() {
  if (!App.roomCode || !isHost() || App.suspended || !App.connected) return;
  const now = serverNow();
  const code = App.roomCode;
  if (now - App.lastActiveAt > CFG.LAST_ACTIVE_MS) {
    App.lastActiveAt = now;
    App.db.ref().update({ [`rooms/${code}/info/lastActive`]: TS(), [`roomIndex/${code}`]: TS() }).catch(netErr('lastActive'));
  }
  // 오래 끊긴 플레이어 정리
  for (const [uid, p] of Object.entries(App.players)) {
    if (uid === App.uid || App.removing.has(uid)) continue;
    if (p.online === false && p.seen && now - p.seen > CFG.OFFLINE_REMOVE_MS) {
      App.removing.add(uid);
      const upd = { [`rooms/${code}/players/${uid}`]: null, [`rooms/${code}/pos/${uid}`]: null };
      if (p.slot != null) upd[`rooms/${code}/slots/${p.slot}`] = null;
      App.db.ref().update(upd)
        .then(() => log('끊긴 플레이어 정리:', p.name))
        .catch(netErr('cleanup'))
        .finally(() => App.removing.delete(uid));
    }
  }
  const g = App.game;
  if (!g || g.status !== 'playing' || !World.st || g.seq !== World.seq) return;
  // 열쇠를 든 사람이 떠나면 열쇠를 제자리로
  const k = World.puzzle.key;
  if (k && k !== '#used' && !isOnline(k)) {
    puzzleRef('key').transaction((cur) => (cur === k ? null : undefined)).catch(netErr('keyReset'));
  }
  checkClear();
}
function takeoverTick() {
  if (!App.roomCode || !App.info || App.suspended || !App.connected) return;
  const host = App.info.host;
  if (host === App.uid) return;
  const hp = App.players[host];
  const now = serverNow();
  const gone = !hp || (hp.online === false && (!hp.seen || now - hp.seen > CFG.HOST_OFFLINE_GRACE_MS));
  if (!gone) return;
  const cands = Object.entries(App.players).filter(([, p]) => p.online !== false).sort((a, b) => (+a[1].slot) - (+b[1].slot));
  if (!cands.length || cands[0][0] !== App.uid) return;
  roomRef('info/host').transaction((cur) => (cur === host ? App.uid : undefined))
    .then((r) => { if (r.committed) log('방장 권한 넘겨받음'); })
    .catch(netErr('takeover'));
}
let lastClearCheck = 0;
function checkClear() {
  if (!isHost() || !World.st || !World.me) return;
  const g = App.game;
  if (!g || g.status !== 'playing' || g.seq !== World.seq) return;
  if (World.clearingSeq === World.seq) return;
  const ids = activeUids();
  if (!ids.length) return;
  for (const id of ids) {
    if (id === App.uid) { if (!World.me.inExit) return; continue; }
    const r = World.remotes.get(id);
    if (!r || r.s !== World.seq || !r.inExit) return;
  }
  const seq = World.seq;
  World.clearingSeq = seq;
  roomRef('game').transaction((cur) => {
    if (!cur || cur.seq !== seq || cur.status !== 'playing') return undefined;
    const t = serverNow();
    cur.clearedAt = t;
    cur.times = cur.times || {};
    cur.times['t' + cur.stage] = Math.max(0, t - cur.startAt);
    cur.status = cur.stage >= STAGES.length - 1 ? 'finished' : 'cleared';
    return cur;
  }).then((r) => { if (!r.committed) World.clearingSeq = 0; })
    .catch((e) => { World.clearingSeq = 0; netErr('clear')(e); });
}
function newStageState(g, stage, keepRun) {
  const seq = (g.seq || 0) + 1;
  const t = serverNow() + CFG.COUNTDOWN_MS;
  return {
    status: 'playing', stage, seq, sk: 's' + seq, startAt: t,
    runStartAt: keepRun && g.runStartAt ? g.runStartAt : t,
    n: clamp(activeUids().length, 1, CFG.MAX_PLAYERS),
    times: keepRun ? (g.times || null) : null,
    clearedAt: null,
  };
}
function gameTransition(fn, label) {
  const oldSk = App.game && App.game.sk;
  return roomRef('game').transaction((g) => (g ? fn(g) : undefined)).then((r) => {
    if (!r.committed) { dbg(label, '반영 안 됨(이미 다른 상태)'); return false; }
    const nv = r.snapshot.val();
    if (oldSk && nv && nv.sk !== oldSk) roomRef('puzzle/' + oldSk).remove().catch(netErr('puzzleCleanup'));
    return true;
  }).catch((e) => { toast(friendlyError(e), true); warn(label, e); return false; });
}
function hostStartRun() {
  if (!canControl()) { toast('게임 진행은 운영진만 할 수 있어요', true); return; }
  if (activeUids().length < CFG.MIN_PLAYERS) { toast(`${CFG.MIN_PLAYERS}명 이상 모여야 시작할 수 있어요`, true); return; }
  gameTransition((g) => (g.status === 'lobby' || g.status === 'finished' ? newStageState(g, 0, false) : undefined), 'start');
}
function hostNext() {
  if (!canControl()) { toast('게임 진행은 운영진만 할 수 있어요', true); return; }
  const seq = World.seq;
  gameTransition((g) => (g.status === 'cleared' && g.seq === seq ? newStageState(g, g.stage + 1, true) : undefined), 'next');
}
function hostRetry() {
  if (!canControl()) { toast('게임 진행은 운영진만 할 수 있어요', true); return; }
  const seq = World.seq;
  gameTransition((g) => ((g.status === 'playing' || g.status === 'cleared') && g.seq === seq ? newStageState(g, g.stage, true) : undefined), 'retry');
}
function hostToLobby() {
  if (!canControl()) { toast('게임 진행은 운영진만 할 수 있어요', true); return; }
  gameTransition((g) => ({ status: 'lobby', stage: 0, seq: g.seq || 0, sk: g.sk || 's0' }), 'lobby').then((ok) => {
    if (ok && App.game && App.game.sk) roomRef('puzzle/' + App.game.sk).remove().catch(netErr('puzzleCleanup'));
  });
}

/* -----------------------------------------------------------------
 * 11. 월드 상태 · 네트워크 동기화
 * ----------------------------------------------------------------- */
const World = {
  st: null, seq: 0, sk: '', startAt: 0, loadingSeq: 0, clearingSeq: 0,
  me: null, remotes: new Map(), solidList: [],
  puzzle: { key: null, cp: 0, cr: {} }, puzzleLoaded: false,
  unlocked: false, doorOpen: {}, plateOn: {}, plateCount: {}, plateNeed: {}, nActive: 1,
  ghost: new Set(), throttle: {}, spectate: null,
  stats: { sent: 0, recv: 0, since: performance.now() },
};

function onGame(g) {
  App.game = g;
  if (!g) return;
  if (typeof g.stage !== 'number' || !STAGES[g.stage] || typeof g.seq !== 'number') {
    warn('게임 상태 데이터가 올바르지 않음', g);
    if (g.status !== 'lobby') toast('스테이지 정보를 읽지 못했어요. 운영진이 대기실로 돌아가면 해결돼요.', true);
    return;
  }
  if (g.status === 'lobby') {
    if (World.st || App.screen === 'game') stopStage();
    playLs.clear(); puzzleLs.clear();
    showScreen('lobby');
    renderLobby();
    return;
  }
  ensurePlayListeners();
  if (World.seq !== g.seq && World.loadingSeq !== g.seq) {
    startStage(g).catch((e) => { reportError(e, 'startStage'); });
  } else if (World.seq === g.seq) {
    World.startAt = g.startAt;
  }
  updateResultModal();
}
function ensurePlayListeners() {
  if (playLs.active) return;
  const posRef = roomRef('pos');
  playLs.on(posRef, 'child_added', (s) => onPos(s.key, s.val()));
  playLs.on(posRef, 'child_changed', (s) => onPos(s.key, s.val()));
  playLs.on(posRef, 'child_removed', (s) => World.remotes.delete(s.key));
}

async function startStage(g) {
  const token = ++App.stageToken;
  World.loadingSeq = g.seq;
  showScreen('game');
  const scene = await ensurePhaser();
  if (token !== App.stageToken || !App.roomCode) return;
  let st;
  try {
    st = buildStage(g.stage, g.n || 2);
  } catch (e) {
    reportError(e, 'buildStage');
    toast('스테이지를 만들지 못했어요. 운영진이 다시 시작해 주세요.', true);
    return;
  }
  World.st = st;
  World.seq = g.seq; World.sk = g.sk; World.startAt = g.startAt;
  World.loadingSeq = 0; World.clearingSeq = 0;
  World.puzzle = { key: null, cp: 0, cr: {} }; World.puzzleLoaded = false;
  World.unlocked = !st.key;
  World.doorOpen = {}; World.plateOn = {}; World.plateCount = {}; World.plateNeed = {};
  World.throttle = {}; World.spectate = null;
  updateMoving(Math.max(0, serverNow() - World.startAt));
  for (const r of World.remotes.values()) { r.drawn = false; }
  const sp = spawnPoint(0);
  World.me = {
    x: sp.x, y: sp.y, vx: 0, vy: 0, facing: 1, grounded: false, sup: null,
    coyote: 0, jumpBuf: 0, jumpHeld: false, dead: false, deadT: 0, inExit: false,
    landT: 0, sw: -1, lastFallVy: 0, moved: false,
  };
  Sender.last = ''; Sender.lastImportant = ''; Sender.lastAt = 0;

  puzzleLs.clear();
  puzzleLs.on(roomRef('puzzle/' + g.sk), 'value', (s) => onPuzzle(s.val(), g.seq));

  buildStageView(scene, st);
  hideModal('menu-modal');
  updateHud(true);
  roomRef('pos/' + App.uid).set({ p: buildP(), s: g.seq }).catch(netErr('posInit'));
  Sender.last = buildP(); Sender.lastAt = performance.now();
  log(`스테이지 ${g.stage + 1} 시작 (seq ${g.seq}, 시작 인원 ${g.n})`);
}
function stopStage() {
  App.stageToken++;
  World.st = null; World.me = null; World.seq = 0; World.sk = ''; World.loadingSeq = 0;
  puzzleLs.clear();
  if (Scene) destroyStageView(Scene);
  hideModal('result-modal');
}
function onPuzzle(v, seq) {
  if (seq !== World.seq) return;
  const first = !World.puzzleLoaded;
  World.puzzleLoaded = true;
  World.puzzle = { key: (v && v.key) || null, cp: (v && v.cp) || 0, cr: (v && v.cr) || {} };
  World.unlocked = !World.st.key || World.puzzle.key === '#used';
  // 재접속 직후: 이미 진행된 체크포인트에서 시작
  if (first && World.puzzle.cp > 0 && World.me && !World.me.moved) respawn();
}

function spawnPoint(cpIdx) {
  const st = World.st;
  const base = cpIdx > 0 && st.cps[cpIdx - 1] ? st.cps[cpIdx - 1] : st.spawn;
  const off = ((mySlot() % 5) - 2) * 7;
  let x = base.x * T + (T - CFG.PW) / 2 + off;
  const y = (base.y + 1) * T - CFG.PH;
  const ty = Math.floor((y + CFG.PH - 1) / T);
  if (solidAt(Math.floor(x / T), ty, true) || solidAt(Math.floor((x + CFG.PW - 1) / T), ty, true)) x = base.x * T + (T - CFG.PW) / 2;
  return { x, y };
}

// ---- 원격 플레이어 수신 ----
function onPos(uid, v) {
  if (uid === App.uid || !v) return;
  World.stats.recv++;
  const a = parseP(v.p);
  if (!a) { dbg('잘못된 위치 데이터 무시', uid); return; }
  let r = World.remotes.get(uid);
  if (!r) { r = { uid, ready: false, x: 0, y: 0, dx: 0, dy: 0, drawn: false }; World.remotes.set(uid, r); }
  const st = World.st;
  const maxX = st ? st.W * T + 64 : 99999, maxY = st ? st.H * T + 120 : 99999;
  r.nx = clamp(a[0], -64, maxX); r.ny = clamp(a[1], -240, maxY);   // 비정상 좌표 보정
  r.nvx = clamp(a[2], -600, 600); r.nvy = clamp(a[3], -600, 600);
  r.anim = clamp(a[4] | 0, 0, 9);
  const f = a[5] | 0;
  r.facing = f & 1 ? -1 : 1; r.dead = !!(f & 2); r.inExit = !!(f & 4); r.grounded = !!(f & 8);
  r.supCode = a[6] | 0; r.ox = clamp(a[7], -64, 64); r.sw = clamp(a[8] | 0, -1, 25);
  r.s = typeof v.s === 'number' ? v.s : 0;
  r.recvAt = performance.now();
  if (!r.ready) { r.ready = true; r.x = r.nx; r.y = r.ny; }
  if (isHost() && performance.now() - lastClearCheck > 250) { lastClearCheck = performance.now(); checkClear(); }
}
function parseP(p) {
  if (typeof p !== 'string' || p.length > 80) return null;
  const a = p.split(',').map(Number);
  if (a.length !== 9 || a.some((n) => !Number.isFinite(n))) return null;
  return a;
}

// ---- 내 상태 전송 ----
const Sender = { last: '', lastImportant: '', lastAt: 0 };
function localAnim() {
  const me = World.me;
  if (me.dead) return ANIM.HURT;
  if (App.game && (App.game.status === 'cleared' || App.game.status === 'finished')) return ANIM.CLEAR;
  if (!me.grounded) return me.vy < 0 ? ANIM.JUMP : ANIM.FALL;
  return Math.abs(me.vx) > 12 ? ANIM.WALK : ANIM.IDLE;
}
function supCode() {
  const me = World.me;
  if (!me.sup) return 0;
  if (me.sup.t === 'm') return 100 + me.sup.i;
  if (me.sup.t === 'p') { const p = App.players[me.sup.uid]; return p ? +p.slot + 1 : 0; }
  return 0;
}
function supOffset() {
  const me = World.me;
  if (!me.sup) return 0;
  if (me.sup.t === 'm') { const m = World.st.movers[me.sup.i]; return m ? Math.round(me.x - m.x) : 0; }
  if (me.sup.t === 'p') { const r = World.remotes.get(me.sup.uid); return r ? Math.round(me.x - r.x) : 0; }
  return 0;
}
function buildP() {
  const me = World.me;
  const flags = (me.facing < 0 ? 1 : 0) | (me.dead ? 2 : 0) | (me.inExit ? 4 : 0) | (me.grounded ? 8 : 0);
  return [
    Math.round(me.x), Math.round(me.y),
    clamp(Math.round(me.vx), -999, 999), clamp(Math.round(me.vy), -999, 999),
    localAnim(), flags, supCode(), clamp(supOffset(), -99, 99), me.sw,
  ].join(',');
}
function sendInterval() {
  return clamp(CFG.SEND_BASE_MS + CFG.SEND_PER_PLAYER_MS * World.nActive, CFG.SEND_BASE_MS, CFG.SEND_MAX_MS);
}
function maybeSend(force) {
  if (!World.me || !App.roomCode || App.suspended) return;
  const p = buildP();
  if (p === Sender.last && !force) return;               // 변화가 없으면 보내지 않음
  const parts = p.split(',');
  const important = parts[4] + '|' + parts[5] + '|' + parts[6] + '|' + parts[8];
  const now = performance.now();
  const wait = important !== Sender.lastImportant ? CFG.SEND_MIN_MS : sendInterval();
  if (!force && now - Sender.lastAt < wait) return;
  Sender.last = p; Sender.lastImportant = important; Sender.lastAt = now;
  World.stats.sent++;
  roomRef('pos/' + App.uid + '/p').set(p).catch(netErr('pos'));
}

// ---- 퍼즐 상태 변경 (트랜잭션) ----
function puzzleRef(child) { return roomRef('puzzle/' + World.sk + (child ? '/' + child : '')); }
function throttled(key, ms) {
  const now = performance.now();
  if (World.throttle[key] && now - World.throttle[key] < ms) return true;
  World.throttle[key] = now;
  return false;
}
function claimKey() {
  if (throttled('key', 400)) return;
  const seq = World.seq;
  puzzleRef('key').transaction((cur) => (cur ? undefined : App.uid)).then((r) => {
    if (r.committed && seq === World.seq) toast('열쇠를 주웠어요! 출구 문까지 가져가세요');
  }).catch(netErr('claimKey'));
}
function releaseKey() {
  puzzleRef('key').transaction((cur) => (cur === App.uid ? null : undefined)).catch(netErr('releaseKey'));
}
function unlockExit() {
  if (throttled('unlock', 400)) return;
  puzzleRef('key').transaction((cur) => (cur === App.uid ? '#used' : undefined)).then((r) => {
    if (r.committed) toast('출구가 열렸어요! 모두 출구로 들어가요');
  }).catch(netErr('unlock'));
}
function activateCheckpoint(i) {
  if (throttled('cp' + i, 800)) return;
  puzzleRef('cp').transaction((cur) => ((cur || 0) < i ? i : undefined)).then((r) => {
    if (r.committed) toast('체크포인트!');
  }).catch(netErr('checkpoint'));
}
function triggerCrumble(c) {
  if (crumbleState(c).pending) return;
  if (throttled('cr' + c.id, 300)) return;
  puzzleRef('cr/' + c.id).transaction((cur) => {
    const now = serverNow();
    return !cur || now - cur >= CFG.CRUMBLE_RESTORE_MS ? now : undefined;
  }).catch(netErr('crumble'));
}
function crumbleState(c) {
  const v = World.puzzle.cr[c.id];
  if (!v) return { solid: true, shaking: false, pending: false };
  const e = serverNow() - v;
  if (e < 0) return { solid: true, shaking: true, pending: true };
  if (e < CFG.CRUMBLE_SHAKE_MS) return { solid: true, shaking: true, pending: true };
  if (e < CFG.CRUMBLE_RESTORE_MS) return { solid: false, shaking: false, pending: true };
  return { solid: true, shaking: false, pending: false };
}

// ---- 스위치 · 문 계산 (모든 클라이언트가 같은 데이터로 계산) ----
function computeSwitches() {
  const st = World.st;
  const states = [];
  const me = World.me;
  if (me) states.push({ uid: App.uid, sw: me.sw, supUid: me.sup && me.sup.t === 'p' ? me.sup.uid : null, ok: !me.dead && !me.inExit });
  for (const r of World.remotes.values()) {
    if (!r.ready || r.s !== World.seq || !isOnline(r.uid)) continue;
    states.push({ uid: r.uid, sw: r.sw, supUid: r.supUid, ok: !r.dead && !r.inExit });
  }
  const byUid = new Map(states.map((s) => [s.uid, s]));
  const baseSwitch = (s, d) => {
    if (!s || !s.ok || d > 24) return -1;
    if (s.sw >= 0) return s.sw;
    if (s.supUid) return baseSwitch(byUid.get(s.supUid), d + 1); // 스위치 위에 쌓인 사람도 무게로 인정
    return -1;
  };
  const counts = {};
  for (const s of states) {
    const b = baseSwitch(s, 0);
    if (b >= 0) { const l = String.fromCharCode(97 + b); counts[l] = (counts[l] || 0) + 1; }
  }
  World.nActive = Math.max(1, states.length);
  World.plateCount = counts;
  for (const l of Object.keys(st.plates)) {
    let need = 1;
    try { need = st.plates[l].needFn(World.nActive); } catch (e) { need = 1; }
    need = clamp(Math.round(need) || 0, 0, Math.max(1, World.nActive - 1));
    World.plateNeed[l] = need;
    World.plateOn[l] = (counts[l] || 0) >= need;
  }
  for (const L of Object.keys(st.doors)) {
    World.doorOpen[L] = st.doors[L].rule.some((group) => group.every((l) => !!st.plates[l] && World.plateOn[l] === true));
  }
}

/* -----------------------------------------------------------------
 * 12. 물리 · 충돌 (내 캐릭터만 계산)
 * ----------------------------------------------------------------- */
function solidAt(tx, ty, ignoreGhost) {
  const st = World.st;
  if (tx < 0 || tx >= st.W || ty < 0) return true;     // 좌우 벽 + 천장
  if (ty >= st.H) return false;                         // 아래는 낭떠러지
  const ch = st.grid[ty][tx];
  let solid = false;
  if (ch === '#' || ch === '%') solid = true;
  else if (ch >= 'A' && ch <= 'F') solid = !World.doorOpen[ch];
  else if (ch === 'x') { const c = st.crumbleAt.get(ty * st.W + tx); solid = c ? crumbleState(c).solid : true; }
  if (solid && !ignoreGhost && World.ghost.has(ty * st.W + tx)) return false;
  return solid;
}
function collectGhosts() {
  // 이미 겹쳐 있는 블록(닫히는 문 등)은 이번 프레임에 무시 → 끼임 방지
  const me = World.me, st = World.st;
  World.ghost.clear();
  const x0 = Math.floor((me.x + 0.01) / T), x1 = Math.floor((me.x + CFG.PW - 0.01) / T);
  const y0 = Math.floor((me.y + 0.01) / T), y1 = Math.floor((me.y + CFG.PH - 0.01) / T);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    if (tx >= 0 && tx < st.W && ty >= 0 && ty < st.H && solidAt(tx, ty, true)) World.ghost.add(ty * st.W + tx);
  }
}
function remoteSolid(r) {
  return r.ready && r.s === World.seq && !r.dead && !r.inExit && isOnline(r.uid);
}

function stepLocal(dt, sub) {
  const me = World.me, st = World.st;
  const g = App.game;
  const canMove = !!g && g.status === 'playing' && serverNow() >= World.startAt;
  if (me.inExit) {
    if (canMove && Input.consumeJump()) leaveExit();
    return;
  }
  if (me.dead) {
    Input.consumeJump();
    me.deadT -= dt;
    if (me.deadT <= 0) respawn();
    return;
  }
  // 1) 받침(발판/다른 플레이어) 따라 이동
  if (sub === 0 && me.sup) {
    if (me.sup.t === 'm') {
      const m = st.movers[me.sup.i];
      if (m) { me.x += m.dx; me.y = m.y - CFG.PH; }
    } else if (me.sup.t === 'p') {
      const r = World.remotes.get(me.sup.uid);
      if (r && remoteSolid(r) && hOverlap(me.x, CFG.PW, r.x, CFG.PW) > 0) { me.x += r.dx; me.y = r.y - CFG.PH; }
      else me.sup = null;
    }
  }
  collectGhosts();
  const startOv = new Set();
  for (const r of World.solidList) if (boxOverlap(me.x, me.y, CFG.PW, CFG.PH, r.x, r.y, CFG.PW, CFG.PH)) startOv.add(r.uid);

  // 2) 입력
  let dir = 0;
  if (canMove) { if (Input.left) dir -= 1; if (Input.right) dir += 1; }
  if (Input.consumeJump() && canMove) me.jumpBuf = CFG.JUMP_BUFFER;
  if (dir !== 0) me.moved = true;
  const acc = me.grounded ? CFG.ACCEL : CFG.AIR_ACCEL;
  if (dir !== 0) { me.vx = approach(me.vx, dir * CFG.RUN, acc * dt); me.facing = dir; }
  else me.vx = approach(me.vx, 0, (me.grounded ? CFG.FRICTION : CFG.AIR_ACCEL * 0.6) * dt);

  me.coyote = me.grounded ? CFG.COYOTE : me.coyote - dt;
  me.jumpBuf -= dt;
  if (me.jumpBuf > 0 && me.coyote > 0) {
    me.vy = -CFG.JUMP_V; me.jumpBuf = 0; me.coyote = 0;
    me.grounded = false; me.sup = null; me.jumpHeld = true; me.moved = true;
  }
  if (me.jumpHeld && !Input.jumpHeld) { if (me.vy < 0) me.vy *= CFG.JUMP_CUT; me.jumpHeld = false; }
  if (me.vy >= 0) me.jumpHeld = false;
  me.vy = Math.min(me.vy + CFG.GRAVITY * dt, CFG.MAX_FALL);

  // 3) 이동 + 충돌 (X → Y 순서)
  const wasGrounded = me.grounded;
  const fallVy = me.vy;
  moveX(me.vx * dt, startOv);
  moveY(me.vy * dt, startOv);
  if (!wasGrounded && me.grounded && fallVy > 140) me.landT = 0.12;
  if (me.landT > 0) me.landT -= dt;
  if (!Number.isFinite(me.x) || !Number.isFinite(me.y)) { warn('비정상 좌표 → 재시작'); respawn(); return; }

  postMoveChecks();
}
function moveX(dx, startOv) {
  if (!dx) return;
  const me = World.me;
  const prevX = me.x;
  me.x += dx;
  const y0 = Math.floor(me.y / T), y1 = Math.floor((me.y + CFG.PH - 0.01) / T);
  if (dx > 0) {
    const tx = Math.floor((me.x + CFG.PW - 0.01) / T);
    for (let ty = y0; ty <= y1; ty++) if (solidAt(tx, ty)) { me.x = tx * T - CFG.PW; me.vx = 0; break; }
  } else {
    const tx = Math.floor(me.x / T);
    for (let ty = y0; ty <= y1; ty++) if (solidAt(tx, ty)) { me.x = (tx + 1) * T; me.vx = 0; break; }
  }
  // 다른 플레이어: 옆에서 부딪히면 막힘(밀어내지 않음). 이미 겹친 상대는 무시해 튕김 방지
  for (const r of World.solidList) {
    if (startOv.has(r.uid) || r.supUid === App.uid) continue;
    if (vOverlap(me.y, CFG.PH, r.y, CFG.PH) <= 3) continue;
    if (dx > 0 && prevX + CFG.PW <= r.x + 0.01 && me.x + CFG.PW > r.x) { me.x = r.x - CFG.PW; me.vx = 0; }
    else if (dx < 0 && prevX >= r.x + CFG.PW - 0.01 && me.x < r.x + CFG.PW) { me.x = r.x + CFG.PW; me.vx = 0; }
  }
}
function moveY(dy, startOv) {
  const me = World.me, st = World.st;
  const prevY = me.y, prevBottom = prevY + CFG.PH;
  me.y += dy;
  me.grounded = false; me.sup = null;
  const x0 = Math.floor(me.x / T), x1 = Math.floor((me.x + CFG.PW - 0.01) / T);
  if (dy > 0) {
    const bottom = me.y + CFG.PH;
    let best = Infinity, sup = null;
    // 지형
    const ty = Math.floor((bottom - 0.01) / T);
    const top = ty * T;
    if (top >= prevBottom - 0.5) {
      for (let tx = x0; tx <= x1; tx++) {
        if (solidAt(tx, ty) || tileCh(tx, ty) === '-') { best = top; sup = { t: 'g' }; break; }
      }
    }
    // 움직이는 발판 (위에서만 착지)
    for (let i = 0; i < st.movers.length; i++) {
      const m = st.movers[i];
      if (hOverlap(me.x, CFG.PW, m.x, m.w * T) <= 0.5) continue;
      const prevTop = m.y - m.dy;
      if (prevBottom <= Math.max(m.y, prevTop) + 1.5 && bottom >= m.y - 0.01 && m.y < best) { best = m.y; sup = { t: 'm', i }; }
    }
    // 다른 플레이어 머리 위 착지
    for (const r of World.solidList) {
      if (startOv.has(r.uid) || r.supUid === App.uid) continue;
      if (hOverlap(me.x, CFG.PW, r.x, CFG.PW) < 2) continue;
      if (prevBottom <= r.y + 2 && bottom >= r.y - 0.01 && r.y < best) { best = r.y; sup = { t: 'p', uid: r.uid }; }
    }
    if (best < Infinity) {
      me.y = best - CFG.PH; me.vy = 0; me.grounded = true; me.sup = sup;
    }
  } else if (dy < 0) {
    const ty = Math.floor(me.y / T);
    for (let tx = x0; tx <= x1; tx++) if (solidAt(tx, ty)) { me.y = (ty + 1) * T; me.vy = 0; break; }
    for (const r of World.solidList) {
      if (startOv.has(r.uid) || r.supUid === App.uid) continue;
      if (hOverlap(me.x, CFG.PW, r.x, CFG.PW) < 2) continue;
      if (prevY >= r.y + CFG.PH - 2 && me.y < r.y + CFG.PH) { me.y = r.y + CFG.PH; me.vy = 0; }
    }
  }
}
function touchSpike() {
  const me = World.me;
  const x0 = Math.floor(me.x / T), x1 = Math.floor((me.x + CFG.PW - 0.01) / T);
  const y0 = Math.floor(me.y / T), y1 = Math.floor((me.y + CFG.PH - 0.01) / T);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    if (tileCh(tx, ty) === '^' && boxOverlap(me.x + 1, me.y + 1, CFG.PW - 2, CFG.PH - 1, tx * T + 1, ty * T + 9, 14, 7)) return true;
  }
  return false;
}
function postMoveChecks() {
  const me = World.me, st = World.st;
  if (me.y > st.H * T + 24) { die(); return; }
  if (touchSpike()) { die(); return; }
  for (const s of st.saws) if (circleBox(s.cx, s.cy, 5.5, me.x, me.y, CFG.PW, CFG.PH)) { die(); return; }
  // 스위치 판정(발밑) · 무너지는 블록 발동
  me.sw = -1;
  if (me.grounded && me.sup && me.sup.t === 'g') {
    const fy = Math.floor((me.y + CFG.PH - 1) / T);
    for (const fx of [me.x + 2, me.x + CFG.PW - 2]) {
      const ch = tileCh(Math.floor(fx / T), fy);
      if (ch >= 'a' && ch <= 'f') { me.sw = ch.charCodeAt(0) - 97; break; }
    }
    const by = Math.floor((me.y + CFG.PH + 1) / T);
    for (const fx of [me.x + 1, me.x + CFG.PW - 1]) {
      const tx = Math.floor(fx / T);
      if (tileCh(tx, by) === 'x') { const c = st.crumbleAt.get(by * st.W + tx); if (c) triggerCrumble(c); }
    }
  }
  // 체크포인트
  for (let i = 0; i < st.cps.length; i++) {
    const c = st.cps[i];
    if (i + 1 > World.puzzle.cp && boxOverlap(me.x, me.y, CFG.PW, CFG.PH, c.x * T + 3, c.y * T, 10, 16)) activateCheckpoint(i + 1);
  }
  // 열쇠
  const ex = st.exit;
  const exitBox = [ex.x * T + 3, (ex.y - 1) * T, 10, 32];
  if (st.key) {
    const k = World.puzzle.key;
    if (!k && World.puzzleLoaded && boxOverlap(me.x, me.y, CFG.PW, CFG.PH, st.key.x * T + 1, st.key.y * T + 3, 14, 10)) claimKey();
    if (k === App.uid && boxOverlap(me.x, me.y, CFG.PW, CFG.PH, ...exitBox)) unlockExit();
  }
  // 출구 입장
  if (World.unlocked && me.grounded && boxOverlap(me.x, me.y, CFG.PW, CFG.PH, ...exitBox)) enterExit();
}
function die() {
  const me = World.me;
  if (me.dead) return;
  me.dead = true; me.deadT = CFG.RESPAWN_MS / 1000;
  me.vx = 0; me.vy = 0; me.sup = null; me.sw = -1; me.grounded = false;
  if (World.puzzle.key === App.uid) releaseKey();      // 열쇠는 제자리로
}
function respawn() {
  const me = World.me;
  if (!me || !World.st) return;
  const p = spawnPoint(World.puzzle.cp || 0);
  me.x = p.x; me.y = p.y; me.vx = 0; me.vy = 0;
  me.dead = false; me.inExit = false; me.sup = null; me.grounded = false; me.sw = -1; me.jumpBuf = 0;
}
function enterExit() {
  const me = World.me;
  me.inExit = true; me.vx = 0; me.vy = 0; me.sup = null; me.sw = -1;
  World.spectate = null;
  Input.edgeLeft = Input.edgeRight = 0;
}
function leaveExit() {
  const me = World.me;
  me.inExit = false; me.vy = -180; me.grounded = false;
}

/* -----------------------------------------------------------------
 * 13. Phaser 씬 · 렌더
 * ----------------------------------------------------------------- */
let PhaserGame = null, Scene = null, phaserReady = null;
let fontsReady = null;
function waitFonts() {
  if (fontsReady) return fontsReady;
  fontsReady = Promise.race([
    (document.fonts && document.fonts.load) ? Promise.all([document.fonts.load('12px Galmuri11'), document.fonts.load('12px Galmuri9')]) : Promise.resolve(),
    new Promise((r) => setTimeout(r, 2500)),
  ]).catch(() => {});
  return fontsReady;
}
function ensurePhaser() {
  if (phaserReady) return phaserReady;
  phaserReady = (async () => {
    if (typeof Phaser === 'undefined') {
      fatal('게임 엔진(Phaser)을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.');
      throw new Error('Phaser 없음');
    }
    await waitFonts();
    return new Promise((resolve) => {
      class PikaScene extends Phaser.Scene {
        constructor() { super('pika'); }
        create() {
          Scene = this;
          this.view = null;
          addBaseTextures(this);
          this.cameras.main.setZoom(CFG.ZOOM).setRoundPixels(true);
          this.camTarget = this.add.zone(0, 0, 2, 2);
          resolve(this);
        }
        update(time, delta) {
          try { frameUpdate(this, delta); } catch (e) { reportError(e, 'frame'); }
        }
      }
      PhaserGame = new Phaser.Game({
        type: Phaser.AUTO,
        parent: 'game-root',
        width: CFG.VIEW_W, height: CFG.VIEW_H,
        backgroundColor: '#0d0b18',
        pixelArt: true, roundPixels: true, antialias: false,
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        input: { keyboard: false, mouse: false, touch: false, gamepad: false },
        audio: { noAudio: true },
        banner: false,
        fps: { target: 60 },
        scene: [PikaScene],
      });
    });
  })();
  phaserReady.catch((e) => { phaserReady = null; warn(e); });
  return phaserReady;
}
function addTex(scene, key, canvas) { if (!scene.textures.exists(key)) scene.textures.addCanvas(key, canvas); }
function addBaseTextures(scene) {
  addTex(scene, 'crumble', ART.crumble); addTex(scene, 'crumble2', ART.crumble2);
  addTex(scene, 'key', ART.key); addTex(scene, 'saw', ART.saw);
  addTex(scene, 'exit_0', ART.exitClosed); addTex(scene, 'exit_1', ART.exitOpen);
  addTex(scene, 'flag_0', ART.flag[0]); addTex(scene, 'flag_1', ART.flag[1]);
  addTex(scene, 'plate_off', ART.plateOff);
  for (const l of Object.keys(PLATE_COLORS)) {
    addTex(scene, 'door_' + l, ART.door[l]);
    addTex(scene, 'plate_' + l + '_0', ART.plate[l][0]);
    addTex(scene, 'plate_' + l + '_1', ART.plate[l][1]);
  }
}
const pikaKey = (slot, frame) => 'pk_' + slot + '_' + frame;
function ensurePikaTextures(scene, slot) {
  if (scene.textures.exists(pikaKey(slot, 'idle'))) return;
  for (const f of PIKA_FRAME_NAMES) addTex(scene, pikaKey(slot, f), drawPika(slot, f, 1));
}
function moverKey(scene, w) {
  const k = 'mover_' + w;
  addTex(scene, k, moverCanvas(w));
  return k;
}
function textStyle(worldSize, color) {
  return {
    fontFamily: 'Galmuri11, Galmuri9, monospace',
    fontSize: (worldSize * 2) + 'px',
    color: color || '#ffffff',
    stroke: '#120f22',
    strokeThickness: 4,
  };
}
function renderStaticMap(st) {
  const c = makeCanvas(st.W * T, st.H * T);
  const g = c.getContext('2d');
  for (let y = 0; y < st.H; y++) {
    for (let x = 0; x < st.W; x++) {
      const ch = st.grid[y][x];
      let img = null;
      if (ch === '#') img = y > 0 && st.grid[y - 1][x] === '#' ? ART.dirt : ART.grass;
      else if (ch === '%') img = ART.brick;
      else if (ch === '-') img = ART.oneway;
      else if (ch === '^') img = ART.spike;
      if (img) g.drawImage(img, x * T, y * T);
    }
  }
  return c;
}
function buildStageView(scene, st) {
  destroyStageView(scene);
  const V = { objs: [], tex: [], doors: [], plates: [], crumbles: [], cps: [], movers: [], saws: [], players: new Map(), exit: null, key: null };
  scene.view = V;
  const add = (o) => { V.objs.push(o); return o; };
  const stamp = World.seq + '_' + Date.now();
  const worldW = st.W * T, worldH = st.H * T;

  const bgKey = 'bg_' + stamp, mapKey = 'map_' + stamp;
  scene.textures.addCanvas(bgKey, makeBackground(st.def.theme || 0, worldW, worldH)); V.tex.push(bgKey);
  scene.textures.addCanvas(mapKey, renderStaticMap(st)); V.tex.push(mapKey);
  add(scene.add.image(0, 0, bgKey).setOrigin(0).setScrollFactor(CFG.BG_PARALLAX).setDepth(0));
  add(scene.add.image(0, 0, mapKey).setOrigin(0).setDepth(1));

  for (const L of Object.keys(st.doors)) {
    for (const t of st.doors[L].tiles) V.doors.push({ L, img: add(scene.add.image(t.x * T, t.y * T, 'door_' + L.toLowerCase()).setOrigin(0).setDepth(2)) });
  }
  for (const l of Object.keys(st.plates)) {
    const p = st.plates[l];
    const imgs = p.tiles.map((t) => add(scene.add.image(t.x * T, t.y * T, 'plate_' + l + '_0').setOrigin(0).setDepth(2)));
    const label = add(scene.add.text((p.minX + p.maxX + 1) * T / 2, p.y * T + 8, '', textStyle(6, PLATE_COLORS[l])).setOrigin(0.5, 1).setScale(0.5).setDepth(8));
    V.plates.push({ l, imgs, label, state: '' });
  }
  for (const c of st.crumbles) V.crumbles.push({ c, img: add(scene.add.image(c.x * T, c.y * T, 'crumble').setOrigin(0).setDepth(2)), state: '' });
  st.cps.forEach((c, i) => V.cps.push({ i: i + 1, img: add(scene.add.image(c.x * T, c.y * T, 'flag_0').setOrigin(0).setDepth(2)), on: false }));
  V.exit = add(scene.add.image(st.exit.x * T, (st.exit.y - 1) * T, 'exit_0').setOrigin(0).setDepth(2));
  st.movers.forEach((m) => V.movers.push({ m, img: add(scene.add.image(m.x, m.y, moverKey(scene, m.w)).setOrigin(0).setDepth(3)) }));
  st.saws.forEach((s) => V.saws.push({ s, img: add(scene.add.image(s.cx, s.cy, 'saw').setDepth(3)) }));
  if (st.key) V.key = add(scene.add.image(0, 0, 'key').setDepth(6));

  const cam = scene.cameras.main;
  cam.setBounds(0, 0, worldW, worldH);
  const me = World.me;
  scene.camTarget.setPosition(me.x + CFG.PW / 2, me.y);
  cam.startFollow(scene.camTarget, true, 0.15, 0.15);
  cam.centerOn(me.x, me.y);
}
function destroyStageView(scene) {
  const V = scene.view;
  if (!V) return;
  for (const o of V.objs) { try { o.destroy(); } catch (e) { /* 무시 */ } }
  for (const pv of V.players.values()) destroyPlayerView(pv);
  for (const k of V.tex) { try { scene.textures.remove(k); } catch (e) { /* 무시 */ } }
  scene.view = null;
}
function ensurePlayerView(scene, uid) {
  const V = scene.view;
  const p = App.players[uid];
  if (!p) return null;
  const slot = +p.slot, name = p.name;
  let pv = V.players.get(uid);
  if (pv && pv.slot === slot && pv.name === name) return pv;
  if (pv) destroyPlayerView(pv);
  ensurePikaTextures(scene, slot);
  const isMe = uid === App.uid;
  pv = {
    uid, slot, name, frame: '',
    spr: scene.add.image(0, 0, pikaKey(slot, 'idle')).setOrigin(0.5, 1).setDepth(isMe ? 5.5 : 5),
    label: scene.add.text(0, 0, `${slot + 1} ${name}`, textStyle(5, PALETTE[slot % PALETTE.length].body)).setOrigin(0.5, 1).setScale(0.5).setDepth(isMe ? 9.5 : 9),
    marker: isMe ? scene.add.text(0, 0, '▼', textStyle(5, '#ffffff')).setOrigin(0.5, 1).setScale(0.5).setDepth(9.6) : null,
  };
  V.players.set(uid, pv);
  return pv;
}
function destroyPlayerView(pv) {
  try { pv.spr.destroy(); pv.label.destroy(); if (pv.marker) pv.marker.destroy(); } catch (e) { /* 무시 */ }
}
function frameName(anim, t, phase) {
  switch (anim) {
    case ANIM.WALK: return Math.floor((t + phase) / 110) % 2 ? 'walk1' : 'walk2';
    case ANIM.JUMP: return 'jump';
    case ANIM.FALL: return 'fall';
    case ANIM.HURT: return 'hurt';
    case ANIM.CLEAR: return Math.floor((t + phase) / 300) % 2 ? 'clear' : 'jump';
    default: return Math.floor((t + phase) / 520) % 2 ? 'idle2' : 'idle';
  }
}

// ---- 매 프레임 ----
function frameUpdate(scene, delta) {
  if (!World.st || !World.me || App.screen !== 'game' || !scene.view) return;
  const dt = Math.min(delta, 100) / 1000;
  Input.refresh();
  if (BOT_MODE) Bot.update(dt);
  const tStage = Math.max(0, serverNow() - World.startAt);
  updateMoving(tStage);
  resolveRemotes(dt);
  computeSwitches();
  // 렌더 주기와 무관하게 1/60초 이하 단위로 나눠 계산
  const steps = clamp(Math.ceil(dt / (1 / 60)), 1, 6);
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) stepLocal(sdt, i);
  resolveRemotes(0);   // 내 머리 위에 올라탄 친구 위치 갱신
  maybeSend(false);
  render(scene);
  updateCountdown();
  updateHud(false);
  if (DEBUG) debugStats();
}
function resolveRemotes(dt) {
  const now = performance.now();
  const remotes = World.remotes;
  for (const r of remotes.values()) {
    r._done = false;
    r.supUid = null; r.supIdx = -1;
    if (r.supCode >= 1 && r.supCode <= CFG.MAX_PLAYERS) r.supUid = App.slotMap[r.supCode - 1] || null;
    else if (r.supCode >= 100) r.supIdx = r.supCode - 100;
  }
  for (const r of remotes.values()) resolveRemote(r, 0, now, dt);
  if (dt > 0) World.solidList = Array.from(remotes.values()).filter(remoteSolid);
}
function resolveRemote(r, depth, now, dt) {
  if (r._done || !r.ready) return;
  r._done = true;
  const st = World.st;
  const px0 = r.x, py0 = r.y;
  let attached = false;
  if (!r.dead && !r.inExit && r.s === World.seq) {
    if (r.supUid && depth < 24) {
      if (r.supUid === App.uid) {
        const me = World.me;
        if (me && !me.inExit && !me.dead) { r.x = me.x + r.ox; r.y = me.y - CFG.PH; attached = true; }
      } else {
        const b = World.remotes.get(r.supUid);
        if (b && b.ready) {
          resolveRemote(b, depth + 1, now, dt);
          if (remoteSolid(b)) { r.x = b.x + r.ox; r.y = b.y - CFG.PH; attached = true; }
        }
      }
    } else if (r.supIdx >= 0 && st && st.movers[r.supIdx]) {
      const m = st.movers[r.supIdx];
      r.x = m.x + r.ox; r.y = m.y - CFG.PH; attached = true;
    }
  }
  if (!attached && dt > 0) {
    // 데드 레커닝 + 부드러운 보간
    const age = Math.min(now - r.recvAt, CFG.EXTRAP_MAX_MS) / 1000;
    const still = r.dead || r.inExit;
    const tx = r.nx + (still ? 0 : r.nvx * age);
    const ty = r.ny + (still || r.grounded ? 0 : r.nvy * age);
    const d = Math.abs(tx - r.x) + Math.abs(ty - r.y);
    if (!r.drawn || d > CFG.SNAP_DIST) { r.x = tx; r.y = ty; r.drawn = true; }
    else { const k = 1 - Math.exp(-CFG.INTERP_RATE * dt); r.x += (tx - r.x) * k; r.y += (ty - r.y) * k; }
  }
  if (dt > 0) {
    r.dx = r.x - px0; r.dy = r.y - py0;
    if (Math.abs(r.dx) > 24) r.dx = 0;
  }
}
function render(scene) {
  const V = scene.view, st = World.st, me = World.me;
  const now = performance.now();
  // 문
  for (const d of V.doors) {
    const a = World.doorOpen[d.L] ? 0.16 : 1;
    if (d.img.alpha !== a) d.img.setAlpha(a);
  }
  // 스위치
  for (const p of V.plates) {
    const need = World.plateNeed[p.l] || 0, cnt = World.plateCount[p.l] || 0, on = !!World.plateOn[p.l];
    const state = need + ':' + cnt + ':' + on;
    if (state === p.state) continue;
    p.state = state;
    const key = need === 0 ? 'plate_off' : 'plate_' + p.l + '_' + (on ? 1 : 0);
    for (const img of p.imgs) img.setTexture(key);
    p.label.setText(need === 0 ? '' : `${Math.min(cnt, 99)}/${need}`);
  }
  // 무너지는 블록
  for (const c of V.crumbles) {
    const s = crumbleState(c.c);
    const state = s.solid ? (s.shaking ? 'shake' : 'ok') : 'gone';
    if (state === 'shake') c.img.setPosition(c.c.x * T + (Math.random() < 0.5 ? -1 : 1), c.c.y * T);
    if (state !== c.state) {
      c.state = state;
      c.img.setVisible(state !== 'gone').setTexture(state === 'shake' ? 'crumble2' : 'crumble').setPosition(c.c.x * T, c.c.y * T);
    }
  }
  // 체크포인트
  for (const c of V.cps) {
    const on = World.puzzle.cp >= c.i;
    if (on !== c.on) { c.on = on; c.img.setTexture(on ? 'flag_1' : 'flag_0'); }
  }
  V.exit.setTexture(World.unlocked ? 'exit_1' : 'exit_0');
  for (const m of V.movers) m.img.setPosition(Math.round(m.m.x), Math.round(m.m.y));
  for (const s of V.saws) s.img.setPosition(Math.round(s.s.cx), Math.round(s.s.cy)).setRotation(now / 120);

  // 플레이어
  const cleared = App.game && (App.game.status === 'cleared' || App.game.status === 'finished');
  const seen = new Set();
  const drawPlayer = (uid, x, y, anim, facing, dead, inExit, landT, phase) => {
    const pv = ensurePlayerView(scene, uid);
    if (!pv) return null;
    seen.add(uid);
    const visible = !inExit;
    pv.spr.setVisible(visible); pv.label.setVisible(visible);
    if (pv.marker) pv.marker.setVisible(visible);
    if (!visible) return pv;
    const fname = frameName(cleared ? ANIM.CLEAR : anim, now, phase);
    if (fname !== pv.frame) { pv.frame = fname; pv.spr.setTexture(pikaKey(pv.slot, fname)); }
    const cx = Math.round(x + CFG.PW / 2), by = Math.round(y + CFG.PH + 1);
    pv.spr.setPosition(cx, by).setFlipX(facing < 0);
    pv.spr.setScale(landT > 0 ? 1.12 : 1, landT > 0 ? 0.86 : 1);
    pv.spr.setAlpha(dead ? (Math.floor(now / 90) % 2 ? 0.25 : 0.85) : 1);
    pv.label.setPosition(cx, by - 17);
    if (pv.marker) pv.marker.setPosition(cx, by - 22);
    return pv;
  };
  for (const r of World.remotes.values()) {
    if (!r.ready || r.s !== World.seq || !isOnline(r.uid)) continue;
    drawPlayer(r.uid, r.x, r.y, r.anim, r.facing, r.dead, r.inExit, 0, (r.uid.charCodeAt(0) || 0) * 37);
  }
  drawPlayer(App.uid, me.x, me.y, localAnim(), me.facing, me.dead, me.inExit, me.landT, 0);
  for (const [uid, pv] of V.players) if (!seen.has(uid)) { destroyPlayerView(pv); V.players.delete(uid); }

  // 열쇠
  if (V.key) {
    const k = World.puzzle.key;
    if (k === '#used') V.key.setVisible(false);
    else {
      V.key.setVisible(true);
      let kx = st.key.x * T + 8, ky = st.key.y * T + 8 + Math.round(Math.sin(now / 300) * 1.5);
      if (k) {
        let hx = null, hy = null;
        if (k === App.uid) { hx = me.x; hy = me.y; }
        else { const r = World.remotes.get(k); if (r && r.ready) { hx = r.x; hy = r.y; } }
        if (hx != null) { kx = hx + CFG.PW / 2; ky = hy - 22 + Math.round(Math.sin(now / 200)); }
      }
      V.key.setPosition(Math.round(kx), Math.round(ky));
    }
  }

  // 카메라: 출구 안에 있으면 남은 친구를 관전
  let fx = me.x + CFG.PW / 2, fy = me.y;
  if (me.inExit) {
    const cands = Array.from(World.remotes.values()).filter((r) => r.ready && r.s === World.seq && !r.inExit && isOnline(r.uid))
      .sort((a, b) => (+(App.players[a.uid] || {}).slot || 0) - (+(App.players[b.uid] || {}).slot || 0));
    if (cands.length) {
      let idx = Math.max(0, cands.findIndex((r) => r.uid === World.spectate));
      if (Input.edgeRight) idx = (idx + 1) % cands.length;
      if (Input.edgeLeft) idx = (idx - 1 + cands.length) % cands.length;
      World.spectate = cands[idx].uid;
      fx = cands[idx].x + CFG.PW / 2; fy = cands[idx].y;
    }
  }
  Input.edgeLeft = Input.edgeRight = 0;
  scene.camTarget.setPosition(fx, fy);
  $('spectate-tip').classList.toggle('hidden', !me.inExit || cleared);
}

/* -----------------------------------------------------------------
 * 14. HUD · 대기실 · 결과 화면
 * ----------------------------------------------------------------- */
let hudAt = 0;
function updateHud(force) {
  const now = performance.now();
  if (!force && now - hudAt < 150) return;
  hudAt = now;
  const st = World.st;
  if (!st || !World.me) return;
  $('hud-stage').textContent = `STAGE ${st.idx + 1}/${STAGES.length} · ${st.def.title}`;
  if (force) $('hud-goal').textContent = st.def.hint;
  let total = 0, inExit = 0;
  for (const id of activeUids()) {
    total++;
    if (id === App.uid) { if (World.me.inExit) inExit++; continue; }
    const r = World.remotes.get(id);
    if (r && r.s === World.seq && r.inExit) inExit++;
  }
  let keyText;
  if (!st.key) keyText = '출구 열림';
  else {
    const k = World.puzzle.key;
    keyText = !k ? '열쇠: 아직 없음' : k === '#used' ? '출구 열림' : `열쇠: ${nameOf(k)}`;
  }
  $('hud-info').textContent = `출구 ${inExit}/${total} · ${keyText}`;
}
let cdText = '';
function updateCountdown() {
  const el = $('countdown');
  let text = '';
  if (App.game && App.game.status === 'playing') {
    const remain = World.startAt - serverNow();
    if (remain > 0) text = String(Math.ceil(remain / 1000));
    else if (remain > -800) text = 'GO!';
  }
  if (text !== cdText) {
    cdText = text;
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }
}

let lobbyQueued = false;
function renderLobbySoon() {
  if (lobbyQueued) return;
  lobbyQueued = true;
  requestAnimationFrame(() => { lobbyQueued = false; renderLobby(); });
}
function renderLobby() {
  if (App.screen !== 'lobby' || !App.roomCode) return;
  $('lobby-code').textContent = App.roomCode;
  const list = sortedPlayers();
  const online = list.filter(([uid]) => isOnline(uid)).length;
  $('lobby-count').textContent = String(online);
  const ul = $('player-list');
  const frag = document.createDocumentFragment();
  for (const [uid, p] of list) {
    const li = document.createElement('li');
    if (uid === App.uid) li.classList.add('me');
    if (!isOnline(uid)) li.classList.add('offline');
    const img = document.createElement('img');
    img.src = pikaPreviewURL(+p.slot); img.alt = '';
    const num = document.createElement('span'); num.className = 'num'; num.textContent = String(+p.slot + 1);
    const nm = document.createElement('span'); nm.className = 'pname'; nm.textContent = p.name;
    const dot = document.createElement('span'); dot.className = 'dot ' + (isOnline(uid) ? 'on' : 'off');
    dot.title = isOnline(uid) ? '연결됨' : '연결 끊김';
    li.append(img, num, nm);
    if (App.info && App.info.host === uid) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = '방장'; li.append(t); }
    if (uid === App.uid) { const t = document.createElement('span'); t.className = 'tag me'; t.textContent = '나'; li.append(t); }
    li.append(dot);
    frag.append(li);
  }
  ul.replaceChildren(frag);
  const host = canControl();
  const btn = $('btn-start');
  btn.classList.toggle('hidden', !host);
  btn.disabled = online < CFG.MIN_PLAYERS;
  $('lobby-msg').textContent = host
    ? (online < CFG.MIN_PLAYERS ? '2명 이상 모이면 시작할 수 있어요. 방 코드를 친구에게 알려 주세요!' : '준비되면 게임 시작을 눌러 주세요.')
    : '운영진이 게임을 시작할 때까지 기다려 주세요.';
}

function participantsHtml() {
  return '<div class="result-names">' + sortedPlayers().filter(([uid]) => isOnline(uid)).map(([, p]) =>
    `<span><i style="background:${PALETTE[+p.slot % PALETTE.length].body}"></i>${escapeHtml(p.name)}</span>`).join('') + '</div>';
}
function mkBtn(text, cls, fn) {
  const b = document.createElement('button');
  b.className = 'btn ' + (cls || '');
  b.textContent = text;
  b.onclick = fn;
  return b;
}
function updateResultModal() {
  const g = App.game;
  if (!g || !World.st || g.seq !== World.seq || (g.status !== 'cleared' && g.status !== 'finished')) { hideModal('result-modal'); return; }
  const host = canControl();
  const times = g.times || {};
  const body = $('result-body'), actions = $('result-actions');
  actions.replaceChildren();
  if (g.status === 'cleared') {
    $('result-title').textContent = `STAGE ${g.stage + 1} CLEAR!`;
    body.innerHTML = `<table class="result-table">
      <tr><td>스테이지</td><td>${g.stage + 1}. ${escapeHtml(STAGES[g.stage].title)}</td></tr>
      <tr><td>진행 시간</td><td>${fmtTime(times['t' + g.stage])}</td></tr>
      <tr><td>참가자</td><td>${activeUids().length}명</td></tr></table>${participantsHtml()}`;
    if (host) {
      actions.append(mkBtn('다음 스테이지', 'primary', hostNext), mkBtn('다시 도전', '', hostRetry), mkBtn('대기실로', 'ghost', hostToLobby));
    } else {
      body.insertAdjacentHTML('beforeend', '<p class="wait-note">운영진이 다음 단계를 고르고 있어요…</p>');
      actions.append(mkBtn('방 나가기', 'ghost', askLeave));
    }
  } else {
    $('result-title').textContent = 'ALL CLEAR!';
    const vals = Object.values(times).filter((v) => typeof v === 'number');
    const sum = vals.reduce((a, b) => a + b, 0);
    body.innerHTML = `<table class="result-table">
      <tr><td>최종 결과</td><td>모든 스테이지 클리어</td></tr>
      <tr><td>클리어한 스테이지</td><td>${vals.length} / ${STAGES.length}</td></tr>
      <tr><td>스테이지 기록 합계</td><td>${fmtTime(sum)}</td></tr>
      <tr><td>총 플레이 시간</td><td>${fmtTime((g.clearedAt || 0) - (g.runStartAt || 0))}</td></tr>
      <tr><td>참가자</td><td>${activeUids().length}명</td></tr></table>${participantsHtml()}`;
    if (host) actions.append(mkBtn('처음부터 다시', 'primary', hostStartRun), mkBtn('대기실로', 'ghost', hostToLobby));
    else {
      body.insertAdjacentHTML('beforeend', '<p class="wait-note">수고했어요! 운영진의 선택을 기다리는 중…</p>');
      actions.append(mkBtn('방 나가기', 'ghost', askLeave));
    }
  }
  showModal('result-modal');
}
function openMenu() {
  const box = $('menu-actions');
  box.replaceChildren();
  if (canControl() && App.game && App.game.status === 'playing') {
    box.append(mkBtn('이 스테이지 다시 시작', '', async () => {
      hideModal('menu-modal');
      if (await confirmDialog('모두 처음 위치에서 이 스테이지를 다시 시작할까요?')) hostRetry();
    }));
  }
  if (canControl()) {
    box.append(mkBtn('대기실로 돌아가기', '', async () => {
      hideModal('menu-modal');
      if (await confirmDialog('게임을 멈추고 모두 대기실로 돌아갈까요?')) hostToLobby();
    }));
  }
  box.append(mkBtn('조작 방법', '', () => toast('이동: ←→ / A D · 점프: 스페이스 / W / ↑ · 길게 누르면 더 높이')));
  box.append(mkBtn('방 나가기', 'danger', () => { hideModal('menu-modal'); askLeave(); }));
  box.append(mkBtn('닫기', 'ghost', () => hideModal('menu-modal')));
  showModal('menu-modal');
}
async function askLeave() {
  if (await confirmDialog('방에서 나갈까요?')) leaveRoom();
}

let statAt = 0;
function debugStats() {
  const now = performance.now();
  if (now - statAt < 10000) return;
  const sec = (now - World.stats.since) / 1000;
  log(`[통계] 보냄 ${(World.stats.sent / sec).toFixed(1)}/초, 받음 ${(World.stats.recv / sec).toFixed(1)}/초, 전송 간격 ${sendInterval()}ms, 인원 ${World.nActive}`);
  statAt = now;
  World.stats = { sent: 0, recv: 0, since: now };
}

/* -----------------------------------------------------------------
 * 15. 부트
 * ----------------------------------------------------------------- */
function bindUi() {
  $('btn-create').onclick = createRoom;
  $('btn-admin-login').onclick = adminLogin;
  $('btn-admin-logout').onclick = adminLogout;
  $('btn-copy-uid').onclick = async () => {
    try { await navigator.clipboard.writeText(App.uid || ''); toast('내 ID를 복사했어요'); }
    catch (e) { toast('복사하지 못했어요. 화면의 ID를 직접 옮겨 적어 주세요.', true); }
  };
  $('btn-join').onclick = () => joinRoom();
  $('input-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  });
  $('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { if ($('input-code').value) joinRoom(); else createRoom(); } });
  $('btn-copy').onclick = async () => {
    const code = App.roomCode || '';
    try { await navigator.clipboard.writeText(code); toast('방 코드를 복사했어요: ' + code); }
    catch (e) { toast('복사하지 못했어요. 코드를 직접 알려 주세요: ' + code, true); }
  };
  $('btn-start').onclick = hostStartRun;
  $('btn-leave').onclick = askLeave;
  $('btn-menu').onclick = openMenu;
  window.addEventListener('resize', updateRotateTip);
  window.addEventListener('orientationchange', () => setTimeout(() => {
    updateRotateTip();
    if (PhaserGame) PhaserGame.scale.refresh();
  }, 250));
}
function boot() {
  window.addEventListener('error', (e) => reportError(e.error || e.message, 'window'));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'promise'));
  try {
    ART = buildArt();
  } catch (e) {
    console.error(e);
    fatal('그래픽을 준비하지 못했어요. 다른 브라우저로 접속해 보세요.');
    return;
  }
  const logo = $('logo-pika');
  if (logo) { const g = logo.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(drawPika(0, 'clear', 3), 0, 0); }
  $('input-name').value = storageGet('pika_name') || '';
  const qRoom = (QS.get('room') || '').toUpperCase();
  if (CODE_RE.test(qRoom)) $('input-code').value = qRoom;
  bindUi();
  setupKeyboard();
  setupTouch();
  initFirebase();
  // 디버깅용 핸들(콘솔에서 PikaDebug.world 등으로 상태 확인)
  window.PikaDebug = { App, World, CFG, STAGES };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
