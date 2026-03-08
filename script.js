const TEXT_URL = "texts/meditations.txt";

const elSentence = document.getElementById("sentence");
const elInput = document.getElementById("input");
const elWpm = document.getElementById("wpm");
const elAcc = document.getElementById("acc");
const elBest = document.getElementById("best");
const elIdx = document.getElementById("idx");
const elTotal = document.getElementById("total");
const elFeedback = document.getElementById("feedback");
const btnNext = document.getElementById("next");
const btnReload = document.getElementById("reload");

let sentences = [];
let i = 0;

let startedAt = null;          // ms timestamp
let currentTarget = "";
let bestWpm = null;

function splitIntoSentences(text) {
  // Normalize whitespace
  const t = text
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  // Basic sentence split (good-enough for a first pass)
  // Keeps ., !, ? as end punctuation.
  const parts = t.split(/(?<=[.!?])\s+/g);

  // Filter out tiny fragments
  return parts
    .map(s => s.trim())
    .filter(s => s.length >= 25);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[c]));
}

function renderDiff(target, typed) {
  // Highlight correct prefix (good), incorrect part (bad), remaining (rest)
  let goodLen = 0;
  const m = Math.min(target.length, typed.length);
  for (let k = 0; k < m; k++) {
    if (target[k] === typed[k]) goodLen++;
    else break;
  }

  const good = target.slice(0, goodLen);
  const bad = typed.length > goodLen ? target.slice(goodLen, Math.min(target.length, typed.length)) : "";
  const rest = target.slice(Math.min(target.length, typed.length));

  elSentence.innerHTML = `
    <span class="good">${escapeHtml(good)}</span><span class="bad">${escapeHtml(bad)}</span><span class="rest">${escapeHtml(rest)}</span>
  `;
}

function computeAccuracy(target, typed) {
  // Character-level accuracy for the characters typed so far.
  if (!typed.length) return 0;
  const n = Math.min(target.length, typed.length);
  let correct = 0;
  for (let k = 0; k < n; k++) {
    if (target[k] === typed[k]) correct++;
  }
  // penalize extra characters beyond target length as incorrect
  const total = typed.length;
  return Math.max(0, Math.round((correct / total) * 100));
}

function computeWpm(typed, elapsedMs) {
  // Standard: 5 chars = 1 word
  if (!typed.length || elapsedMs <= 0) return 0;
  const minutes = elapsedMs / 60000;
  const words = typed.length / 5;
  return Math.max(0, Math.round(words / minutes));
}

function setSentence(idx) {
  i = idx;
  currentTarget = sentences[i] ?? "";
  startedAt = null;

  elInput.value = "";
  elInput.focus();

  elWpm.textContent = "0";
  elAcc.textContent = "0";
  elFeedback.textContent = "";

  elIdx.textContent = String(i + 1);
  elTotal.textContent = String(sentences.length);

  // initial render (no diff)
  elSentence.textContent = currentTarget;
}

function finishSentence() {
  const typed = elInput.value;
  const elapsed = startedAt ? (Date.now() - startedAt) : 0;

  const wpm = computeWpm(typed, elapsed);
  const acc = computeAccuracy(currentTarget, typed);

  elWpm.textContent = String(wpm);
  elAcc.textContent = String(acc);

  if (bestWpm === null || wpm > bestWpm) bestWpm = wpm;
  elBest.textContent = bestWpm === null ? "–" : `${bestWpm} WPM`;

  const perfect = typed === currentTarget;
  elFeedback.textContent = perfect
    ? "Well done. Proceed."
    : "Press Next to continue (or correct errors and try again).";
}

function nextSentence() {
  if (!sentences.length) return;
  const next = (i + 1) % sentences.length;
  setSentence(next);
}

elInput.addEventListener("input", () => {
  if (!currentTarget) return;

  if (startedAt === null && elInput.value.length > 0) {
    startedAt = Date.now();
  }

  const typed = elInput.value;
  const elapsed = startedAt ? (Date.now() - startedAt) : 0;

  renderDiff(currentTarget, typed);

  elAcc.textContent = String(computeAccuracy(currentTarget, typed));
  elWpm.textContent = String(computeWpm(typed, elapsed));

  if (typed === currentTarget) {
    finishSentence();
  }
});

elInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    finishSentence();
  }
});

btnNext.addEventListener("click", nextSentence);
btnReload.addEventListener("click", () => init());

async function init() {
  elSentence.textContent = "Loading Meditations…";
  elInput.disabled = true;

  const res = await fetch(TEXT_URL);
  if (!res.ok) {
    elSentence.textContent = "Could not load text file. Check texts/meditations.txt exists.";
    elInput.disabled = true;
    return;
  }

  const text = await res.text();
  sentences = splitIntoSentences(text);

  if (!sentences.length) {
    elSentence.textContent = "No sentences found in text file.";
    elInput.disabled = true;
    return;
  }

  bestWpm = null;
  elBest.textContent = "–";
  elInput.disabled = false;

  setSentence(0);
}

init();
