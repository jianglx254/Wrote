const TEXT_URL = "texts/meditations.txt";

const elTarget = document.getElementById("target-text");
const elInput = document.getElementById("input-field");
const elTypeArea = document.getElementById("type-area");

const elWpm = document.getElementById("wpm");
const elAcc = document.getElementById("acc");
const elBest = document.getElementById("best");
const elIdx = document.getElementById("idx");
const elTotal = document.getElementById("total");
const elFeedback = document.getElementById("feedback");

let sentences = [];
let sentenceIndex = 0;

let target = "";
let startedAt = null;
let bestWpm = null;

function cleanPhilosophyText(rawText) {
  // 1) Split into lines
  const lines = String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  // 2) Filter out unwanted lines
  const filteredLines = lines.filter((line) => {
    const s = line.trim();
    if (!s) return false;

    if (s.includes("http")) return false;
    if (/project\s+gutenberg/i.test(s)) return false;
    if (/translated\s+by/i.test(s)) return false;

    // long dashes / separators
    if (/[-—]{3,}/.test(s)) return false;

    // BOOK ONE / BOOK TWO / BOOK IV etc
    if (/^book\s+((one|two|three|four|five|six|seven|eight|nine|ten)|[ivxlcdm]+)\s*$/i.test(s)) {
      return false;
    }

    return true;
  });

  // 3) Join remaining lines
  const cleaned = filteredLines.join(" ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  // 4) Split into sentences
  const out = cleaned
    .split(/(?<=[.!?])\s+/g)
    .map(s => s.trim())
    .filter(Boolean);

  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[c]));
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

function renderDiff(targetStr, typedStr) {
  const out = [];
  const n = targetStr.length;

  for (let i = 0; i < n; i++) {
    const expected = targetStr[i];
    const got = typedStr[i];

    if (got === undefined) {
      out.push(escapeHtml(expected === " " ? "\u00A0" : expected));
      continue;
    }

    if (got === expected) {
      out.push(`<span class="correct">${escapeHtml(expected === " " ? "\u00A0" : expected)}</span>`);
    } else {
      out.push(`<span class="incorrect">${escapeHtml(expected === " " ? "\u00A0" : expected)}</span>`);
    }
  }

  // If user typed extra chars beyond target, show them as incorrect at the end
  if (typedStr.length > targetStr.length) {
    const extra = typedStr.slice(targetStr.length);
    out.push(`<span class="incorrect">${escapeHtml(extra)}</span>`);
  }

  elTarget.innerHTML = out.join("");
}

function resetSentenceProgress() {
  elInput.value = "";
  startedAt = null;

  elWpm.textContent = "0";
  elAcc.textContent = "0";
  elFeedback.textContent = "";

  renderDiff(target, "");
  elInput.focus({ preventScroll: true });
}

function setSentence(idx) {
  sentenceIndex = idx;
  target = sentences[sentenceIndex] ?? "";

  elIdx.textContent = String(sentenceIndex + 1);
  elTotal.textContent = String(sentences.length);

  resetSentenceProgress();
}

function nextSentence() {
  if (!sentences.length) return;
  const next = (sentenceIndex + 1) % sentences.length;
  setSentence(next);
}

function finishSentence() {
  const typed = elInput.value;
  const elapsed = startedAt ? (Date.now() - startedAt) : 0;

  const wpm = computeWpm(Math.min(typed.length, target.length), elapsed);
  const acc = computeAccuracy(target, typed);

  elWpm.textContent = String(wpm);
  elAcc.textContent = String(acc);

  if (bestWpm === null || wpm > bestWpm) bestWpm = wpm;
  elBest.textContent = bestWpm === null ? "–" : `${bestWpm}`;

  elFeedback.textContent = typed === target
    ? "Complete. Press Enter for the next sentence."
    : "Press Esc to retry or Enter to continue.";
}

elInput.addEventListener("input", () => {
  if (!target) return;

  const typed = elInput.value;

  if (startedAt === null && typed.length > 0) startedAt = Date.now();

  renderDiff(target, typed);

  const elapsed = startedAt ? (Date.now() - startedAt) : 0;
  elAcc.textContent = String(computeAccuracy(target, typed));
  elWpm.textContent = String(computeWpm(Math.min(typed.length, target.length), elapsed));

  if (typed === target) {
    finishSentence();
  }
});

elInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    nextSentence();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    resetSentenceProgress();
    return;
  }
});

elTypeArea.addEventListener("pointerdown", () => {
  elInput.focus({ preventScroll: true });
});

async function init() {
  elTarget.textContent = "Loading Meditations…";
  elInput.focus({ preventScroll: true });

  let res;
  try {
    res = await fetch(TEXT_URL);
  } catch {
    elTarget.textContent = "Could not load text file. Run via a local server (not file://).";
    return;
  }

  if (!res.ok) {
    elTarget.textContent = "Could not load text file. Check texts/meditations.txt exists.";
    return;
  }

  const raw = await res.text();
  sentences = cleanPhilosophyText(raw);

  if (!sentences.length) {
    elTarget.textContent = "No sentences found after cleaning.";
    return;
  }

  bestWpm = null;
  elBest.textContent = "–";

  setSentence(0);
}

init();
