'use strict';

/* ---------- 날짜 유틸 (로컬 날짜 기준 YYYY-MM-DD) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => fmt(new Date());
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return fmt(d); };
const diffDays = (a, b) => {
  const u = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((u(b) - u(a)) / 864e5);
};
const weekStart = (s) => { const d = parseDay(s); const dow = (d.getDay() + 6) % 7; return addDays(s, -dow); }; // 월요일
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/* ---------- 저장소 ---------- */
const STORE_KEY = 'toeic-review-v1';

function defaultState() {
  const tests = {};
  for (let i = 1; i <= 10; i++) tests[i] = { status: '미시작' };
  return {
    version: 1,
    settings: { newWordGoal: 35, studyMinutes: 90 },
    tests,
    voca: {}, // 보카 DAY → 끝낸 날짜
    mistakes: [],
    words: [],
    checklist: {},
    weekly: {},
    log: {}, // 날짜별 { words, mistakes, newWords }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    const d = defaultState();
    return { ...d, ...s, settings: { ...d.settings, ...s.settings }, tests: { ...d.tests, ...s.tests } };
  } catch (e) {
    console.error(e);
    return defaultState();
  }
}

let state = loadState();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('저장 실패: 백업 파일을 내보내 두세요.'); }
}
function bumpLog(field, n = 1) {
  const t = today();
  state.log[t] = state.log[t] || { words: 0, mistakes: 0, newWords: 0 };
  state.log[t][field] = (state.log[t][field] || 0) + n;
}

/* ---------- UI 상태 ---------- */
const ui = {
  tab: 'home',
  wordSub: 'review',
  mistakeSub: 'review',
  revealed: false,
  lcSteps: [],
  openTest: null,
  wordFilter: 'all',
  wordQuery: '',
  mFilter: { test: '', part: '', cause: '' },
  editWord: null,
  editMistake: null,
  draftPart: 5,
  moreSub: 'timer',
  // 사진 인식: status = idle | working | done | error
  ocr: { status: 'idle', step: '', progress: 0, error: '', items: [], withKorean: true, markWrong: true, source: 'photo', pasteText: '' },
};

const timer = { presetKey: 'p5', total: 12 * 60, left: 12 * 60, running: false, handle: null, startedAt: 0, elapsedBefore: 0 };

/* ---------- 계산 ---------- */
// 회차의 다음 단계: solve → review → nextDay → weekAfter → done
function testStep(n) {
  const t = state.tests[n];
  if (t.status === '미시작') return 'solve';
  if (t.status === '풀이 완료') return 'review';
  if (t.status === '복습 완료') return 'done';
  if (!t.nextDay) return 'nextDay';
  if (!t.weekAfter) return 'weekAfter';
  return 'done';
}

// 재확인 단계를 할 수 있는 날 (풀이 날짜 기준 다음 날 / 7일 뒤)
function stepAvailableFrom(n, step) {
  const d = state.tests[n].date;
  if (!d) return today();
  if (step === 'nextDay') return addDays(d, 1);
  if (step === 'weekAfter') return addDays(d, 7);
  return today();
}

const TEST_NUMS = Array.from({ length: TEST_COUNT }, (_, i) => i + 1);

function progress() {
  const steps = Object.fromEntries(TEST_NUMS.map((n) => [n, testStep(n)]));
  const nextSolve = TEST_NUMS.find((n) => steps[n] === 'solve') || null;
  const reviewing = TEST_NUMS.filter((n) => steps[n] === 'review');
  const checks = TEST_NUMS.filter((n) => steps[n] === 'nextDay' || steps[n] === 'weekAfter')
    .map((n) => ({ n, step: steps[n], from: stepAvailableFrom(n, steps[n]) }));
  const focus = reviewing[0] || nextSolve;
  const stageIdx = focus ? STAGES.findIndex((st) => st.tests.includes(focus)) : STAGES.length;
  const allDone = TEST_NUMS.every((n) => steps[n] === 'done');
  return { steps, nextSolve, reviewing, checks, focus, stageIdx, allDone };
}

const nextVocaDay = () => {
  for (let d = 1; d <= VOCA_DAYS; d++) if (!state.voca[d]) return d;
  return null;
};
const vocaDoneCount = () => Object.keys(state.voca).filter((d) => state.voca[d]).length;

// 현재 단계의 보카 권장 범위와 비교
function vocaPace(stageIdx) {
  const st = STAGES[stageIdx];
  const next = nextVocaDay();
  if (!st || !st.voca) return { text: st ? st.vocaNote : '보카 전체 복습', tone: '' };
  const [a, b] = st.voca;
  if (next === null || next > b) return { text: `권장 DAY ${a}~${b} · 앞서가고 있어요`, tone: 'good' };
  if (next < a) return { text: `권장 DAY ${a}~${b} · DAY ${next}부터 따라잡기`, tone: 'warn' };
  return { text: `권장 DAY ${a}~${b}`, tone: '' };
}

const dueWords = () => state.words
  .filter((w) => !w.mastered && w.due <= today())
  .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : (a.seenAt || 0) - (b.seenAt || 0)));

const dueMistakes = () => state.mistakes
  .filter((m) => !m.done && m.due <= today())
  .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : (a.seenAt || 0) - (b.seenAt || 0)));

const needsMemo = (w) => (w.lapses || 0) >= 2 && !w.etym && !w.assoc;

function causeCounts(list) {
  const c = Object.fromEntries(CAUSES.map((k) => [k, 0]));
  list.forEach((m) => { if (m.cause && c[m.cause] !== undefined) c[m.cause]++; });
  return c;
}

function backlogWarning() {
  const w = dueWords().length;
  const m = dueMistakes().length;
  const overdueW = state.words.filter((x) => !x.mastered && x.due < today()).length;
  const overdueM = state.mistakes.filter((x) => !x.done && x.due < today()).length;
  if (overdueW >= 40 || overdueM >= 15 || w >= 120) {
    return `복습이 밀렸어요 (밀린 단어 ${overdueW}개 · 오답 ${overdueM}개). 계획대로 <b>신규 단어·새 문제 양을 줄이고</b> 복습부터 끝내세요.`;
  }
  return '';
}

/* ---------- 렌더 ---------- */
const $main = document.getElementById('main');

function render() {
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const pr = progress();
  const vd = nextVocaDay();
  document.getElementById('weekBadge').textContent =
    pr.allDone ? '기출 완료' : `TEST ${pr.focus} · ${vd ? `DAY ${vd}` : '보카 완료'}`;
  $main.innerHTML = VIEWS[ui.tab]();
  if (ui.tab === 'words' && ui.wordSub === 'list') renderWordList();
  if (ui.tab === 'more' && ui.moreSub === 'timer') updateTimerDisplay();
}

function seg(name, current, items) {
  return `<div class="seg">${items.map(([k, label]) =>
    `<button data-action="sub" data-sub="${name}" data-val="${k}" class="${current === k ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}

/* ===== 홈 ===== */
function viewHome() {
  const t = today();
  const dow = new Date().getDay();
  const pr = progress();
  const dw = dueWords().length;
  const dm = dueMistakes().length;
  const newToday = (state.log[t] && state.log[t].newWords) || 0;
  const goal = state.settings.newWordGoal;
  const warn = backlogWarning();
  const checks = state.checklist[t] || [];
  const vd = nextVocaDay();
  const st = STAGES[pr.stageIdx];
  const pace = vocaPace(pr.stageIdx);

  let html = warn ? `<div class="alert">${warn}</div>` : '';

  // 지금 진도
  html += `<section class="card">
    <h2>지금 진도</h2>
    <div class="test-dots">${TEST_NUMS.map((n) => {
      const sp = pr.steps[n];
      return `<button class="dot ${sp}${n === pr.focus ? ' focus' : ''}" data-action="openTestFromHome" data-n="${n}" title="TEST ${n}: ${TEST_STEPS[sp].label}">${n}</button>`;
    }).join('')}</div>
    <p class="small muted legend"><span class="dot-l solve"></span>미시작 <span class="dot-l review"></span>오답 정리 <span class="dot-l nextDay"></span>재확인 <span class="dot-l done"></span>완료</p>
    ${st ? `<dl class="kv">
      <dt>단계 ${pr.stageIdx + 1}/${STAGES.length}</dt><dd>${st.tests.map((n) => `TEST ${n}`).join('·')} — ${esc(st.goal)}</dd>
      <dt>보카</dt><dd>${vd ? `다음 <b>DAY ${vd}</b>` : '30 DAY 완료'} <span class="small ${pace.tone === 'warn' ? 'warn-text' : 'muted'}">(${esc(pace.text)})</span></dd>
    </dl>` : '<p class="muted">TEST 1~10을 모두 마쳤어요. 헷갈린 단어·반복 오답을 정리하세요.</p>'}
  </section>`;

  // 다음 할 일 (진도에 따라)
  const tasks = [];
  if (dw) tasks.push({ title: `단어 복습 ${dw}개`, desc: '뜻을 가리고 떠올리기', btn: ['go', '복습하기', 'data-tab="words" data-sub="review"'] });
  if (dm) tasks.push({ title: `오답 재확인 ${dm}개`, desc: '정답 근거를 설명할 수 있는지', btn: ['go', '재확인하기', 'data-tab="mistakes" data-sub="review"'] });
  pr.checks.filter((c) => c.from <= t).forEach((c) => tasks.push({
    title: `TEST ${c.n} ${TEST_STEPS[c.step].label}`, desc: TEST_STEPS[c.step].desc,
    btn: ['testStep', '했어요', `data-n="${c.n}" data-step="${c.step}"`],
  }));
  pr.reviewing.forEach((n) => tasks.push({
    title: `TEST ${n} 오답 정리`, desc: TEST_STEPS.review.desc,
    btn: ['testStep', '정리 끝', `data-n="${n}" data-step="review"`],
    btn2: ['go', '오답 기록', 'data-tab="mistakes" data-sub="add"'],
  }));
  if (pr.nextSolve) {
    const blocked = pr.reviewing.length ? `TEST ${pr.reviewing.join('·')} 오답 정리를 먼저 끝내세요.` : warn ? '복습이 밀려 있어요. 새 회차는 복습을 끝낸 뒤에.' : '';
    tasks.push({
      title: `TEST ${pr.nextSolve} 실전 풀이`,
      desc: TEST_STEPS.solve.desc + (pr.nextSolve >= 9 ? ' · 마지막 점검용 회차예요.' : ''),
      blocked,
      btn: ['testStep', '풀이 끝', `data-n="${pr.nextSolve}" data-step="solve"`],
      btn2: ['go', '타이머', 'data-tab="more" data-sub="timer"'],
    });
  }
  if (vd) {
    tasks.push({
      title: `보카 DAY ${vd}`, desc: warn ? '복습이 밀린 날은 새 단어를 줄이세요.' : `새 단어 ${goal}개 내외 · 오늘 ${newToday}개 추가`,
      btn: ['vocaDone', 'DAY 끝', `data-day="${vd}"`],
      btn2: ['go', '단어 추가', 'data-tab="words" data-sub="add"'],
    });
  }
  const later = pr.checks.filter((c) => c.from > t);

  html += `<section class="card">
    <h2>다음 할 일 <span class="muted small">${t} (${DOW[dow]})</span></h2>
    <ol class="tasks">${tasks.map((k) => `<li class="${k.blocked ? 'blocked' : ''}">
      <div class="grow"><b>${esc(k.title)}</b><div class="small muted">${esc(k.desc)}</div>${k.blocked ? `<div class="small warn-text">${esc(k.blocked)}</div>` : ''}</div>
      <div class="task-btns">
        ${k.btn2 ? `<button class="btn small-btn" data-action="${k.btn2[0]}" ${k.btn2[2]}>${k.btn2[1]}</button>` : ''}
        <button class="btn small-btn primary" data-action="${k.btn[0]}" ${k.btn[2]}>${k.btn[1]}</button>
      </div>
    </li>`).join('')}</ol>
    ${later.length ? `<p class="small muted">예정: ${later.map((c) => `TEST ${c.n} ${TEST_STEPS[c.step].label} (${c.from}부터)`).join(' · ')}</p>` : ''}
  </section>`;

  html += viewTimePlan(pr, dw, dm, vd, warn);

  html += `<section class="card">
    <h2>매일 체크리스트</h2>
    <ul class="checks">${DAILY_CHECKLIST.map((c, i) => `<li><label><input type="checkbox" data-action="check" data-i="${i}" ${checks[i] ? 'checked' : ''}> ${esc(c)}</label></li>`).join('')}</ul>
  </section>`;

  if (dow === 0) {
    html += `<section class="card accent"><h2>주간 점검</h2><p class="muted">이번 주 반복된 실수와 다음 주 조정을 기록하세요.</p>
      <button class="btn primary" data-action="go" data-tab="more" data-sub="weekly">주간 점검 쓰기</button></section>`;
  }
  return html;
}

// 오늘 쓸 수 있는 시간에 맞춰, 진도에서 할 일을 채운 시간표
function viewTimePlan(pr, dw, dm, vd, warn) {
  const min = state.settings.studyMinutes;
  const plan = TIME_PLANS.find((p) => p.min === min) || TIME_PLANS[1];
  const due = dueMistakes();
  const lcDue = due.filter((m) => m.part <= 4).length;
  const rcDue = due.length - lcDue;
  const rv = pr.reviewing[0];
  const t = today();
  const checksNow = pr.checks.filter((c) => c.from <= t);
  const canSolve = pr.nextSolve && !pr.reviewing.length && !warn;
  const nothingSolved = TEST_NUMS.every((n) => pr.steps[n] === 'solve');

  const fill = {
    word: [dw ? `복습 ${dw}개 먼저` : '', vd && !warn ? `보카 DAY ${vd} 새 단어` : warn ? '새 단어는 줄이기' : '헷갈린 단어 재학습'].filter(Boolean).join(' → '),
    lc: rv ? `TEST ${rv} LC 오답 6단계 복습` : lcDue ? `LC 오답 재확인 ${lcDue}개` : nothingSolved ? 'TEST 1 진단은 LC 45분을 끊지 않고 풀 수 있는 날에' : '푼 회차의 LC 취약 Part 다시 듣기·따라 말하기',
    rc: rv ? `TEST ${rv} RC 오답: 근거 문장·바꿔 표현 정리` : rcDue ? `RC 오답 재확인 ${rcDue}개` : nothingSolved ? 'TEST 1 진단은 RC 75분을 끊지 않고 풀 수 있는 날에' : '푼 회차의 Part 5·6 오답 개념, Part 7 근거 찾기',
    recheck: checksNow.length ? checksNow.map((c) => `TEST ${c.n} ${TEST_STEPS[c.step].label}`).join(', ') : '누적 오답 목록 훑기',
  };
  const names = { word: '단어', lc: 'LC', rc: 'RC', recheck: '재확인' };
  // LC 45분 + RC 75분 = 2시간이 들어가는 날에만 실전 회차를 넣음
  const solveDay = min >= 150 && canSolve;
  const rows = solveDay
    ? [[`실전 2시간`, `TEST ${pr.nextSolve} LC·RC 실전 풀이 (타이머 사용)`],
      min >= 240 ? ['핵심 복습 2시간', `TEST ${pr.nextSolve} 채점 → 오답 다시 판단 → 원인 기록`] : ['단어 30분', fill.word]]
    : Object.entries(plan.blocks).map(([k, m]) => [`${names[k]} ${m}분`, fill[k]]);

  return `<section class="card">
    <h2>오늘 시간 배분</h2>
    <div class="chips">${TIME_PLANS.map((p) => `<button class="chip ${p.min === plan.min ? 'on' : 'ghost'}" data-action="studyMin" data-min="${p.min}">${p.label}</button>`).join('')}</div>
    ${plan.note ? `<p class="small muted">${esc(plan.note)}</p>` : ''}
    <table class="score-table compact plan-table"><tbody>${rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table>
    ${min >= 150 && pr.nextSolve && !canSolve ? '<p class="small muted">밀린 복습을 끝내면 이 시간에 다음 회차 실전을 넣어 드려요.</p>' : ''}
    <p class="small muted">진도가 밀려도 괜찮아요. 날짜가 아니라 끝낸 만큼 다음 단계로 넘어가요.</p>
  </section>`;
}

/* ===== 단어 ===== */
function viewWords() {
  const due = dueWords();
  let html = seg('word', ui.wordSub, [['review', `복습 ${due.length}`], ['add', '추가'], ['list', `목록 ${state.words.length}`]]);
  if (ui.wordSub === 'review') html += viewWordReview(due);
  if (ui.wordSub === 'add') html += viewWordForm();
  if (ui.wordSub === 'list') html += viewWordListShell();
  return html;
}

function viewWordReview(due) {
  if (!due.length) {
    const next = state.words.filter((w) => !w.mastered).sort((a, b) => (a.due < b.due ? -1 : 1))[0];
    return `<section class="card center">
      <h2>오늘 단어 복습 끝!</h2>
      <p class="muted">${next ? `다음 복습: ${next.due}` : '단어를 추가해 보세요.'}</p>
      <button class="btn" data-action="sub" data-sub="word" data-val="add">새 단어 추가</button>
    </section>`;
  }
  const w = due[0];
  const stageLabel = w.stage === 0 ? '당일' : ['', '다음 날', '3일 뒤', '7일 뒤', '14일 뒤'][w.stage];
  return `<section class="card flash">
    <div class="flash-meta"><span class="chip">${esc(stageLabel)} 복습</span>${w.source ? `<span class="chip ghost">${esc(w.source)}</span>` : ''}<span class="muted small">남은 ${due.length}</span></div>
    <div class="flash-word">${esc(w.word)} <button class="icon" data-action="speak" data-text="${esc(w.word)}" title="발음 듣기">🔊</button></div>
    ${w.pron ? `<div class="muted">${esc(w.pron)}</div>` : ''}
    ${ui.revealed ? `
      <div class="flash-back">
        <div class="meaning">${esc(w.meaning)}</div>
        ${w.etym ? `<div class="memo"><span class="tag">실제 어원·형성 단서</span>${esc(w.etym)}</div>` : ''}
        ${w.assoc ? `<div class="memo"><span class="tag alt">개인 연상 장면</span>${esc(w.assoc)}</div>` : ''}
        ${w.colloc ? `<div class="memo"><span class="tag">결합 표현</span>${esc(w.colloc)} <button class="icon" data-action="speak" data-text="${esc(w.colloc)}">🔊</button></div>` : ''}
        ${needsMemo(w) ? `<div class="alert small">잘 안 외워지는 단어예요. 어원·연상 메모를 추가해 보세요. <button class="link" data-action="editWord" data-id="${w.id}">메모 추가</button></div>` : ''}
      </div>
      <div class="row two">
        <button class="btn bad" data-action="wordAnswer" data-id="${w.id}" data-ok="0">몰랐어요</button>
        <button class="btn good" data-action="wordAnswer" data-id="${w.id}" data-ok="1">알았어요</button>
      </div>` : `
      <p class="muted small">뜻을 가리고 먼저 떠올려 보세요.</p>
      <button class="btn primary wide" data-action="reveal">뜻 보기</button>`}
  </section>`;
}

function viewWordForm() {
  const w = ui.editWord ? state.words.find((x) => x.id === ui.editWord) : null;
  const v = (k) => esc(w ? w[k] || '' : '');
  const nv = nextVocaDay();
  const lastSource = (state.words.length ? state.words[state.words.length - 1].source || '' : '') || (nv ? `보카 DAY ${nv}` : '');
  return `${w ? '' : viewOcrCard()}
  <section class="card">
    <h2>${w ? '단어 수정' : '단어 추가'}</h2>
    <form data-form="word" class="form">
      <label>단어<input name="word" required value="${v('word')}" autocomplete="off" autocapitalize="off"></label>
      <label>뜻<input name="meaning" required value="${v('meaning')}"></label>
      <label>발음<input name="pron" value="${v('pron')}" placeholder="선택"></label>
      <label>출처<input name="source" value="${w ? v('source') : esc(lastSource)}" placeholder="예: 보카 DAY 3 / TEST 2 Part 7"></label>
      <label>결합 표현<input name="colloc" value="${v('colloc')}" placeholder="예: reschedule a meeting"></label>
      <details ${w && (w.etym || w.assoc) || needsMemo(w || {}) ? 'open' : ''}>
        <summary>어원·연상 메모 (안 외워지는 5~10개만)</summary>
        <label>실제 어원·단어 형성 단서<input name="etym" value="${v('etym')}" placeholder="예: re- '다시' + schedule '일정을 잡다'"></label>
        <label>개인 연상 장면<input name="assoc" value="${v('assoc')}" placeholder="예: 달력의 회의 표시를 다른 날짜로 이동"></label>
        <p class="small muted">실제 어원과 개인 연상은 구분해서 적고, 모든 단어를 억지로 어근 분해하지 않아요.</p>
      </details>
      <div class="row two">
        ${w ? '<button type="button" class="btn" data-action="cancelEditWord">취소</button>' : ''}
        <button class="btn primary">${w ? '저장' : '추가'}</button>
      </div>
    </form>
  </section>
  ${w ? '' : `<section class="card">
    <h2>여러 개 한 번에 추가</h2>
    <form data-form="bulkWords" class="form">
      <label>출처<input name="source" value="${esc(lastSource)}" placeholder="예: 보카 DAY 3"></label>
      <label>한 줄에 하나씩: <code>단어 | 뜻 | 결합 표현(선택)</code>
        <textarea name="lines" rows="6" placeholder="reschedule | 일정을 변경하다 | reschedule a meeting&#10;itinerary | 여행 일정표"></textarea></label>
      <button class="btn primary">한 번에 추가</button>
    </form>
  </section>`}`;
}

const findWord = (word) => state.words.find((x) => x.word.toLowerCase() === word.trim().toLowerCase());

function viewOcrCard() {
  const o = ui.ocr;
  let body = '';
  if (o.status === 'working') {
    body = `<p class="small" id="ocrStep">${esc(o.step || '사진 준비 중')}</p>
      <div class="progress"><div id="ocrBar" style="width:${Math.round(o.progress * 100)}%"></div></div>`;
  } else if (o.status === 'error') {
    body = `<div class="alert small">${esc(o.error)}</div>`;
  } else if (o.status === 'done') {
    const n = o.items.filter((i) => i.checked).length;
    body = o.items.length ? `
      <p class="small muted">인식 결과를 확인하고 틀린 글자는 고쳐 주세요. 추가하지 않을 줄은 체크를 풀면 돼요.</p>
      <ul class="ocr-list">${o.items.map((it, i) => {
        const exists = findWord(it.word);
        return `<li class="${it.checked ? '' : 'off'}">
          <input type="checkbox" data-action="ocrCheck" data-i="${i}" ${it.checked ? 'checked' : ''} aria-label="선택">
          <div class="grow ocr-fields">
            <input class="ocr-input" data-ocr="word" data-i="${i}" value="${esc(it.word)}" autocapitalize="off" aria-label="단어">
            <input class="ocr-input" data-ocr="meaning" data-i="${i}" value="${esc(it.meaning)}" placeholder="뜻 (나중에 채워도 돼요)" aria-label="뜻">
            ${exists ? `<span class="small warn-text">이미 있는 단어 → ${o.markWrong ? '틀림 처리하고 오늘 다시 복습' : '건너뜀'}</span>` : ''}
          </div>
        </li>`;
      }).join('')}</ul>
      <label class="switch"><input type="checkbox" data-action="ocrMarkWrong" ${o.markWrong ? 'checked' : ''}> 틀린 단어로 표시 (헷갈린 단어 목록에 들어가요)</label>
      <div class="row two">
        <button class="btn" data-action="ocrClear">취소</button>
        <button class="btn primary" data-action="ocrAdd" ${n ? '' : 'disabled'}>선택한 ${n}개 추가</button>
      </div>`
      : `<div class="alert small">${o.source === 'paste' ? '붙여넣은 글에서 영어 단어를 찾지 못했어요. 영어 단어가 들어 있는지 확인해 주세요.' : '사진에서 영어 단어를 찾지 못했어요. 글자가 크고 선명하게, 그림자 없이 정면에서 다시 찍어 보세요. 손글씨라면 위의 붙여넣기 방법을 써 보세요.'}</div>`;
  }
  const idle = o.status === 'idle' || o.status === 'error' || (o.status === 'done' && !o.items.length);
  const canReadClipboard = !!(navigator.clipboard && navigator.clipboard.readText);
  return `<section class="card">
    <h2>📷 사진·손글씨로 추가</h2>
    ${idle ? `
      <h3>✍️ 손글씨는 폰의 글자 인식으로 (무료)</h3>
      <ol class="small steps">
        <li><b>iPhone</b>: 카메라나 사진 앱에서 노트를 비추고 오른쪽 아래 <b>글자 인식 버튼</b>을 누른 뒤 → 전체 선택 → 복사</li>
        <li><b>갤럭시·안드로이드</b>: 카메라·갤러리의 <b>텍스트 추출(T)</b> 또는 <b>Google 렌즈 → 텍스트</b> → 전체 선택 → 복사</li>
        <li>아래 칸에 붙여넣고 <b>목록 만들기</b></li>
      </ol>
      <textarea id="ocrPaste" rows="5" placeholder="reschedule 일정을 변경하다&#10;itinerary - 여행 일정표&#10;be eligible for&#10;~할 자격이 있다">${esc(o.pasteText)}</textarea>
      <div class="row ${canReadClipboard ? 'two' : ''}">
        ${canReadClipboard ? '<button class="btn" data-action="ocrClipboard">📋 붙여넣기</button>' : ''}
        <button class="btn primary" data-action="ocrParsePaste">목록 만들기</button>
      </div>
      <p class="small muted">단어와 뜻을 한 줄에 써도, 뜻을 다음 줄에 써도 돼요. 결과를 확인하고 고친 뒤 추가해요.</p>
      <h3>📷 인쇄된 글자는 사진으로 바로</h3>
      <p class="small muted">단어장·시험지·해설처럼 인쇄된 글자는 사진만 고르면 앱이 직접 읽어요. 사진은 기기 밖으로 보내지 않아요. (손글씨는 잘 못 읽어요)</p>
      <label class="btn wide">사진 찍기 / 고르기<input type="file" accept="image/*" id="ocrFile" hidden></label>
      <label class="switch"><input type="checkbox" data-action="ocrKorean" ${o.withKorean ? 'checked' : ''}> 한국어 뜻도 인식 (조금 느려요)</label>` : ''}
    ${body}
  </section>`;
}

async function runOcr(file) {
  const o = ui.ocr;
  Object.assign(o, { status: 'working', step: '사진 준비 중', progress: 0, error: '', items: [], source: 'photo' });
  render();
  try {
    const text = await recognizeImage(file, o.withKorean, (step, p) => {
      o.step = step;
      o.progress = p || 0;
      const s = document.getElementById('ocrStep');
      const bar = document.getElementById('ocrBar');
      if (s) s.textContent = step;
      if (bar) bar.style.width = `${Math.round(o.progress * 100)}%`;
    });
    o.items = parseOcrText(text, { joinSyllables: true }).map((it) => ({ ...it, checked: true }));
    o.status = 'done';
  } catch (err) {
    console.error(err);
    o.status = 'error';
    o.error = err && err.message ? err.message : '인식에 실패했어요. 다시 시도해 주세요.';
  }
  render();
}

function parsePastedText() {
  const o = ui.ocr;
  const text = o.pasteText.trim();
  if (!text) { toast('먼저 복사한 글을 붙여넣어 주세요.'); return false; }
  o.items = parseOcrText(text).map((it) => ({ ...it, checked: true }));
  o.source = 'paste';
  o.status = 'done';
  o.error = '';
  return true;
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) { toast('복사한 글이 없어요.'); return; }
    ui.ocr.pasteText = text;
    parsePastedText();
    render();
  } catch (err) {
    toast('가져오기가 막혔어요. 칸을 길게 눌러 붙여넣기 해 주세요.');
  }
}

function addOcrWords() {
  const o = ui.ocr;
  const t = today();
  const source = `사진 ${t}`;
  let added = 0, marked = 0;
  o.items.filter((it) => it.checked && it.word.trim()).forEach((it) => {
    const existing = findWord(it.word);
    if (existing) {
      if (!o.markWrong) return;
      existing.lapses = (existing.lapses || 0) + 1;
      existing.stage = 0;
      existing.due = t;
      existing.mastered = false;
      if (!existing.meaning && it.meaning) existing.meaning = it.meaning;
      marked++;
      return;
    }
    addWord({ word: it.word, meaning: it.meaning, source });
    if (o.markWrong) state.words[state.words.length - 1].lapses = 1;
    added++;
  });
  save();
  Object.assign(o, { status: 'idle', items: [], pasteText: '' });
  toast(`새 단어 ${added}개 추가${marked ? ` · 기존 단어 ${marked}개 틀림 처리` : ''}`);
}

function viewWordListShell() {
  const filters = [['all', '전체'], ['today', '오늘 추가'], ['hard', '헷갈린 단어'], ['memo', '메모 필요'], ['mastered', '완료']];
  return `<section class="card">
    <input type="search" id="wordSearch" placeholder="단어·뜻 검색" value="${esc(ui.wordQuery)}">
    <div class="chips">${filters.map(([k, l]) => `<button class="chip ${ui.wordFilter === k ? 'on' : 'ghost'}" data-action="wordFilter" data-val="${k}">${l}</button>`).join('')}</div>
    <div id="wordList"></div>
  </section>`;
}

function renderWordList() {
  const el = document.getElementById('wordList');
  if (!el) return;
  const q = ui.wordQuery.trim().toLowerCase();
  const t = today();
  let list = state.words.slice().reverse();
  if (ui.wordFilter === 'today') list = list.filter((w) => w.created === t);
  if (ui.wordFilter === 'hard') list = list.filter((w) => (w.lapses || 0) > 0);
  if (ui.wordFilter === 'memo') list = list.filter(needsMemo);
  if (ui.wordFilter === 'mastered') list = list.filter((w) => w.mastered);
  if (q) list = list.filter((w) => w.word.toLowerCase().includes(q) || (w.meaning || '').toLowerCase().includes(q));
  el.innerHTML = list.length ? `<ul class="list">${list.slice(0, 300).map((w) => `
    <li>
      <div class="grow">
        <b>${esc(w.word)}</b> <span class="muted">${esc(w.meaning)}</span>
        <div class="small muted">${w.mastered ? '완료' : `다음 복습 ${w.due}`}${w.lapses ? ` · 틀림 ${w.lapses}회` : ''}${w.source ? ` · ${esc(w.source)}` : ''}${needsMemo(w) ? ' · <span class="warn-text">메모 필요</span>' : ''}</div>
      </div>
      <button class="icon" data-action="editWord" data-id="${w.id}" title="수정">✎</button>
      <button class="icon" data-action="delWord" data-id="${w.id}" title="삭제">🗑</button>
    </li>`).join('')}</ul>` : '<p class="muted center">해당하는 단어가 없어요.</p>';
}

/* ===== 오답 ===== */
function viewMistakes() {
  const due = dueMistakes();
  let html = seg('mistake', ui.mistakeSub, [['review', `재확인 ${due.length}`], ['add', '기록'], ['list', `목록 ${state.mistakes.length}`]]);
  if (ui.mistakeSub === 'review') html += viewMistakeReview(due);
  if (ui.mistakeSub === 'add') html += viewMistakeForm();
  if (ui.mistakeSub === 'list') html += viewMistakeList();
  return html;
}

function mistakeTitle(m) {
  return `TEST ${m.test} · Part ${m.part}${m.qno ? ` · ${esc(m.qno)}번` : ''}`;
}

function viewMistakeReview(due) {
  if (!due.length) {
    return `<section class="card center"><h2>오늘 재확인할 오답이 없어요</h2>
      <p class="muted">틀리거나 찍은 문제를 기록하면 다음 날, 일주일 뒤에 다시 보여드려요.</p>
      <button class="btn" data-action="sub" data-sub="mistake" data-val="add">오답 기록</button></section>`;
  }
  const m = due[0];
  const isLC = m.part <= 4;
  const stageLabel = m.stage === 0 ? '다음 날 재확인' : '일주일 뒤 반복 실수 점검';
  return `<section class="card flash">
    <div class="flash-meta"><span class="chip">${stageLabel}</span><span class="chip ghost">${esc(m.kind)}</span><span class="muted small">남은 ${due.length}</span></div>
    <h2>${mistakeTitle(m)}</h2>
    ${m.fails ? `<p class="small warn-text">반복 실수 ${m.fails}회</p>` : ''}
    ${!ui.revealed ? `
      <p class="muted">교재에서 문제를 다시 풀고, <b>정답 근거를 스스로 설명</b>해 보세요. 그 다음 기록을 확인합니다.</p>
      <button class="btn primary wide" data-action="reveal">기록 보기</button>` : `
      <dl class="kv">
        ${m.myAns || m.answer ? `<dt>내 답 → 정답</dt><dd>${esc(m.myAns || '-')} → <b>${esc(m.answer || '-')}</b></dd>` : ''}
        ${m.cause ? `<dt>원인</dt><dd>${esc(m.cause)}</dd>` : ''}
        ${m.p5type ? `<dt>유형</dt><dd>${esc(m.p5type)}</dd>` : ''}
        ${m.p7reasons && m.p7reasons.length ? `<dt>오답 보기 이유</dt><dd>${m.p7reasons.map(esc).join(', ')}</dd>` : ''}
        ${m.note ? `<dt>무엇이 문제였나</dt><dd>${esc(m.note)}</dd>` : ''}
        ${m.rule ? `<dt>판단 기준</dt><dd>${esc(m.rule)}</dd>` : ''}
        ${m.evidence ? `<dt>정답 근거</dt><dd>${esc(m.evidence)}</dd>` : ''}
        ${m.paraphrase ? `<dt>바꿔 표현</dt><dd>${esc(m.paraphrase)}</dd>` : ''}
        ${m.sentence ? `<dt>막힌 문장·표현</dt><dd>${esc(m.sentence)} <button class="icon" data-action="speak" data-text="${esc(m.sentence)}">🔊</button></dd>` : ''}
      </dl>
      ${isLC ? `<details open><summary>LC 복습 순서</summary><ol class="checks">${LC_STEPS.map((s, i) =>
        `<li><label><input type="checkbox" data-action="lcStep" data-i="${i}" ${ui.lcSteps[i] ? 'checked' : ''}> ${esc(s)}</label></li>`).join('')}</ol></details>` : ''}
      <div class="row two">
        <button class="btn bad" data-action="mistakeAnswer" data-id="${m.id}" data-ok="0">아직 설명 못 해요</button>
        <button class="btn good" data-action="mistakeAnswer" data-id="${m.id}" data-ok="1">근거를 설명할 수 있어요</button>
      </div>
      <button class="link small" data-action="editMistake" data-id="${m.id}">기록 수정</button>`}
  </section>`;
}

function viewMistakeForm() {
  const m = ui.editMistake ? state.mistakes.find((x) => x.id === ui.editMistake) : null;
  const part = ui.draftPart;
  const v = (k) => esc(m ? m[k] || '' : '');
  const lastTest = m ? m.test : state.mistakes.length ? state.mistakes[state.mistakes.length - 1].test : 1;
  const opt = (arr, cur) => arr.map((x) => `<option ${String(x) === String(cur) ? 'selected' : ''}>${x}</option>`).join('');
  return `<section class="card">
    <h2>${m ? '오답 수정' : '오답·찍은 문제 기록'}</h2>
    <form data-form="mistake" class="form">
      <div class="row three">
        <label>회차<select name="test">${opt([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], lastTest)}</select></label>
        <label>Part<select name="part" data-action="draftPart">${opt([1, 2, 3, 4, 5, 6, 7], part)}</select></label>
        <label>문항<input name="qno" inputmode="numeric" value="${v('qno')}"></label>
      </div>
      <div class="radio-row">${MISTAKE_KINDS.map((k) => `<label class="pill"><input type="radio" name="kind" value="${k}" ${(m ? m.kind : '오답') === k ? 'checked' : ''}><span>${k}</span></label>`).join('')}</div>
      <div class="row two">
        <label>내 답<input name="myAns" value="${v('myAns')}" maxlength="3"></label>
        <label>정답<input name="answer" value="${v('answer')}" maxlength="3"></label>
      </div>
      <p class="hint">${esc(PART_HINTS[part])}</p>
      <fieldset><legend>오답 원인</legend>
        <div class="radio-row">${CAUSES.map((c) => `<label class="pill"><input type="radio" name="cause" value="${c}" ${m && m.cause === c ? 'checked' : ''}><span>${c}</span></label>`).join('')}</div>
      </fieldset>
      ${part === 5 ? `<fieldset><legend>Part 5 유형</legend><div class="radio-row">${P5_TYPES.map((c) => `<label class="pill"><input type="radio" name="p5type" value="${c}" ${m && m.p5type === c ? 'checked' : ''}><span>${c}</span></label>`).join('')}</div></fieldset>` : ''}
      ${part === 7 ? `<fieldset><legend>내가 고른 보기가 틀린 이유</legend><div class="radio-row">${P7_REASONS.map((c) => `<label class="pill"><input type="checkbox" name="p7reasons" value="${c}" ${m && (m.p7reasons || []).includes(c) ? 'checked' : ''}><span>${c}</span></label>`).join('')}</div></fieldset>` : ''}
      <label>무엇이 문제였나<textarea name="note" rows="2" placeholder="예: 명사 앞 빈칸에 부사를 선택함">${v('note')}</textarea></label>
      <label>판단 기준 (다음엔 이렇게)<textarea name="rule" rows="2" placeholder="예: 빈칸의 문장 내 역할부터 확인">${v('rule')}</textarea></label>
      ${part >= 3 ? `<label>정답 근거 문장<textarea name="evidence" rows="2">${v('evidence')}</textarea></label>` : ''}
      ${part >= 3 ? `<label>바꿔 표현 (지문 → 보기)<input name="paraphrase" value="${v('paraphrase')}" placeholder="예: postpone → put off"></label>` : ''}
      <label>막힌 문장·표현<textarea name="sentence" rows="2" placeholder="${part <= 4 ? '안 들린 문장 (받아쓰기)' : '막힌 문장·표현'}">${v('sentence')}</textarea></label>
      <div class="row two">
        ${m ? '<button type="button" class="btn" data-action="cancelEditMistake">취소</button>' : ''}
        <button class="btn primary">${m ? '저장' : '기록'}</button>
      </div>
      ${m ? '' : '<p class="small muted">쉽게 맞히고 근거도 명확한 문제는 기록하지 않아도 돼요. 찍어서 맞힌 문제는 꼭 기록하세요.</p>'}
    </form>
  </section>`;
}

function viewMistakeList() {
  const f = ui.mFilter;
  let list = state.mistakes.slice().reverse();
  if (f.test) list = list.filter((m) => String(m.test) === f.test);
  if (f.part) list = list.filter((m) => String(m.part) === f.part);
  if (f.cause) list = list.filter((m) => m.cause === f.cause);
  const sel = (name, arr, cur, label) => `<select data-action="mFilter" data-key="${name}"><option value="">${label}</option>${arr.map((x) => `<option ${String(x) === cur ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
  const counts = causeCounts(list);
  return `<section class="card">
    <div class="row three">
      ${sel('test', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], f.test, '전체 회차')}
      ${sel('part', [1, 2, 3, 4, 5, 6, 7], f.part, '전체 Part')}
      ${sel('cause', CAUSES, f.cause, '전체 원인')}
    </div>
    <div class="chips">${CAUSES.map((c) => `<span class="chip ghost">${c} ${counts[c]}</span>`).join('')}</div>
    ${list.length ? `<ul class="list">${list.map((m) => `
      <li>
        <div class="grow">
          <b>${mistakeTitle(m)}</b> <span class="chip ghost small">${esc(m.kind)}</span>
          <div class="small">${esc(m.cause || '원인 미분류')}${m.note ? ` · ${esc(m.note)}` : ''}</div>
          <div class="small muted">${m.done ? '복습 완료' : `재확인 ${m.due}`}${m.fails ? ` · 반복 실수 ${m.fails}회` : ''}</div>
        </div>
        <button class="icon" data-action="editMistake" data-id="${m.id}" title="수정">✎</button>
        <button class="icon" data-action="delMistake" data-id="${m.id}" title="삭제">🗑</button>
      </li>`).join('')}</ul>` : '<p class="muted center">기록이 없어요.</p>'}
  </section>`;
}

/* ===== 진도 ===== */
function viewTests() {
  const pr = progress();
  const vd = nextVocaDay();
  let html = `<section class="card">
    <h2>기출 TEST 1~10</h2>
    <p class="small muted">회차를 누르면 기록·다음 단계를 볼 수 있어요. 정답 수를 실제 점수로 단정하지 않고, 재풀이 점수와 새 문제 실력은 구분해요.</p>
    <table class="score-table">
      <thead><tr><th>회차</th><th>다음 단계</th><th>LC</th><th>RC</th><th>미완료</th></tr></thead>
      <tbody>${TEST_NUMS.map((n) => {
        const t = state.tests[n];
        const sp = pr.steps[n];
        return `<tr data-action="openTest" data-n="${n}" class="${ui.openTest === n ? 'sel' : ''}">
          <td>TEST ${n}</td><td><span class="status st-${sp}">${TEST_STEPS[sp].label}</span></td>
          <td>${t.lc ?? '-'}</td><td>${t.rc ?? '-'}</td><td>${t.rcUnfinished ?? '-'}</td></tr>`;
      }).join('')}</tbody>
    </table>
  </section>`;
  if (ui.openTest) html += viewTestDetail(ui.openTest, pr);
  html += `<section class="card">
    <h2>해커스 보카 <span class="muted small">${vocaDoneCount()}/${VOCA_DAYS} DAY</span></h2>
    <p class="small muted">끝낸 DAY를 누르세요. 다시 누르면 취소돼요. ${vd ? `다음은 DAY ${vd}.` : ''}</p>
    <div class="voca-grid">${Array.from({ length: VOCA_DAYS }, (_, i) => i + 1).map((d) =>
      `<button class="voca ${state.voca[d] ? 'on' : ''}${d === vd ? ' next' : ''}" data-action="vocaToggle" data-day="${d}">${d}</button>`).join('')}</div>
  </section>
  <section class="card">
    <h2>진도 단계</h2>
    <p class="small muted">날짜가 아니라 TEST 진도로 단계가 넘어가요. 단계마다 보카는 권장 범위만큼 같이 가면 좋아요.</p>
    <ol class="stages">${STAGES.map((st, i) => {
      const state_ = i < pr.stageIdx ? 'done' : i === pr.stageIdx ? 'now' : '';
      return `<li class="${state_}"><b>${st.tests.map((n) => `TEST ${n}`).join('·')}</b> ${state_ === 'now' ? '<span class="chip">지금</span>' : state_ === 'done' ? '<span class="chip ghost">완료</span>' : ''}
        <div class="small">${esc(st.goal)}</div>
        <div class="small muted">보카: ${st.voca ? `DAY ${st.voca[0]}~${st.voca[1]}` : esc(st.vocaNote)}</div></li>`;
    }).join('')}</ol>
  </section>`;
  return html;
}

function viewTestDetail(n, pr) {
  const t = state.tests[n];
  const ms = state.mistakes.filter((m) => m.test === n);
  const counts = causeCounts(ms);
  const top = Object.entries(counts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const num = (k, max) => `<input type="number" name="${k}" min="0" ${max ? `max="${max}"` : ''} inputmode="numeric" value="${t[k] ?? ''}">`;
  const guessed = ms.filter((m) => m.kind === '찍어서 맞힘').length;
  return `<section class="card" id="testDetail">
    <h2>TEST ${n}</h2>
    ${(n >= 9 && TEST_NUMS.some((k) => k < 9 && pr.steps[k] === 'solve')) ? '<div class="alert">TEST 9·10은 마지막 점검용이에요. TEST 1~8을 먼저 풀고, 미리 보지 마세요.</div>' : ''}
    ${(() => {
      const sp = pr.steps[n];
      if (sp === 'done') return '<p class="small muted">이 회차는 학습 순서를 모두 마쳤어요.</p>';
      const from = stepAvailableFrom(n, sp);
      return `<div class="next-step"><div class="grow"><b>다음 단계: ${TEST_STEPS[sp].label}</b><div class="small muted">${esc(TEST_STEPS[sp].desc)}${from > today() ? ` · ${from}부터` : ''}</div></div>
        <button class="btn small-btn primary" data-action="testStep" data-n="${n}" data-step="${sp}">${sp === 'solve' ? '풀이 끝' : sp === 'review' ? '정리 끝' : '했어요'}</button></div>`;
    })()}
    <form data-form="test" data-n="${n}" class="form">
      <div class="row two">
        <label>풀이 날짜<input type="date" name="date" value="${esc(t.date || '')}"></label>
        <label>상태<select name="status">${TEST_STATUSES.map((s) => `<option ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      </div>
      <div class="row three">
        <label>LC 정답 /100${num('lc', 100)}</label>
        <label>RC 정답 /100${num('rc', 100)}</label>
        <label>RC 미완료${num('rcUnfinished', 100)}</label>
      </div>
      <fieldset><legend>소요 시간 (분)</legend>
        <div class="row four">
          <label>LC${num('tLC')}</label><label>P5${num('tP5')}</label><label>P6${num('tP6')}</label><label>P7${num('tP7')}</label>
        </div>
        <p class="small muted">연습 기준: LC 약 45분 · P5 12분 · P6 8분 · P7 55분 (마킹 포함)</p>
      </fieldset>
      <label class="switch"><input type="checkbox" name="nextDay" ${t.nextDay ? 'checked' : ''}> 다음 날 재확인 완료</label>
      <label class="switch"><input type="checkbox" name="weekAfter" ${t.weekAfter ? 'checked' : ''}> 일주일 뒤 재확인 완료</label>
      <label>주요 오답 원인<textarea name="causes" rows="2" placeholder="${top.length ? esc(top.map(([c, k]) => `${c} ${k}`).join(', ')) : ''}">${esc(t.causes || '')}</textarea></label>
      <label>다음 학습에서 바꿀 행동<textarea name="action" rows="2">${esc(t.action || '')}</textarea></label>
      <button class="btn primary">저장</button>
    </form>
  </section>
  <section class="card">
    <h2>TEST ${n} 오답 분석 <span class="muted small">기록 ${ms.length}개 · 찍어서 맞힘 ${guessed}개</span></h2>
    ${ms.length ? `
      <table class="score-table compact"><tbody>${CAUSES.map((c) => `<tr><td>${c}</td><td>${counts[c]}</td></tr>`).join('')}</tbody></table>
      ${top.length ? `<h3>진단에 따른 조정</h3><ul class="bullets">${top.slice(0, 2).map(([c]) => `<li><b>${c}</b>: ${esc(CAUSE_ADVICE[c])}</li>`).join('')}</ul>` : ''}
      <button class="btn" data-action="mistakesOf" data-n="${n}">이 회차 오답 보기</button>`
      : `<p class="muted">오답 탭에서 이 회차의 틀린·찍은 문제를 기록하면 원인별로 분석해 드려요.</p>`}
  </section>`;
}

/* ===== 더보기 ===== */
function viewMore() {
  let html = seg('more', ui.moreSub, [['timer', '타이머'], ['weekly', '주간 점검'], ['settings', '설정·백업']]);
  if (ui.moreSub === 'timer') html += viewTimer();
  if (ui.moreSub === 'weekly') html += viewWeekly();
  if (ui.moreSub === 'settings') html += viewSettings();
  return html;
}

function viewTimer() {
  const p = TIMER_PRESETS.find((x) => x.key === timer.presetKey);
  const fieldMap = { lc: 'tLC', p5: 'tP5', p6: 'tP6', p7: 'tP7' };
  return `<section class="card center">
    <div class="chips">${TIMER_PRESETS.map((x) => `<button class="chip ${x.key === timer.presetKey ? 'on' : 'ghost'}" data-action="preset" data-key="${x.key}">${x.label} ${x.min}분</button>`).join('')}</div>
    <div id="timerDisplay" class="timer">--:--</div>
    <div id="timerElapsed" class="muted small"></div>
    <div class="row three">
      <button class="btn" data-action="timerReset">초기화</button>
      <button class="btn primary" data-action="timerToggle" id="timerToggle">${timer.running ? '일시정지' : '시작'}</button>
      ${fieldMap[p.key] ? `<button class="btn" data-action="timerSave">기록에 저장</button>` : '<span></span>'}
    </div>
    <p class="small muted">실전처럼: 중간 정지·사전 검색·중간 채점 없이. 시간이 끝나도 계속 흐르며 초과 시간을 보여줘요.</p>
  </section>`;
}

function viewWeekly() {
  const ws = weekStart(today());
  const w = state.weekly[ws] || {};
  const we = addDays(ws, 6);
  const inWeek = (d) => d >= ws && d <= we;
  const weekMistakes = state.mistakes.filter((m) => inWeek(m.created));
  const counts = causeCounts(weekMistakes);
  let wordsReviewed = 0, mistakesReviewed = 0, newWords = 0, checkDays = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const l = state.log[d];
    if (l) { wordsReviewed += l.words || 0; mistakesReviewed += l.mistakes || 0; newWords += l.newWords || 0; }
    const c = state.checklist[d];
    if (c && c.filter(Boolean).length === DAILY_CHECKLIST.length) checkDays++;
  }
  const repeated = state.mistakes.filter((m) => (m.fails || 0) > 0 && m.lastSeen && inWeek(m.lastSeen));
  const past = Object.keys(state.weekly).filter((k) => k !== ws).sort().reverse();
  return `<section class="card">
    <h2>이번 주 요약 <span class="muted small">${ws} ~ ${we}</span></h2>
    <div class="stats">
      <div class="stat"><b>${newWords}</b><span>새 단어</span></div>
      <div class="stat"><b>${wordsReviewed}</b><span>단어 복습</span></div>
      <div class="stat"><b>${weekMistakes.length}</b><span>새 오답</span></div>
      <div class="stat"><b>${mistakesReviewed}</b><span>오답 재확인</span></div>
      <div class="stat"><b>${checkDays}/7</b><span>체크리스트 완료</span></div>
    </div>
    <div class="chips">${CAUSES.map((c) => `<span class="chip ghost">${c} ${counts[c]}</span>`).join('')}</div>
    ${repeated.length ? `<p class="small warn-text">이번 주 다시 틀린 문제 ${repeated.length}개: ${repeated.slice(0, 5).map(mistakeTitle).join(', ')}</p>` : ''}
  </section>
  <section class="card">
    <h2>주간 점검</h2>
    <form data-form="weekly" data-week="${ws}" class="form">
      ${WEEKLY_FIELDS.map(([k, l]) => `<label>${l}<textarea name="${k}" rows="${k === 'repeated' ? 3 : 2}">${esc(w[k] || '')}</textarea></label>`).join('')}
      <button class="btn primary">저장</button>
    </form>
    <details><summary>조정 기준</summary><ul class="bullets small">
      <li>복습이 밀림 → 새 문제량 감소</li>
      <li>문법 해설부터 이해 안 됨 → 해당 개념만 기본서·강의로 보충</li>
      <li>시간 없이 풀면 맞음 → 시간 제한 독해 확대</li>
      <li>대본을 보면 쉬움 → 소리 인식·재청취 확대</li>
      <li>학교 시험과 충돌 → 학업 우선, 진도 이월</li>
    </ul></details>
  </section>
  ${past.length ? `<section class="card"><h2>지난 점검</h2>${past.map((k) => `<details><summary>${k} 주</summary><dl class="kv">${WEEKLY_FIELDS.map(([f, l]) => state.weekly[k][f] ? `<dt>${l}</dt><dd>${esc(state.weekly[k][f])}</dd>` : '').join('')}</dl></details>`).join('')}</section>` : ''}`;
}

function viewSettings() {
  const s = state.settings;
  return `<section class="card">
    <h2>설정</h2>
    <form data-form="settings" class="form">
      <label>하루 새 단어 목표<input type="number" name="newWordGoal" min="0" max="200" value="${s.newWordGoal}"></label>
      <p class="small muted">학교 시험 주간에는 오늘 탭의 시간 배분을 45분으로 고르세요.</p>
      <button class="btn primary">저장</button>
    </form>
  </section>
  <section class="card">
    <h2>백업</h2>
    <p class="small muted">데이터는 이 기기의 브라우저에만 저장돼요. 기기를 바꾸거나 브라우저 데이터를 지우기 전에 꼭 내보내세요.</p>
    <div class="row two">
      <button class="btn" data-action="export">내보내기 (JSON)</button>
      <label class="btn">가져오기<input type="file" accept="application/json,.json" id="importFile" hidden></label>
    </div>
    <button class="btn" data-action="exportWordsCsv">단어장 CSV 내보내기</button>
  </section>
  <section class="card">
    <h2>초기화</h2>
    <button class="btn bad" data-action="reset">모든 데이터 삭제</button>
  </section>`;
}

const VIEWS = { home: viewHome, words: viewWords, mistakes: viewMistakes, tests: viewTests, more: viewMore };

/* ---------- 동작 ---------- */
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { el.hidden = true; }, 2200);
}

function speak(text) {
  if (!('speechSynthesis' in window)) { toast('이 브라우저는 발음 듣기를 지원하지 않아요.'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

function addWord(data) {
  const t = today();
  state.words.push({
    id: uid(), word: data.word.trim(), meaning: (data.meaning || '').trim(), pron: data.pron || '',
    source: data.source || '', colloc: data.colloc || '', etym: data.etym || '', assoc: data.assoc || '',
    created: t, stage: 0, due: t, lapses: 0, mastered: false,
  });
  bumpLog('newWords');
}

function answerWord(id, ok) {
  const w = state.words.find((x) => x.id === id);
  if (!w) return;
  const t = today();
  w.seenAt = Date.now();
  bumpLog('words');
  if (ok) {
    w.stage += 1;
    if (w.stage >= WORD_MASTER_STAGE) { w.mastered = true; }
    else { w.due = addDays(t, WORD_GAPS[w.stage - 1]); }
  } else {
    // 당일 안에 다시 보고, 맞히면 다음 날부터 다시 시작
    w.lapses = (w.lapses || 0) + 1;
    w.stage = 0;
    w.due = t;
  }
}

function answerMistake(id, ok) {
  const m = state.mistakes.find((x) => x.id === id);
  if (!m) return;
  const t = today();
  m.seenAt = Date.now();
  m.lastSeen = t;
  bumpLog('mistakes');
  if (ok) {
    m.stage += 1;
    if (m.stage >= MISTAKE_GAPS.length) m.done = true;
    else m.due = addDays(t, MISTAKE_GAPS[m.stage]);
  } else {
    m.fails = (m.fails || 0) + 1;
    m.stage = 0;
    m.due = addDays(t, MISTAKE_GAPS[0]);
  }
  syncTestStatus(m.test);
}

function completeTestStep(n, step) {
  const t = state.tests[n];
  if (step === 'solve') {
    t.status = '풀이 완료';
    t.date = t.date || today();
    ui.tab = 'tests';
    ui.openTest = n;
    toast(`TEST ${n} 풀이 완료 · 점수를 기록하고 오답을 정리하세요`);
  } else if (step === 'review') {
    t.status = '복습 중';
    toast(`TEST ${n} 오답 정리 완료 · 다음 날 재확인해요`);
  } else if (step === 'nextDay') {
    if (t.status !== '복습 완료') t.status = '복습 중';
    t.nextDay = true;
    toast(`TEST ${n} 다음 날 재확인 완료`);
  } else if (step === 'weekAfter') {
    t.nextDay = true;
    t.weekAfter = true;
    t.status = '복습 완료';
    toast(`TEST ${n} 학습 순서 완료`);
  }
  save();
}

// 회차 상태를 오답 복습 진행에 맞춰 자동으로 올려줌 (직접 바꾼 값은 존중)
function syncTestStatus(n) {
  const t = state.tests[n];
  const ms = state.mistakes.filter((m) => m.test === n);
  if (!ms.length) return;
  const allDone = ms.every((m) => m.done);
  if (t.status === '미시작' || t.status === '풀이 완료') t.status = '복습 중';
  if (allDone && t.status === '복습 중') t.status = '복습 완료';
  if (ms.some((m) => m.stage >= 1 || m.done)) t.nextDay = true;
  if (allDone) t.weekAfter = true;
}

function formData(form) {
  const fd = new FormData(form);
  const o = {};
  for (const [k, v] of fd.entries()) {
    if (k in o) o[k] = [].concat(o[k], v); else o[k] = v;
  }
  return o;
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/* 제출 */
document.addEventListener('submit', (e) => {
  const form = e.target;
  const kind = form.dataset.form;
  if (!kind) return;
  e.preventDefault();
  const d = formData(form);

  if (kind === 'word') {
    if (ui.editWord) {
      const w = state.words.find((x) => x.id === ui.editWord);
      Object.assign(w, { word: d.word.trim(), meaning: d.meaning.trim(), pron: d.pron, source: d.source, colloc: d.colloc, etym: d.etym, assoc: d.assoc });
      ui.editWord = null;
      ui.wordSub = ui.returnWordSub || 'list';
      toast('수정했어요.');
    } else {
      if (state.words.some((w) => w.word.toLowerCase() === d.word.trim().toLowerCase())) {
        if (!confirm(`'${d.word}'는 이미 단어장에 있어요. 그래도 추가할까요?`)) return;
      }
      addWord(d);
      toast(`'${d.word}' 추가`);
      save();
      render();
      const input = $main.querySelector('input[name=word]');
      if (input) input.focus();
      return;
    }
  }
  if (kind === 'bulkWords') {
    const lines = (d.lines || '').split('\n').map((l) => l.trim()).filter(Boolean);
    let added = 0;
    lines.forEach((l) => {
      const [word, meaning, colloc] = l.split(/\s*[|\t]\s*/);
      if (!word) return;
      addWord({ word, meaning: meaning || '', colloc: colloc || '', source: d.source });
      added++;
    });
    toast(`${added}개 추가했어요.`);
  }
  if (kind === 'mistake') {
    const part = Number(d.part);
    const rec = {
      test: Number(d.test), part, qno: d.qno || '', kind: d.kind || '오답', myAns: d.myAns || '', answer: d.answer || '',
      cause: d.cause || '', p5type: part === 5 ? d.p5type || '' : '',
      p7reasons: part === 7 ? [].concat(d.p7reasons || []) : [],
      note: d.note || '', rule: d.rule || '', evidence: d.evidence || '', paraphrase: d.paraphrase || '', sentence: d.sentence || '',
    };
    if (ui.editMistake) {
      Object.assign(state.mistakes.find((x) => x.id === ui.editMistake), rec);
      ui.editMistake = null;
      ui.mistakeSub = ui.returnMistakeSub || 'list';
      toast('수정했어요.');
    } else {
      const t = today();
      state.mistakes.push({ id: uid(), ...rec, created: t, stage: 0, due: addDays(t, MISTAKE_GAPS[0]), fails: 0, done: false });
      const test = state.tests[rec.test];
      if (test.status === '미시작') { test.status = '풀이 완료'; test.date = test.date || t; }
      ui.draftPart = part;
      toast('기록했어요. 내일 다시 확인해요.');
      save();
      render();
      const q = $main.querySelector('input[name=qno]');
      if (q) q.focus();
      return;
    }
  }
  if (kind === 'test') {
    const n = Number(form.dataset.n);
    const t = state.tests[n];
    const numOrNull = (v) => (v === '' || v === undefined ? null : Number(v));
    Object.assign(t, {
      date: d.date || '', status: d.status,
      lc: numOrNull(d.lc), rc: numOrNull(d.rc), rcUnfinished: numOrNull(d.rcUnfinished),
      tLC: numOrNull(d.tLC), tP5: numOrNull(d.tP5), tP6: numOrNull(d.tP6), tP7: numOrNull(d.tP7),
      nextDay: !!d.nextDay, weekAfter: !!d.weekAfter, causes: d.causes || '', action: d.action || '',
    });
    toast(`TEST ${n} 저장`);
  }
  if (kind === 'weekly') {
    state.weekly[form.dataset.week] = Object.fromEntries(WEEKLY_FIELDS.map(([k]) => [k, d[k] || '']));
    toast('주간 점검 저장');
  }
  if (kind === 'settings') {
    state.settings.newWordGoal = Number(d.newWordGoal) || 0;
    toast('설정 저장');
  }
  save();
  render();
});

/* 클릭 */
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('#tabbar button');
  if (tabBtn) {
    ui.tab = tabBtn.dataset.tab;
    ui.revealed = false;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  // 체크박스·셀렉트는 change 이벤트에서 처리
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return;

  switch (a) {
    case 'sub': {
      const key = { word: 'wordSub', mistake: 'mistakeSub', more: 'moreSub' }[el.dataset.sub];
      ui[key] = el.dataset.val;
      ui.revealed = false;
      if (key === 'wordSub') ui.editWord = null;
      if (key === 'mistakeSub') ui.editMistake = null;
      break;
    }
    case 'go': {
      ui.tab = el.dataset.tab;
      const key = { words: 'wordSub', mistakes: 'mistakeSub', more: 'moreSub' }[ui.tab];
      if (key && el.dataset.sub) ui[key] = el.dataset.sub;
      ui.revealed = false;
      window.scrollTo(0, 0);
      break;
    }
    case 'reveal': ui.revealed = true; break;
    case 'speak': speak(el.dataset.text); return;
    case 'wordAnswer':
      answerWord(el.dataset.id, el.dataset.ok === '1');
      ui.revealed = false;
      save();
      break;
    case 'mistakeAnswer':
      answerMistake(el.dataset.id, el.dataset.ok === '1');
      ui.revealed = false;
      ui.lcSteps = [];
      save();
      break;
    case 'editWord':
      ui.returnWordSub = ui.wordSub;
      ui.editWord = el.dataset.id;
      ui.wordSub = 'add';
      ui.tab = 'words';
      window.scrollTo(0, 0);
      break;
    case 'cancelEditWord': ui.editWord = null; ui.wordSub = ui.returnWordSub || 'list'; break;
    case 'delWord':
      if (!confirm('이 단어를 삭제할까요?')) return;
      state.words = state.words.filter((w) => w.id !== el.dataset.id);
      save();
      break;
    case 'wordFilter': ui.wordFilter = el.dataset.val; break;
    case 'editMistake':
      ui.returnMistakeSub = ui.mistakeSub;
      ui.editMistake = el.dataset.id;
      ui.draftPart = state.mistakes.find((m) => m.id === el.dataset.id).part;
      ui.mistakeSub = 'add';
      ui.tab = 'mistakes';
      window.scrollTo(0, 0);
      break;
    case 'cancelEditMistake': ui.editMistake = null; ui.mistakeSub = ui.returnMistakeSub || 'list'; break;
    case 'delMistake':
      if (!confirm('이 기록을 삭제할까요?')) return;
      state.mistakes = state.mistakes.filter((m) => m.id !== el.dataset.id);
      save();
      break;
    case 'openTest': {
      const n = Number(el.dataset.n);
      ui.openTest = ui.openTest === n ? null : n;
      render();
      const d = document.getElementById('testDetail');
      if (d) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    case 'mistakesOf':
      ui.tab = 'mistakes';
      ui.mistakeSub = 'list';
      ui.mFilter = { test: el.dataset.n, part: '', cause: '' };
      window.scrollTo(0, 0);
      break;
    case 'preset': {
      const p = TIMER_PRESETS.find((x) => x.key === el.dataset.key);
      timerStop();
      timer.presetKey = p.key;
      timer.total = p.min * 60;
      timer.elapsedBefore = 0;
      break;
    }
    case 'timerToggle': timer.running ? timerStop() : timerStart(); break;
    case 'timerReset': timerStop(); timer.elapsedBefore = 0; break;
    case 'timerSave': {
      const n = prompt('몇 회차 기록에 저장할까요? (1~10)', String(ui.openTest || 1));
      const num = Number(n);
      if (!num || num < 1 || num > 10) return;
      const field = { lc: 'tLC', p5: 'tP5', p6: 'tP6', p7: 'tP7' }[timer.presetKey];
      state.tests[num][field] = Math.round(timerElapsed() / 60);
      save();
      toast(`TEST ${num}에 ${state.tests[num][field]}분 저장`);
      return;
    }
    case 'export':
      download(`toeic-review-${today()}.json`, JSON.stringify(state, null, 2), 'application/json');
      return;
    case 'exportWordsCsv': {
      const head = ['단어', '발음', '뜻', '실제 어원', '개인 연상', '결합 표현', '출처', '복습 단계', '다음 복습', '틀린 횟수'];
      const rows = state.words.map((w) => [w.word, w.pron, w.meaning, w.etym, w.assoc, w.colloc, w.source, w.mastered ? '완료' : w.stage, w.due, w.lapses]);
      download(`toeic-words-${today()}.csv`, '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
      return;
    }
    case 'testStep': completeTestStep(Number(el.dataset.n), el.dataset.step); break;
    case 'openTestFromHome':
      ui.tab = 'tests';
      ui.openTest = Number(el.dataset.n);
      render();
      { const dEl = document.getElementById('testDetail'); if (dEl) dEl.scrollIntoView({ block: 'start' }); }
      return;
    case 'vocaDone':
      state.voca[el.dataset.day] = today();
      save();
      toast(`보카 DAY ${el.dataset.day} 완료`);
      break;
    case 'vocaToggle': {
      const d = el.dataset.day;
      if (state.voca[d]) delete state.voca[d]; else state.voca[d] = today();
      save();
      break;
    }
    case 'studyMin': state.settings.studyMinutes = Number(el.dataset.min); save(); break;
    case 'ocrAdd': addOcrWords(); break;
    case 'ocrParsePaste': if (!parsePastedText()) return; break;
    case 'ocrClipboard': pasteFromClipboard(); return;
    case 'ocrClear': Object.assign(ui.ocr, { status: 'idle', items: [] }); break;
    case 'reset':
      if (!confirm('정말 모든 데이터를 삭제할까요? 되돌릴 수 없어요.')) return;
      state = defaultState();
      save();
      break;
    default: return;
  }
  render();
});

/* 변경 (체크박스·셀렉트·파일) */
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'ocrFile') {
    const file = el.files[0];
    el.value = '';
    if (file) runOcr(file);
    return;
  }
  if (el.dataset.action === 'ocrCheck') { ui.ocr.items[Number(el.dataset.i)].checked = el.checked; render(); return; }
  if (el.dataset.action === 'ocrKorean') { ui.ocr.withKorean = el.checked; return; }
  if (el.dataset.action === 'ocrMarkWrong') { ui.ocr.markWrong = el.checked; render(); return; }
  if (el.id === 'importFile') {
    const file = el.files[0];
    if (!file) return;
    file.text().then((txt) => {
      const data = JSON.parse(txt);
      if (!data || !Array.isArray(data.words) || !Array.isArray(data.mistakes)) throw new Error('형식 오류');
      if (!confirm('현재 데이터를 가져온 파일로 바꿀까요?')) return;
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      state = loadState();
      render();
      toast('가져오기 완료');
    }).catch(() => toast('백업 파일을 읽지 못했어요.'));
    return;
  }
  const a = el.dataset.action;
  if (!a) return;
  if (a === 'check') {
    const t = today();
    state.checklist[t] = state.checklist[t] || [];
    state.checklist[t][Number(el.dataset.i)] = el.checked;
    save();
    return;
  }
  if (a === 'lcStep') { ui.lcSteps[Number(el.dataset.i)] = el.checked; return; }
  if (a === 'mFilter') { ui.mFilter[el.dataset.key] = el.value; render(); return; }
  if (a === 'draftPart') {
    // Part에 따라 입력 칸이 달라지므로 입력값을 유지한 채 다시 그림
    const form = el.closest('form');
    const d = formData(form);
    ui.draftPart = Number(el.value);
    render();
    const nf = $main.querySelector('form[data-form=mistake]');
    for (const [k, v] of Object.entries(d)) {
      if (k === 'part') continue;
      const inputs = nf.querySelectorAll(`[name="${k}"]`);
      inputs.forEach((inp) => {
        if (inp.type === 'radio' || inp.type === 'checkbox') inp.checked = [].concat(v).includes(inp.value);
        else inp.value = v;
      });
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'wordSearch') { ui.wordQuery = e.target.value; renderWordList(); }
  if (e.target.id === 'ocrPaste') ui.ocr.pasteText = e.target.value;
  if (e.target.dataset.ocr) ui.ocr.items[Number(e.target.dataset.i)][e.target.dataset.ocr] = e.target.value;
});

/* ---------- 타이머 ---------- */
function timerElapsed() {
  return timer.elapsedBefore + (timer.running ? (Date.now() - timer.startedAt) / 1000 : 0);
}
function timerStart() {
  timer.running = true;
  timer.startedAt = Date.now();
  timer.handle = setInterval(updateTimerDisplay, 250);
}
function timerStop() {
  if (timer.running) timer.elapsedBefore = timerElapsed();
  timer.running = false;
  clearInterval(timer.handle);
}
function updateTimerDisplay() {
  const el = document.getElementById('timerDisplay');
  if (!el) return;
  const elapsed = timerElapsed();
  const left = timer.total - elapsed;
  const abs = Math.abs(Math.round(left));
  el.textContent = `${left < 0 ? '+' : ''}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  el.classList.toggle('over', left < 0);
  const e2 = document.getElementById('timerElapsed');
  if (e2) e2.textContent = `경과 ${Math.floor(elapsed / 60)}분 ${pad(Math.floor(elapsed % 60))}초`;
  const btn = document.getElementById('timerToggle');
  if (btn) btn.textContent = timer.running ? '일시정지' : elapsed > 0 ? '계속' : '시작';
  if (left < 0 && left > -0.3 && timer.running && navigator.vibrate) navigator.vibrate([300, 150, 300]);
}

/* ---------- 시작 ---------- */
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
