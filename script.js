const TEXT_URL = "texts/meditations.txt";
const WEAK_KEYS_STORAGE_KEY = "shift_weak_keys";

const elTarget = document.getElementById("target-text");
const elInput = document.getElementById("input-field");
const elTypeArea = document.getElementById("type-area");

const elWpm = document.getElementById("wpm");
const elAcc = document.getElementById("acc");
const elBest = document.getElementById("best");
const elIdx = document.getElementById("idx");
const elTotal = document.getElementById("total");
const elFeedback = document.getElementById("feedback");
const elWeakKey = document.getElementById("weak-key");
const elFocusLetters = document.getElementById("focus-letters");

let sentences = [];
let sentenceIndex = 0;

let target = "";
let targetTokens = []; // pre-split tokens for the active target sentence
let startedAt = null;
let bestWpm = null;

// Per-character error tracking for the adaptive sentence selection
let keyErrors = {};     // { char: errorCount } — persisted to localStorage
let charMap = new Map(); // letter (a-z) -> array of sentence indices containing that letter
let _prevTypedLen = 0;  // tracks input length between keystrokes to detect new characters

// RAF render-throttling state
let _rafId = 0;
let _pendingTyped = "";

// Pre-allocated DOM nodes for the active sentence (rebuilt once per sentence)
let _charNodes = [];     // one <span> per target character
let _charIsSpace = [];   // parallel boolean: true when the char is whitespace
let _extraSpan = null;   // <span class="incorrect"> for overflow chars

function cleanPhilosophyText(rawText) {
  const normalized = String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // Truncate at THE END marker so copyright/acknowledgements are never processed
  const endMatch = normalized.match(/(?:^|\n)[ \t]*THE END[ \t]*(?:\n|$)/i);
  const content = endMatch ? normalized.slice(0, endMatch.index) : normalized;

  // Process paragraph by paragraph (split on blank lines) to prevent
  // sentences from bleeding across paragraph boundaries
  const paragraphs = content.split(/\n[ \t]*\n/);
  const sentences = [];

  for (const para of paragraphs) {
    // Join wrapped lines within the paragraph, collapse whitespace
    const text = para.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;

    // Filter unwanted paragraphs
    if (text.includes("http")) continue;
    if (/project\s+gutenberg/i.test(text)) continue;
    if (/translated\s+by/i.test(text)) continue;
    if (/copyright/i.test(text)) continue;
    if (/available\s+online/i.test(text)) continue;
    if (/acknowledgement/i.test(text)) continue;
    if (/[-—]{3,}/.test(text)) continue;
    if (/^book\s+((one|two|three|four|five|six|seven|eight|nine|ten)|[ivxlcdm]+)\s*$/i.test(text)) continue;

    // Split into sentences at sentence-ending punctuation
    const paraSentences = text
      .split(/(?<=[.!?])\s+/g)
      .map(s => s.trim())
      .filter(s => s.length > 0 && /[a-zA-Z]/.test(s));

    sentences.push(...paraSentences);
  }

  return sentences;
}

// Hoisted to module level — avoids allocating a new object literal on every character match
const HTML_ESCAPE_MAP = Object.freeze({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
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

// --- Weak Keys helpers ---

function loadWeakKeys() {
  try {
    const saved = localStorage.getItem(WEAK_KEYS_STORAGE_KEY);
    if (saved) keyErrors = JSON.parse(saved);
  } catch (err) {
    console.warn("shift: could not load weak keys from localStorage:", err);
    keyErrors = {};
  }
}

let _saveWeakKeysTimer = 0;

function saveWeakKeys() {
  clearTimeout(_saveWeakKeysTimer);
  _saveWeakKeysTimer = setTimeout(() => {
    try {
      localStorage.setItem(WEAK_KEYS_STORAGE_KEY, JSON.stringify(keyErrors));
    } catch (err) {
      console.warn("shift: could not save weak keys to localStorage:", err);
    }
  }, 300);
}

function getWeakestKey() {
  let maxErrors = 0;
  let weakKey = null;
  for (const [ch, count] of Object.entries(keyErrors)) {
    if (count > maxErrors) {
      maxErrors = count;
      weakKey = ch;
    }
  }
  return weakKey;
}

function buildCharMap() {
  charMap = new Map();
  for (let c = "a".charCodeAt(0); c <= "z".charCodeAt(0); c++) {
    charMap.set(String.fromCharCode(c), []);
  }
  for (let i = 0; i < sentences.length; i++) {
    const uniqueLetters = new Set(sentences[i].toLowerCase().replace(/[^a-z]/g, ""));
    for (const letter of uniqueLetters) {
      if (charMap.has(letter)) charMap.get(letter).push(i);
    }
  }
}

function updateWeakKeyDisplay() {
  const weakKey = getWeakestKey();
  elWeakKey.textContent = weakKey ?? "–";
}

function updateFocusLettersDisplay() {
  const top3 = Object.entries(keyErrors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ch]) => ch);
  elFocusLetters.textContent = top3.length ? top3.join(", ") : "–";
}

// --- end Weak Keys ---

function updateProgressCssVar(typedLen, targetLen) {
  const pct = targetLen > 0 ? Math.min(100, Math.max(0, (typedLen / targetLen) * 100)) : 0;
  elTypeArea.style.setProperty("--progress", `${pct.toFixed(2)}%`);
}

/**
 * Build one <span> per character of the active sentence and append them to
 * elTarget.  Called once per sentence (in setSentence) so that renderDiff can
 * update only the nodes that changed instead of rebuilding innerHTML each time.
 */
function buildTargetDOM() {
  const fragment = document.createDocumentFragment();
  _charNodes = [];
  _charIsSpace = [];

  for (const token of targetTokens) {
    if (!token) continue;

    const isSpace = /^\s+$/.test(token);
    for (let i = 0; i < token.length; i++) {
      const span = document.createElement("span");
      span.textContent = token[i];
      fragment.appendChild(span);
      _charNodes.push(span);
      _charIsSpace.push(isSpace);
    }
  }

  // Overflow span: shown when the user types past the end of the sentence
  _extraSpan = document.createElement("span");
  _extraSpan.className = "incorrect";
  fragment.appendChild(_extraSpan);

  elTarget.innerHTML = "";
  elTarget.appendChild(fragment);
}

/**
 * Word-friendly rendering:
 * - keep whitespace as actual break opportunities
 * - still color correctness per character
 * - shows a blinking underline cursor at the current typing position
 *
 * Instead of rebuilding innerHTML each keystroke, we update only the className
 * (and, for space nodes, textContent) of the nodes that actually changed.
 * For a typical keystroke this is 2 DOM mutations, regardless of sentence length.
 */
function renderDiff(targetStr, typedStr) {
  updateProgressCssVar(typedStr.length, targetStr.length);

  const cursorPos = typedStr.length;
  const nodes = _charNodes;
  const len = nodes.length;

  for (let i = 0; i < len; i++) {
    const node = nodes[i];
    const isCursor = (i === cursorPos);
    const got = typedStr[i];

    let newClass;
    if (isCursor) {
      newClass = "cursor";
    } else if (got === undefined) {
      newClass = "";
    } else if (got === targetStr[i]) {
      newClass = "correct";
    } else {
      newClass = "incorrect";
    }

    if (node.className !== newClass) node.className = newClass;

    // When the cursor sits on a space the underline must be visible:
    // swap the space for a non-breaking space so it has visible width.
    if (_charIsSpace[i]) {
      const want = isCursor ? "\u00a0" : (targetStr[i] ?? " ");
      if (node.textContent !== want) node.textContent = want;
    }
  }

  // Extra chars typed beyond the sentence end
  const extra = typedStr.length > targetStr.length ? typedStr.slice(targetStr.length) : "";
  if (_extraSpan.textContent !== extra) _extraSpan.textContent = extra;
}

function resetSentenceProgress() {
  elInput.value = "";
  startedAt = null;
  _prevTypedLen = 0;

  elWpm.textContent = "0";
  elAcc.textContent = "0";
  elFeedback.textContent = "";

  // Cancel any pending RAF render before doing an immediate reset render
  cancelPendingRender();
  renderDiff(target, "");
  focusTyping();
}

function setSentence(idx) {
  sentenceIndex = idx;
  target = sentences[sentenceIndex] ?? "";
  targetTokens = target.split(/(\s+)/); // pre-tokenize once per sentence

  elIdx.textContent = String(sentenceIndex + 1);
  elTotal.textContent = String(sentences.length);

  buildTargetDOM();        // create per-character DOM nodes once for this sentence
  resetSentenceProgress();
}

function nextSentence() {
  if (!sentences.length) return;
  const weakKey = getWeakestKey();
  if (weakKey) {
    const candidates = (charMap.get(weakKey.toLowerCase()) ?? [])
      .filter(i => i !== sentenceIndex);
    if (candidates.length) {
      setSentence(candidates[Math.floor(Math.random() * candidates.length)]);
      return;
    }
  }
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

// RAF-throttled rendering: coalesces rapid keystrokes into a single paint frame,
// preventing layout thrash when the user types faster than 60 fps.
function cancelPendingRender() {
  cancelAnimationFrame(_rafId);
  _rafId = 0;
}

function scheduleRender(typedStr) {
  _pendingTyped = typedStr;
  if (!_rafId) {
    _rafId = requestAnimationFrame(() => {
      _rafId = 0;
      renderDiff(target, _pendingTyped);
    });
  }
}

elInput.addEventListener("input", () => {
  if (!target) return;

  const typed = elInput.value;

  if (startedAt === null && typed.length > 0) startedAt = Date.now();

  // Track errors for each newly typed character
  if (typed.length > _prevTypedLen) {
    const pos = typed.length - 1;
    if (pos < target.length && typed[pos] !== target[pos]) {
      const ch = target[pos];
      keyErrors[ch] = (keyErrors[ch] || 0) + 1;
      saveWeakKeys();
      updateWeakKeyDisplay();
      updateFocusLettersDisplay();
    }
  }
  _prevTypedLen = typed.length;

  const elapsed = startedAt ? (Date.now() - startedAt) : 0;
  elAcc.textContent = String(computeAccuracy(target, typed));
  elWpm.textContent = String(computeWpm(Math.min(typed.length, target.length), elapsed));

  if (typed === target) {
    // Sentence complete: cancel any pending RAF and render the final state immediately
    cancelPendingRender();
    renderDiff(target, typed);
    finishSentence();
  } else {
    scheduleRender(typed);
  }
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

  buildCharMap();

  bestWpm = null;
  elBest.textContent = "–";

  loadWeakKeys();
  updateWeakKeyDisplay();
  updateFocusLettersDisplay();
  setSentence(0);
}

init();
