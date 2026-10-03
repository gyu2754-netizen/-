'use strict';
// 사진 속 단어 인식. Tesseract.js(브라우저 안에서 동작하는 OCR)를 필요할 때만 CDN에서 불러옴.
// 사진은 기기 밖으로 전송되지 않고, 인식 엔진·언어 데이터만 처음 한 번 내려받아 브라우저에 저장됨.

const TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
const OCR_MAX_SIDE = 2000;

let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_SRC;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => {
        tesseractLoading = null;
        s.remove();
        reject(new Error('인식 엔진을 불러오지 못했어요. 인터넷 연결을 확인하세요. (처음 한 번은 인터넷이 필요해요)'));
      };
      document.head.appendChild(s);
    });
  }
  return tesseractLoading;
}

// 큰 사진은 줄여서 인식 속도·메모리 부담을 낮춤 (폰 사진은 4000px 이상인 경우가 많음)
function imageToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, OCR_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 열지 못했어요. JPG·PNG 사진으로 다시 시도해 주세요.')); };
    img.src = url;
  });
}

async function recognizeImage(file, withKorean, onProgress) {
  await loadTesseract();
  const canvas = await imageToCanvas(file);
  const langs = withKorean ? ['eng', 'kor'] : ['eng'];
  const worker = await Tesseract.createWorker(langs, 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress('글자 인식 중', m.progress);
      else if (/load|initializ/i.test(m.status)) onProgress('인식 엔진 준비 중 (처음엔 1분 정도 걸려요)', m.progress);
    },
  });
  try {
    const { data } = await worker.recognize(canvas);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

const OCR_STOPWORDS = new Set(('the and for with that this from are was were you your have has had not but all can will would should could its our their they there which what when who whom been into than then also any each more most some such very just only about after before over under out off may must does did done here where how why one two per via upon').split(' '));

const HANGUL = /[가-힣]/;

// 인식된 글을 [{word, meaning}] 후보로 바꿈.
// - "영어 [발음] 한국어 뜻" 줄 → 단어(최대 4단어 표현)와 뜻을 짝지음
// - 영어만 있는 줄 → 단어별로 나눔
// - 한국어로 시작하는 줄 → 바로 앞 단어의 뜻으로 붙임 (뜻이 다음 줄로 넘어간 경우)
function parseOcrText(text) {
  const out = [];
  const seen = new Set();
  const push = (word, meaning) => {
    word = word.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').replace(/\s+/g, ' ');
    if (word.length < 2 || !/[A-Za-z]{2}/.test(word)) return;
    if (/^[A-Z][a-z]+$/.test(word)) word = word.toLowerCase();
    const key = word.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ word, meaning: cleanMeaning(meaning) });
  };
  text.split('\n').forEach((raw) => {
    const line = raw.replace(/\[[^\]]*\]|\/[^/]*\//g, ' ').replace(/[|_~`=<>«»©®“”"]/g, ' ').trim();
    if (!line) return;
    const k = line.search(HANGUL);
    if (k === -1) {
      line.replace(/[^A-Za-z'\- ]/g, ' ').split(/\s+/).forEach((w) => {
        if (w.replace(/[^A-Za-z]/g, '').length >= 3 && !OCR_STOPWORDS.has(w.toLowerCase())) push(w, '');
      });
      return;
    }
    const eng = line.slice(0, k).match(/[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3}/);
    if (eng) push(eng[0], line.slice(k));
    else if (out.length && !out[out.length - 1].meaning) out[out.length - 1].meaning = cleanMeaning(line);
  });
  return out;
}

// 한국어 인식은 "일 정 을 변 경 하다"처럼 글자마다 띄어 읽는 경우가 많아, 한 글자짜리 조각을 이웃과 붙임
function joinHangulSyllables(s) {
  const single = /^[가-힣]$/;
  const hangulEdge = (a, b) => HANGUL.test(a.slice(-1)) && HANGUL.test(b[0]);
  const out = [];
  let prevSingle = false;
  s.split(' ').forEach((tok) => {
    if (!tok) return;
    const isSingle = single.test(tok);
    if (out.length && (prevSingle || isSingle) && hangulEdge(out[out.length - 1], tok)) out[out.length - 1] += tok;
    else out.push(tok);
    prevSingle = isSingle;
  });
  return out.join(' ');
}

function cleanMeaning(s) {
  const t = String(s || '').replace(/[^가-힣A-Za-z0-9\s,;~·()\-.]/g, ' ').replace(/\s+/g, ' ').trim();
  return joinHangulSyllables(t);
}
