import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers";

const TEXT_URL = "texts/meditations.txt";
const WEAK_KEYS_STORAGE_KEY = "shift_weak_keys";
const WROTE_TEXT_KEY = "wrote_text";
const WROTE_MASTERY_KEY = "wrote_mastery";

// Mastery thresholds
const MASTERY_WPM = 60;
const MASTERY_ACC = 95;
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 5.0;
const WEIGHT_DECAY = 0.5;   // multiply on success (high WPM + high acc)
const WEIGHT_GROW = 1.5;    // multiply on failure

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
const elMastery = document.getElementById("mastery");

const elNotesArea = document.getElementById("notes-area");
const elFileInput = document.getElementById("file-input");
const elLoadNotesBtn = document.getElementById("load-notes-btn");
const elGenerateBtn = document.getElementById("generate-btn");
const elAiStatus = document.getElementById("ai-status");

// --- AI engine ---

let summarizer = null;

/**
 * Split a paragraph of AI summary text into individual sentences using
 * regex on period and exclamation-mark boundaries.
 * @param {string} text - Paragraph of text from the AI summarizer.
 * @returns {string[]} Array of trimmed non-empty sentence strings.
 */
function splitAISummaryIntoSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && /[a-zA-Z]/.test(s));
}

/**
 * Initialize the Transformers.js summarization pipeline.
 * Updates the status indicator and enables the Generate button when ready.
 */
async function initAI() {
  try {
    // Xenova/distilbart-cnn-6-6: a compact, fast distilled BART model fine-tuned
    // on CNN/DailyMail news summarisation. Works well for factual study notes and
    // runs entirely in-browser via ONNX Runtime (no server required).
    summarizer = await pipeline("summarization", "Xenova/distilbart-cnn-6-6");
    if (elAiStatus) {
      elAiStatus.textContent = "Brain Ready";
      elAiStatus.classList.add("status--ready");
    }
    if (elGenerateBtn) elGenerateBtn.disabled = false;
  } catch (err) {
    console.warn("wrote: could not initialize AI pipeline:", err);
    if (elAiStatus) {
      elAiStatus.textContent = "AI unavailable";
      elAiStatus.classList.add("status--error");
    }
  }
}

/**
 * Use the AI summarizer to process the textarea notes, split the result
 * into sentences and restart the typing session with the new content.
 */
async function processNotes() {
  const text = elNotesArea.value.trim();
  if (!text) {
    elFeedback.textContent = "Please paste some notes before generating.";
    return;
  }

  if (elGenerateBtn) elGenerateBtn.disabled = true;
  elFeedback.textContent = "Generating study session…";

  try {
    const result = await summarizer(text, { min_length: 15, max_length: 60, chunk_batch_size: 1 });
    const summaryText = result[0]?.summary_text ?? "";
    const parsed = splitAISummaryIntoSentences(summaryText);

    if (!parsed.length) {
      elFeedback.textContent = "Could not extract sentences from summary. Try more detailed notes.";
      return;
    }

    sentences = parsed;
    buildCharMap();
    initMastery(sentences.length);
    saveMastery();
    bestWpm = null;
    elBest.textContent = "–";
    updateWeakKeyDisplay();
    updateFocusLettersDisplay();
    updateMasteryDisplay();
    setSentence(pickWeightedRandom());
    document.getElementById("notes-panel").removeAttribute("open");
    focusTyping();
  } catch (err) {
    console.error("wrote: AI processing error:", err);
    elFeedback.textContent = "AI error. Please try again.";
  } finally {
    if (elGenerateBtn) elGenerateBtn.disabled = false;
  }
}

if (elGenerateBtn) {
  elGenerateBtn.addEventListener("click", () => processNotes());
}

// --- end AI engine ---

let sentences = [];
let sentenceIndex = 0;

let target = "";
let targetTokens = []; // pre-split tokens for the active target sentence
let startedAt = null;
let bestWpm = null;

// Mastery: parallel array to sentences
let mastery = []; // [{ weight: number, cleared: boolean }]

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

/**
 * Parse arbitrary user-pasted text into an array of sentence strings.
 * Less aggressive than cleanPhilosophyText — no boilerplate filtering,
 * just paragraph splitting and sentence boundary detection.
 * @param {string} rawText - Raw text pasted or uploaded by the user.
 * @returns {string[]} Array of non-empty sentence strings containing at least one letter.
 */
function parseUserText(rawText) {
  const normalized = String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (!normalized) return [];

  const paragraphs = normalized.split(/\n[ \t]*\n/);
  const result = [];

  for (const para of paragraphs) {
    const text = para.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;

    // Split into sentences at sentence-ending punctuation followed by whitespace
    const paraSentences = text
      .split(/(?<=[.!?])\s+/g)
      .map(s => s.trim())
      .filter(s => s.length > 0 && /[a-zA-Z]/.test(s));

    result.push(...paraSentences);
  }

  return result;
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
    console.warn("wrote: could not load weak keys from localStorage:", err);
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
      console.warn("wrote: could not save weak keys to localStorage:", err);
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

// --- Mastery helpers ---

/**
 * Initialise the mastery tracking array with default values.
 * Each entry starts at weight 1.0 (unbiased) and cleared = false.
 * Call whenever a new sentence set is loaded.
 * @param {number} count - Number of sentences to create entries for.
 */
function initMastery(count) {
  mastery = Array.from({ length: count }, () => ({ weight: 1.0, cleared: false }));
}

function loadMastery() {
  try {
    const saved = localStorage.getItem(WROTE_MASTERY_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Only restore if lengths match (same text loaded)
      if (Array.isArray(parsed) && parsed.length === sentences.length) {
        mastery = parsed;
        return;
      }
    }
  } catch (err) {
    console.warn("wrote: could not load mastery from localStorage:", err);
  }
  initMastery(sentences.length);
}

let _saveMasteryTimer = 0;

function saveMastery() {
  clearTimeout(_saveMasteryTimer);
  _saveMasteryTimer = setTimeout(() => {
    try {
      localStorage.setItem(WROTE_MASTERY_KEY, JSON.stringify(mastery));
    } catch (err) {
      console.warn("wrote: could not save mastery to localStorage:", err);
    }
  }, 300);
}

function updateMastery(idx, wpm, acc) {
  const m = mastery[idx];
  if (!m) return;
  if (wpm >= MASTERY_WPM && acc >= MASTERY_ACC) {
    m.cleared = true;
    m.weight = Math.max(WEIGHT_MIN, m.weight * WEIGHT_DECAY);
  } else {
    m.cleared = false;
    m.weight = Math.min(WEIGHT_MAX, m.weight * WEIGHT_GROW);
  }
  saveMastery();
}

function getMasteryPercent() {
  if (!mastery.length) return 0;
  const cleared = mastery.filter(m => m.cleared).length;
  return Math.round((cleared / mastery.length) * 100);
}

function updateMasteryDisplay() {
  elMastery.textContent = String(getMasteryPercent());
}

// --- end Mastery ---

// --- Custom text persistence ---

/**
 * Persist user-provided raw text to localStorage so it can be restored
 * the next time the page is loaded.
 * @param {string} text - Raw text string to save.
 */
function saveCustomText(text) {
  try {
    localStorage.setItem(WROTE_TEXT_KEY, text);
  } catch (err) {
    console.warn("wrote: could not save custom text to localStorage:", err);
  }
}

/**
 * Retrieve previously saved custom text from localStorage.
 * @returns {string|null} The saved raw text string, or null if none exists or
 *   an error occurs reading from localStorage.
 */
function loadCustomText() {
  try {
    return localStorage.getItem(WROTE_TEXT_KEY);
  } catch {
    return null;
  }
}

// --- end Custom text ---

// --- Weighted random sentence selector ---

/**
 * Select a sentence index using weighted-random sampling.
 * Sentences with a higher mastery weight are picked more frequently,
 * ensuring that difficult sentences appear more often until mastered.
 * @param {number} [excludeIdx=-1] - Index to exclude (avoids repeating the
 *   current sentence immediately). Defaults to -1 (no exclusion).
 * @returns {number} The selected sentence index.
 */
function pickWeightedRandom(excludeIdx = -1) {
  let total = 0;
  for (let i = 0; i < mastery.length; i++) {
    if (i !== excludeIdx) total += mastery[i].weight;
  }
  if (total <= 0) {
    // Fallback: first index that isn't excluded
    const fallback = mastery.findIndex((_, i) => i !== excludeIdx);
    return fallback >= 0 ? fallback : 0;
  }
  let r = Math.random() * total;
  for (let i = 0; i < mastery.length; i++) {
    if (i === excludeIdx) continue;
    r -= mastery[i].weight;
    if (r <= 0) return i;
  }
  // Floating-point edge case: return last valid index
  for (let i = mastery.length - 1; i >= 0; i--) {
    if (i !== excludeIdx) return i;
  }
  return 0;
}

// --- end Weighted random ---

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
  // Use weighted random: sentences with higher weight appear more often
  const next = sentences.length > 1 ? pickWeightedRandom(sentenceIndex) : sentenceIndex;
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

  // Update mastery for this sentence
  updateMastery(sentenceIndex, wpm, acc);
  updateMasteryDisplay();

  elFeedback.textContent = typed === target
    ? "Complete. Press Enter for the next sentence."
    : "Press Esc to retry or Enter to continue.";
}

function focusTyping() {
  // On some browsers, focusing an invisible input is flaky unless it's in direct user gesture.
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
   - pointerdown is the most reliable "user gesture" to allow focus on mobile
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

// --- Notes panel event handlers ---

/**
 * Parse and load user-provided text as the active sentence set.
 * Replaces the current sentences, resets mastery tracking to defaults,
 * and persists both the text and the fresh mastery data to localStorage.
 * Shows an error in the feedback area if no sentences could be parsed.
 * @param {string} rawText - Raw text string from paste or file upload.
 */
function loadUserText(rawText) {
  const parsed = parseUserText(rawText);
  if (!parsed.length) {
    elFeedback.textContent = "No sentences found in the provided text. Please try again.";
    return;
  }
  sentences = parsed;
  saveCustomText(rawText);
  buildCharMap();
  initMastery(sentences.length);
  saveMastery();
  bestWpm = null;
  elBest.textContent = "–";
  loadWeakKeys();
  updateWeakKeyDisplay();
  updateFocusLettersDisplay();
  updateMasteryDisplay();
  setSentence(pickWeightedRandom());
}

elLoadNotesBtn.addEventListener("click", () => {
  const text = elNotesArea.value.trim();
  if (!text) {
    elFeedback.textContent = "Please paste some text before loading.";
    return;
  }
  loadUserText(text);
  // Collapse notes panel after loading
  document.getElementById("notes-panel").removeAttribute("open");
  focusTyping();
});

elFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    elNotesArea.value = ev.target.result;
    loadUserText(ev.target.result);
    document.getElementById("notes-panel").removeAttribute("open");
    focusTyping();
  };
  reader.readAsText(file);
  // Reset so the same file can be reloaded
  e.target.value = "";
});

// --- end Notes panel ---

async function init() {
  elTarget.textContent = "Loading…";
  focusTyping();

  // Check for previously saved custom text
  const savedText = loadCustomText();

  if (savedText) {
    sentences = parseUserText(savedText);
    elNotesArea.value = savedText;
  } else {
    // Fall back to bundled meditations.txt
    let res;
    try {
      res = await fetch(TEXT_URL);
    } catch {
      elTarget.textContent = "Could not load text file. Paste your notes below to get started.";
      return;
    }

    if (!res.ok) {
      elTarget.textContent = "Could not load texts/meditations.txt. Paste your notes below.";
      return;
    }

    const raw = await res.text();
    sentences = cleanPhilosophyText(raw);
  }

  if (!sentences.length) {
    elTarget.textContent = "No sentences found. Paste your notes below.";
    return;
  }

  buildCharMap();

  bestWpm = null;
  elBest.textContent = "–";

  loadWeakKeys();
  loadMastery();
  updateWeakKeyDisplay();
  updateFocusLettersDisplay();
  updateMasteryDisplay();
  setSentence(pickWeightedRandom());
}

init();
initAI();
