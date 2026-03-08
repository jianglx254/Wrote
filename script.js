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
  const lines = String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  const filteredLines = lines.filter((line) => {
    const s = line.trim();
    if (!s) return false;

    if (s.includes("http")) return false;
    if (/project\s+gutenberg/i.test(s)) return false;
    if (/translated\s+by/i.test(s)) return false;
    if (/[-—]{3,}/.test(s)) return false;

    if (/^book\s+((one|two|three|four|five|six|seven|eight|nine|ten)|[ivxlcdm]+)\s*$/i.test(s)) {
      return false;
    }

    return true;
  });

  const cleaned = filteredLines.join(" ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  return cleaned
    .split(/(?<=[.!?])\s+/g)
    .map(s => s.trim())
    .filter(Boolean);
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

function updateProgressCssVar(typedLen, targetLen) {
  const pct = targetLen > 0 ? Math.min(100, Math.max(0, (typedLen / targetLen) * 100)) : 0;
  elTypeArea.style.setProperty("--progress", `${pct.toFixed(2)}%`);
}

/**
 * Word-friendly rendering:
 * - keep whitespace as actual break opportunities
 * - still color correctness per character
 */
function renderDiff(targetStr, typedStr) {
  updateProgressCssVar(typedStr.length, targetStr.length);

  const tokens = targetStr.split(/(\s+)/); // keeps spaces
  let globalIndex = 0;
  const html = [];

  for (const token of tokens) {
    if (!token) continue;

    if (/^\s+$/.test(token)) {
      // preserve spaces; allow wrapping at them
      html.push(escapeHtml(token).replace(/ /g, "&nbsp;"));
      globalIndex += token.length;
      continue;
    }

    // word-like token; render per-char correctness
    for (let i = 0; i < token.length; i++) {
      const expected = token[i];
      const got = typedStr[globalIndex];

      if (got === undefined) {
        html.push(escapeHtml(expected));
      } else if (got === expected) {
        html.push(`<span class="correct">${escapeHtml(expected)}</span>`);
      } else {
        html.push(`<span class="incorrect">${escapeHtml(expected)}</span>`);
      }

      globalIndex++;
    }
  }

  // show extra typed chars (soft incorrect)
  if (typedStr.length > targetStr.length) {
    const extra = typedStr.slice(targetStr.length);
    html.push(`<span class="incorrect">${escapeHtml(extra)}</span>`);
  }

  elTarget.innerHTML = html.join("");
}

function resetSentenceProgress() {
  elInput.value = "";
  startedAt = null;

  elWpm.textContent = "0";
  elAcc.textContent = "0";
  elFeedback.textContent = "";

  renderDiff(target, "");
  focusTyping();
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

function focusTyping() {
  // On some browsers, focusing an invisible input is flaky unless it’s in direct user gesture.
  // We try anyway; click handler below makes it reliable.
  elInput.focus({ preventScroll: true });
}

elInput.addEventListener("input", () => {
  if (!target) return;

  const typed = elInput.value;

  if (startedAt === null && typed.length > 0) startedAt = Date.now();

  renderDiff(target, typed);

  const elapsed = startedAt ? (Date.now() - startedAt) : 0;
  elAcc.textContent = String(computeAccuracy(target, typed));
  elWpm.textContent = String(computeWpm(Math.min(typed.length, target.length), elapsed));

  if (typed === target) finishSentence();
});

elInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    nextSentence();
  } else if (e.key === "Escape") {
    e.preventDefault();
    resetSentenceProgress();
  }
});

/* Improved click-to-focus:
   - pointerdown is the most reliable “user gesture” to allow focus on mobile
   - also handle click, and when the box is focused via keyboard */
elTypeArea.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  focusTyping();
});

elTypeArea.addEventListener("click", (e) => {
  e.preventDefault();
  focusTyping();
});

elTypeArea.addEventListener("focus", () => {
  focusTyping();
});

async function init() {
  elTarget.textContent = "Loading Meditations…";
  focusTyping();

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
