const TEXT_URL = "texts/meditations.txt";

const elSentence = document.getElementById("sentence");
const elTypebox = document.getElementById("typebox");
const elCaret = document.getElementById("caret");

const elWpm = document.getElementById("wpm");
const elAcc = document.getElementById("acc");
const elBest = document.getElementById("best");
const elIdx = document.getElementById("idx");
const elTotal = document.getElementById("total");
const elFeedback = document.getElementById("feedback");
const elWeakList = document.getElementById("weakList");
const elFocus = document.getElementById("focus");

let sentences = [];
let sentenceIndex = 0;

let target = "";
let typed = ""; // what the user has typed so far (we control this)
let startedAt = null;

let bestWpm = null;

// per-character timing stats (session only)
const charStats = new Map(); // char -> {count,totalMs}
let lastTypeAt = null;

function isIgnorableKey(e) {
  return (
    e.ctrlKey || e.metaKey || e.altKey ||
    e.key === "Shift" ||
    e.key === "CapsLock" ||
    e.key === "Tab" ||
    e.key === "ArrowLeft" || e.key === "ArrowRight" ||
    e.key === "ArrowUp" || e.key === "ArrowDown"
  );
}

function normalizeCorpus(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIntoSentences(text) {
  const t = normalizeCorpus(text);

  // Rough split on sentence-ending punctuation.
  // This is intentionally conservative and simple.
  const parts = t.split(/(?<=[.!?])\s+/g).map(s => s.trim());

  // Filter out headings & tiny fragments.
  return parts.filter(s => {
    if (s.length < 40) return false;
    if (/^book\s+[ivxlcdm]+$/i.test(s)) return false;
    if (/^provided by/i.test(s)) return false;
    if (/^translated by/i.test(s)) return false;
    if (/^-{5,}/.test(s)) return false;
    return true;
  });
}

function computeAccuracy(targetStr, typedStr) {
  if (!typedStr.length) return 0;

  const n = Math.min(targetStr.length, typedStr.length);
  let correct = 0;

  for (let i = 0; i < n; i++) {
    if (typedStr[i] === targetStr[i]) correct++;
  }

  const total = typedStr.length;
  return Math.max(0, Math.round((correct / total) * 100));
}

function computeWpm(charsTyped, elapsedMs) {
  if (!charsTyped || elapsedMs <= 0) return 0;
  const minutes = elapsedMs / 60000;
  const words = charsTyped / 5;
  return Math.max(0, Math.round(words / minutes));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[c]));
}

function render() {
  // Render as spans per character so we can color each one
  const spans = [];

  for (let i = 0; i < target.length; i++) {
    const expected = target[i];
    const got = typed[i];

    let cls = "ch upcoming";
    if (got !== undefined) {
      if (got === expected) cls = "ch correct";
      else cls = expected === " " ? "ch wrong wrongSpace" : "ch wrong";
    }

    // Keep spaces visible and width-correct
    const content = expected === " " ? "&nbsp;" : escapeHtml(expected);
    spans.push(`<span class="${cls}" data-i="${i}">${content}</span>`);
  }

  elSentence.innerHTML = spans.join("");

  // Update live stats
  const elapsed = startedAt ? (Date.now() - startedAt) : 0;
  elAcc.textContent = String(computeAccuracy(target, typed));
  elWpm.textContent = String(computeWpm(typed.length, elapsed));

  updateWeakLettersUI();
  requestAnimationFrame(positionCaret);
}

function positionCaret() {
  // caret should sit at the next character to type
  const caretIndex = Math.min(typed.length, Math.max(0, target.length - 1));
  const span = elSentence.querySelector(`span[data-i="${caretIndex}"]`);

  if (!span) return;

  const boxRect = elTypebox.getBoundingClientRect();
  const chRect = span.getBoundingClientRect();

  const x = chRect.left - boxRect.left;
  const y = chRect.top - boxRect.top;

  elCaret.style.transform = `translate(${x}px, ${y}px)`;
  elCaret.style.height = `${chRect.height}px`;
}

function resetSentenceProgress() {
  typed = "";
  startedAt = null;
  lastTypeAt = null;

  elFeedback.textContent = "";
  elWpm.textContent = "0";
  elAcc.textContent = "0";

  render();
}

function setSentence(idx) {
  sentenceIndex = idx;
  target = sentences[sentenceIndex] ?? "";
  elIdx.textContent = String(sentenceIndex + 1);
  elTotal.textContent = String(sentences.length);

  resetSentenceProgress();

  // focus typing surface
  elTypebox.focus({ preventScroll: true });
}

function nextSentence() {
  if (!sentences.length) return;
  const next = (sentenceIndex + 1) % sentences.length;
  setSentence(next);
}

function recordCharTiming(expectedChar, dt) {
  const c = expectedChar.toLowerCase();
  if (!/^[a-z]$/.test(c)) return;

  // ignore huge pauses so distractions don't dominate weakness
  if (dt > 2000) return;

  const prev = charStats.get(c) ?? { count: 0, totalMs: 0 };
  prev.count += 1;
  prev.totalMs += dt;
  charStats.set(c, prev);
}

function getSlowLetters(limit = 6) {
  const rows = [];
  for (const [c, s] of charStats.entries()) {
    if (s.count < 6) continue;
    rows.push({ c, avg: s.totalMs / s.count, count: s.count });
  }
  rows.sort((a, b) => b.avg - a.avg);
  return rows.slice(0, limit);
}

function updateWeakLettersUI() {
  const slow = getSlowLetters(6);
  if (!slow.length) {
    elWeakList.textContent = "–";
    elFocus.textContent = "–";
    return;
  }

  elFocus.textContent = slow[0].c;

  elWeakList.textContent = slow
    .map(x => `${x.c}: ${Math.round(x.avg)}ms (${x.count})`)
    .join(" · ");
}

function finishIfComplete() {
  if (typed !== target) return;

  const elapsed = startedAt ? (Date.now() - startedAt) : 0;
  const wpm = computeWpm(typed.length, elapsed);
  const acc = computeAccuracy(target, typed);

  if (bestWpm === null || wpm > bestWpm) bestWpm = wpm;
  elBest.textContent = bestWpm === null ? "–" : `${bestWpm} WPM`;

  elFeedback.textContent = acc === 100
    ? "Complete. Press Enter for the next sentence."
    : "Complete (with mistakes). Press Esc to retry or Enter to continue.";
}

elTypebox.addEventListener("keydown", (e) => {
  if (!target) return;

  if (isIgnorableKey(e)) return;

  if (e.key === "Escape") {
    e.preventDefault();
    resetSentenceProgress();
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    nextSentence();
    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    if (typed.length > 0) typed = typed.slice(0, -1);
    render();
    return;
  }

  // Only accept printable 1-char keys (includes space and punctuation)
  if (e.key.length !== 1) return;

  e.preventDefault();

  // start timer on first character
  const now = Date.now();
  if (startedAt === null) startedAt = now;

  // record per-char dt against the expected character position
  if (lastTypeAt !== null) {
    const expected = target[typed.length] ?? "";
    recordCharTiming(expected, now - lastTypeAt);
  }
  lastTypeAt = now;

  // append typed char (cap at target length; ignore extra)
  if (typed.length < target.length) {
    typed += e.key;
  }

  render();
  finishIfComplete();
});

window.addEventListener("resize", () => positionCaret());

// Make clicking the box focus it
elTypebox.addEventListener("pointerdown", () => {
  elTypebox.focus({ preventScroll: true });
});

async function init() {
  elSentence.textContent = "Loading Meditations…";
  elTypebox.focus({ preventScroll: true });

  let res;
  try {
    res = await fetch(TEXT_URL);
  } catch {
    elSentence.textContent = "Could not load text file. Are you running via a local server?";
    return;
  }

  if (!res.ok) {
    elSentence.textContent = "Could not load text file. Check texts/meditations.txt exists.";
    return;
  }

  const text = await res.text();
  sentences = splitIntoSentences(text);

  if (!sentences.length) {
    elSentence.textContent = "No sentences found in text file.";
    return;
  }

  bestWpm = null;
  elBest.textContent = "–";

  setSentence(0);
}

init();
