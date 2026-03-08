// The YAML script will look for this exact string
const API_KEY = "";



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

// --- Loading screen helpers ---

const elLoadingScreen = document.getElementById("loading-screen");
const elLoadingBar = document.getElementById("loading-bar");

function showLoading(label) {
  if (elLoadingScreen) {
    elLoadingScreen.querySelector(".loading-label").textContent = label || "Neural Link Initializing…";
    elLoadingBar.style.width = "0%";
    elLoadingScreen.classList.remove("hidden");
    // Animate bar to ~85% while work is in progress; JS sets 100% on completion
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { elLoadingBar.style.width = "85%"; });
    });
  }
}

function hideLoading() {
  if (elLoadingScreen) {
    elLoadingBar.style.width = "100%";
    setTimeout(() => elLoadingScreen.classList.add("hidden"), 350);
  }
}

// --- end Loading screen ---

// --- AI engine (Gemini 1.5 Flash) ---

/**
 * Send notes text to the Gemini 1.5 Flash API and receive a JSON array of
 * punchy, standalone study sentences (max 12 words each).
 * @param {string} text - Raw notes text from the user.
 * @returns {Promise<string[]>} Array of sentence strings.
 */
async function processNotesWithGemini(text) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

  const body = {
    contents: [
      {
        parts: [
          {
            text:
              "You are a study expert. Convert these notes into a JSON array of " +
              "punchy, standalone sentences (max 12 words) for rote memorization. " +
              "Return ONLY the JSON array.\n\n---NOTES START---\n" + text + "\n---NOTES END---",
          },
        ],
      },
    ],
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  // Extract the JSON array — strip markdown fences if present
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Could not parse JSON array from Gemini response.");

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) throw new Error("Gemini response is not a JSON array.");

  return parsed
    .map(s => String(s).trim())
    .filter(s => s.length > 0 && /[a-zA-Z]/.test(s));
}

/**
 * Use the Gemini AI to process the textarea notes and restart the typing session.
 */
async function processNotes() {
  const text = elNotesArea.value.trim();
  if (!text) {
    elFeedback.textContent = "Please paste some notes before generating.";
    return;
  }

  if (API_KEY === "YOUR_KEY_HERE") {
    elFeedback.textContent = "Add your Gemini API key (API_KEY) in script.js to use AI generation.";
    return;
  }

  if (elGenerateBtn) elGenerateBtn.disabled = true;
  elFeedback.textContent = "";
  showLoading("Gemini Processing…");

  try {
    const parsed = await processNotesWithGemini(text);

    if (!parsed.length) {
      elFeedback.textContent = "Could not extract sentences. Try more detailed notes.";
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
    elFeedback.textContent = `AI error: ${err.message ?? "Unknown error. Check your API key and network."}`;
  } finally {
    hideLoading();
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
  showLoading("Neural Link Initializing…");

  // Enable generate button immediately (Gemini is cloud-based, no local init needed)
  if (elGenerateBtn) elGenerateBtn.disabled = false;
  if (elAiStatus) {
    elAiStatus.textContent = API_KEY === "YOUR_KEY_HERE" ? "No API Key" : "Gemini Ready";
    elAiStatus.classList.add(API_KEY === "YOUR_KEY_HERE" ? "status--error" : "status--ready");
  }

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
      hideLoading();
      return;
    }

    if (!res.ok) {
      elTarget.textContent = "Could not load texts/meditations.txt. Paste your notes below.";
      hideLoading();
      return;
    }

    const raw = await res.text();
    sentences = cleanPhilosophyText(raw);
  }

  if (!sentences.length) {
    elTarget.textContent = "No sentences found. Paste your notes below.";
    hideLoading();
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

  hideLoading();
}

// --- Fluid Geometric Background ---

/**
 * NetworkAnimation draws a constellation of drifting nodes connected by
 * faint cyan lines when nodes approach each other.
 */
class NetworkAnimation {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.nodes = [];
    this.nodeCount = 70;
    this.linkDist = 160;       // pixels - max distance to draw a connecting line
    this.rafId = 0;

    this._resize = this._resize.bind(this);
    window.addEventListener("resize", this._resize);
    this._resize();
    this._buildNodes();
    this._loop();
  }

  _resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  _buildNodes() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.nodes = Array.from({ length: this.nodeCount }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.45,
      vy: (Math.random() - 0.5) * 0.45,
      r: 1.5 + Math.random() * 1.5,
    }));
  }

  _loop() {
    this.rafId = requestAnimationFrame(() => this._loop());
    this._tick();
  }

  _tick() {
    const { ctx, canvas, nodes, linkDist } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Move nodes with gentle drift; wrap at edges
    for (const n of nodes) {
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 0) n.x += w;
      else if (n.x > w) n.x -= w;
      if (n.y < 0) n.y += h;
      else if (n.y > h) n.y -= h;
    }

    // Draw connecting lines
    ctx.strokeStyle = "rgba(0,245,255,0.15)";
    ctx.lineWidth = 0.8;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < linkDist) {
          ctx.globalAlpha = (1 - dist / linkDist) * 0.8;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.stroke();
        }
      }
    }

    // Draw nodes
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "rgba(0,245,255,0.8)";
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }

  destroy() {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this._resize);
  }
}

// Start the background animation
const _bgCanvas = document.getElementById("bg-canvas");
if (_bgCanvas) {
  // Only start if the user hasn't requested reduced motion
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    new NetworkAnimation(_bgCanvas);
  }
}

// --- end Fluid Geometric Background ---

init();
