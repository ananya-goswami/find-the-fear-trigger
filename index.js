const GAME_STEPS = 3;
const AUDIO_PLAYBACK_RATE = 0.9;
const ENGLISH_AUDIO_PATH = './assets/audio/english/';
// New fear-triggers voiceovers (Avi, generated in Minimax). Wired screen by
// screen as each fear-triggers screen is built.
const VOICEOVER_PATH = './assets/audio/voiceovers/';
// These Minimax clips are already paced at their final speed, so they must play
// at rate 1.0 (NOT the 0.9 slowdown used for the old SFX/voiceovers). Add each
// new voiceover sfx key here as it gets wired.
const NATURAL_RATE_SFX = new Set(['firstPageInstruction', 'complete']);

const GAME_CATEGORY = 'fear-triggers';

let supportedLanguages = {
  en: 'English',
  gu: '\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0',
  hi: '\u0939\u093f\u0928\u094d\u0926\u0940',
  mr: '\u092e\u0930\u093e\u0920\u0940',
  te: '\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41'
};

// --- Analytics bridge (Android WebView) ---
function sendGameEvent(functionName, dataArgs) {
  console.log(`%cANALYTICS: ${functionName}`, 'color: #386AF6; font-weight: bold;', dataArgs);
  const message = {
    functionName,
    args: dataArgs
  };
  const jsonString = JSON.stringify(message);
  if (window.AndroidBridge && window.AndroidBridge.postMessage) {
    window.AndroidBridge.postMessage(jsonString);
  }
}

function practiceActivityStarted(data) {
  sendGameEvent('practiceActivityStarted', data);
}

function practiceActivityCompleted(data) {
  sendGameEvent('practiceActivityCompleted', data);
}

function practiceQuestionAttempted(data) {
  sendGameEvent('practiceQuestionAttempted', data);
}

function closeActivity() {
  sendGameEvent('closeActivity', {});
}

// Language handed in by the host app (getEnvironment), falling back to the
// bundled default. A saved in-game choice (localStorage) still wins.
let initialLang = 'en';
if (typeof locales !== 'undefined' && locales?.defaultLanguage) {
  initialLang = locales.defaultLanguage;
}
if (typeof window.getEnvironment === 'function') {
  try {
    const env = window.getEnvironment();
    if (env && env.app_language && Object.prototype.hasOwnProperty.call(supportedLanguages, env.app_language)) {
      initialLang = env.app_language;
    }
  } catch (error) {
    console.warn('Error calling getEnvironment(), falling back to default language.', error);
  }
}

// Timestamp of when play actually started (loader tapped), a one-shot guard so
// the completion event fires only once per play-through, and the learner's
// FIRST-attempt trigger score (Try Again re-grades don't overwrite it).
let gameStartTime = 0;
let completionTracked = false;
let firstTryTriggerCorrect = null;

function startAnalyticsRun() {
  gameStartTime = Date.now();
  completionTracked = false;
  firstTryTriggerCorrect = null;
  practiceActivityStarted({
    category: GAME_CATEGORY,
    language: currentLanguage || initialLang
  });
}

function trackGameCompletion() {
  if (completionTracked) return;
  completionTracked = true;
  const elapsedSeconds = gameStartTime ? (Date.now() - gameStartTime) / 1000 : 0;
  practiceActivityCompleted({
    category: GAME_CATEGORY,
    language: currentLanguage || initialLang,
    timeSpent: Math.round(elapsedSeconds),
    totalQuestion: TRIGGER_IDS.length,
    correctQuestion: firstTryTriggerCorrect ?? (state.triggerScore?.correct || 0)
  });
}

let localeContent = {};
let shellCopy = { en: {} };
let characters = {};
let activities = [];
let scenes = [];

const sfx = {
  firstPageInstruction: new Audio(`${VOICEOVER_PATH}screen1_phone_notification.ogg`),
  click: new Audio('./assets/audio/button-click.ogg'),
  correct: new Audio('./assets/audio/mixkit-winning-notification-2018.ogg'),
  wrong: new Audio('./assets/audio/incorrect-answer.ogg'),
  complete: new Audio('./assets/audio/complete.mp3')
};

Object.values(sfx).forEach((audio) => {
  audio.preload = 'auto';
  audio.playsInline = true;
});

// --- Voiceover loudness boost -------------------------------------------------
// An <audio> element caps at volume 1.0, but the voiceover recordings sit a bit
// low, so we route ONLY the voice clips (not the SFX) through the Web Audio API
// with a gain > 1 to lift them to a comfortable medium level. Everything degrades
// gracefully: if Web Audio is unavailable or the context can't run yet, the clip
// simply plays natively at 1.0 (never silent).
// === VOICEOVER VOLUME knob === 1 = unchanged, higher = louder. Kept modest so
// the voice doesn't clip/distort.
const VOICE_GAIN = 1.5;
let voiceAudioCtx = null;
let voiceGainNode = null;
const voiceRoutedEls = new WeakSet();

function ensureVoiceGain() {
  if (!voiceGainNode) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      voiceAudioCtx = new Ctx();
      voiceGainNode = voiceAudioCtx.createGain();
      voiceGainNode.gain.value = VOICE_GAIN;
      voiceGainNode.connect(voiceAudioCtx.destination);
    } catch (e) {
      voiceAudioCtx = null;
      voiceGainNode = null;
      return null;
    }
  }
  return voiceGainNode;
}

// Resume the audio context (must happen after a user gesture — see the loader tap).
function resumeVoiceCtx() {
  ensureVoiceGain();
  if (voiceAudioCtx && voiceAudioCtx.state === 'suspended') {
    voiceAudioCtx.resume().catch(() => {});
  }
}

// Route a voice <audio> element through the gain node (once per element). Only
// routes once the context is actually RUNNING, so we never feed audio into a
// suspended graph (which would be silent) — until then it plays natively at 1.0.
function boostVoice(audio) {
  if (!audio) return;
  const gain = ensureVoiceGain();
  if (!gain) return;
  resumeVoiceCtx();
  if (voiceAudioCtx.state !== 'running') return;
  if (voiceRoutedEls.has(audio)) return;
  try {
    const source = voiceAudioCtx.createMediaElementSource(audio);
    source.connect(gain);
    voiceRoutedEls.add(audio);
  } catch (e) {
    // createMediaElementSource throws if the element is already routed — ignore.
  }
}

let currentLanguage = 'en';
let activeAudio = null;
let pendingFirstPageInstruction = false;
let firstPageInstructionUnlockReady = false;
let introVoiceoverDone = false;

const state = {
  step: 1,
  phase: 'activity',
  sceneIndex: 0,
  activitySequenceIndex: 0,
  revealedLineCount: 0,
  scenePageFrameId: '',
  preludeVisible: false,
  preludeDone: false,
  speaking: false,
  // Start UNMUTED: voiceover plays by default.
  muted: false,
  voiceActivated: false,
  toastTimer: null,
  selected: new Set(),
  bubbleLayout: {},
  classifications: {},
  quizAnswers: {},
  sortPlacements: {},
  selectedSortCard: '',
  sortMistakeCard: '',
  swipeIndex: 0,
  swipeAnswers: {},
  matchPairs: {},
  activeMatch: null,
  matchMistakeKey: '',
  points: 0,
  scoredKeys: new Set(),
  quizLocked: {},
  quizDeadline: 0,
  quizRemaining: 15,
  quizTimerKey: '',
  quizTimerId: null,
  quizQuestionIndex: 0,
  mythIndex: 0,
  mythAnswers: {},
  completeAudioPlayed: false,
  // Fear-triggers result for the complete screen: how many of the message's fear
  // triggers the learner correctly boxed (set in checkSelection, read in
  // renderCompleteScreen). Was previously a hardcoded perfect score.
  triggerScore: null,
  answerEffectKey: '',
  feedback: '',
  feedbackKind: '',
  reaction: '',
  tutorialActivityId: '',
  tutorialPrompt: ''
};

const ui = {
  loader: document.getElementById('loader-overlay'),
  loaderCard: document.querySelector('.loader-overlay-card'),
  loaderText: document.getElementById('loader-overlay-text'),
  progressDots: document.getElementById('progressDots'),
  moduleLabel: document.querySelector('.question-label'),
  title: document.getElementById('activityTitle'),
  subtitle: document.getElementById('activitySubtitle'),
  sideProgress: document.getElementById('activitySideProgress'),
  coach: document.getElementById('activityCoach'),
  coachEyebrow: document.querySelector('#coachCard .section-eyebrow'),
  feedbackCard: document.getElementById('feedbackSideCard'),
  feedbackText: document.getElementById('activityFeedback'),
  canvasTitle: document.getElementById('activityCanvasTitle'),
  host: document.getElementById('interactionHost'),
  footerActions: document.getElementById('footerActions'),
  toast: document.getElementById('toast'),
  muteBtn: document.getElementById('muteBtn'),
  langBtn: document.getElementById('langBtn')
};

function t(key, replacements = {}) {
  let value = shellCopy[currentLanguage]?.[key] || shellCopy.en[key] || key;
  Object.entries(replacements).forEach(([name, replacement]) => {
    value = value.replace(`{${name}}`, replacement);
  });
  return value;
}

function getLocaleSection(section) {
  return localeContent[currentLanguage]?.[section] || localeContent.en?.[section] || {};
}

function applyLocaleContent() {
  const baseLocale = localeContent.en || {};
  const locale = localeContent[currentLanguage] || baseLocale;
  if (!locale) return;
  shellCopy.en = baseLocale.shell || shellCopy.en || {};
  shellCopy[currentLanguage] = locale.shell || shellCopy.en;
  characters = locale.characters || baseLocale.characters || characters;
  activities = locale.activities || baseLocale.activities || activities;
  scenes = locale.scenes || baseLocale.scenes || scenes;
}

async function loadLocaleContent() {
  try {
    const response = await fetch('./locales.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load locales.json (${response.status})`);
    localeContent = await response.json();
    Object.entries(localeContent).forEach(([code, locale]) => {
      if (locale.name) supportedLanguages[code] = locale.name;
      if (locale.shell) shellCopy[code] = locale.shell;
    });
    applyLocaleContent();
  } catch (error) {
    console.warn('Using bundled game text because locales.json could not be loaded.', error);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Wrap the last word of a title in <em> so it picks up the gold title accent.
// Works for any language (just splits on the final space). Returns escaped HTML.
function accentLastWord(value) {
  const text = String(value).trim();
  const i = text.lastIndexOf(' ');
  if (i === -1) return `<em>${escapeHtml(text)}</em>`;
  return `${escapeHtml(text.slice(0, i))} <em>${escapeHtml(text.slice(i + 1))}</em>`;
}

function getSceneActivityIndices(scene = scenes[state.sceneIndex]) {
  return scene.activityIndices || [scene.activityIndex];
}

function getCurrentActivity() {
  const scene = scenes[state.sceneIndex] || scenes[0];
  const indices = getSceneActivityIndices(scene);
  return activities[indices[state.activitySequenceIndex] ?? indices[0]];
}

function resetActivityState() {
  stopQuizTimer();
  state.feedback = '';
  state.feedbackKind = '';
  state.reaction = '';
  state.answerEffectKey = '';
  state.selected = new Set();
  state.bubbleLayout = {};
  state.classifications = {};
  state.quizAnswers = {};
  state.sortPlacements = {};
  state.selectedSortCard = '';
  state.sortMistakeCard = '';
  state.swipeIndex = 0;
  state.swipeAnswers = {};
  state.matchPairs = {};
  state.activeMatch = null;
  state.matchMistakeKey = '';
  state.quizLocked = {};
  state.quizDeadline = 0;
  state.quizRemaining = 15;
  state.quizTimerKey = '';
  state.quizQuestionIndex = 0;
  state.mythIndex = 0;
  state.mythAnswers = {};
}

function awardPoints(key, amount = 10) {
  if (state.scoredKeys.has(key)) return;
  state.scoredKeys.add(key);
  state.points += amount;
}

function stopQuizTimer() {
  if (state.quizTimerId) {
    window.clearInterval(state.quizTimerId);
    state.quizTimerId = null;
  }
}

function buildProgressDots() {
  ui.progressDots.innerHTML = '';
  // Don't create the default progress dots - they'll be replaced by circles
}

function updateProgressDots(step) {
  ui.progressDots.querySelectorAll('.progress-dot').forEach((dot, index) => {
    dot.classList.toggle('active', index < step - 1);
    dot.classList.toggle('current', index === step - 1);
  });
}

function getCircleColorsByStep(step) {
  // Mirror Activity 1: always render all 3 circles, only the colors change.
  // current step = purple, completed = yellow, not-yet-reached = white.
  const colors = {
    1: ['#9333ea', '#ffffff', '#ffffff'], // Screen 1 (1/3): Purple, White, White
    2: ['#eab308', '#9333ea', '#ffffff'], // Screen 2 (2/3): Yellow, Purple, White
    3: ['#eab308', '#eab308', '#9333ea'] // Screen 3 (3/3): Yellow, Yellow, Purple
  };
  return colors[step] || [];
}

function renderThreeCircles(step) {
  const colors = getCircleColorsByStep(step);
  const circleHtml = colors.map((color, index) => `
    <div class="three-circle" style="--circle-color: ${color}; --circle-index: ${index};"></div>
  `).join('');

  // Render in the top progress bar area
  ui.progressDots.innerHTML = circleHtml;
}

function updateGameWithCircles() {
  renderThreeCircles(state.step);
}

// Build the 3-screen progress dots HTML with colors baked in at render time.
// Mirrors Activity 1: completed = 'done' (yellow), current step = 'current' (purple),
// not-yet-reached = no class (white/grey). Done inline because renderGame() sets
// ui.host.innerHTML AFTER updateChrome() runs, so coloring the dots post-render
// (via updateMobileProgressDots) would be wiped by the fresh markup.
function mobileProgressDotsHtml(total) {
  return Array.from({ length: total }, (_, index) => {
    const dotStep = index + 1;
    const cls = state.step > dotStep ? 'done' : state.step === dotStep ? 'current' : '';
    return `<i class="${cls}"></i>`;
  }).join('');
}

// Update mobile progress dots based on state.step
function updateMobileProgressDots() {
  document.querySelectorAll('.mobile-progress-dots i').forEach((dot, index) => {
    dot.classList.remove('current', 'done');
    const dotStep = index + 1;
    if (state.step > dotStep) {
      dot.classList.add('done');
    } else if (state.step === dotStep) {
      dot.classList.add('current');
    }
  });
}

function setFooterButtons(buttons) {
  document.getElementById('footerButtons')?.classList.remove('fear-feedback-actions', 'fear-explain-actions', 'fear-complete-actions');
  ui.footerActions.innerHTML = '';
  buttons.forEach((buttonConfig) => {
    const button = document.createElement('button');
    button.className = `btn${buttonConfig.secondary ? ' secondary' : ''}`;
    button.type = 'button';
    button.textContent = buttonConfig.label;
    button.disabled = Boolean(buttonConfig.disabled);
    button.addEventListener('click', buttonConfig.onClick);
    ui.footerActions.appendChild(button);
  });
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  state.toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), 1800);
}

function playSfx(kind) {
  const sound = sfx[kind];
  if (!sound) return Promise.resolve(false);
  // Mute = play at volume 0 (not skipped), so timing stays identical to unmuted.
  // The mute button's own 'click' stays audible both turning sound on AND off.
  sound.muted = kind === 'click' ? false : state.muted;
  sound.pause();
  sound.currentTime = 0;
  sound.playbackRate = NATURAL_RATE_SFX.has(kind) ? 1 : AUDIO_PLAYBACK_RATE;
  // Boost only the voiceover (the intro instruction), not the UI SFX.
  if (kind === 'firstPageInstruction') boostVoice(sound);
  return sound.play()
    .then(() => true)
    .catch(() => false);
}

function playSfxThrough(kind, onDone) {
  const sound = sfx[kind];
  if (!sound) {
    onDone();
    return;
  }
  // Play at volume 0 when muted; onended/onerror still advance the flow.
  sound.muted = state.muted;
  sound.pause();
  sound.currentTime = 0;
  sound.playbackRate = NATURAL_RATE_SFX.has(kind) ? 1 : AUDIO_PLAYBACK_RATE;
  // Boost only the voiceover (the intro instruction), not the UI SFX.
  if (kind === 'firstPageInstruction') boostVoice(sound);
  sound.onended = onDone;
  sound.onerror = onDone;
  sound.play().catch(onDone);
}

function setIntroChoiceHighlight(which) {
  const real = document.querySelector('.intro-choice-demo [data-choice="real"]');
  const scam = document.querySelector('.intro-choice-demo [data-choice="scam"]');
  if (real) real.classList.toggle('intro-highlight', which === 'real');
  if (scam) scam.classList.toggle('intro-highlight', which === 'scam');
}

let startupGateRelease = null;

function clearStartupGateListeners() {
  if (!startupGateRelease) return;
  startupGateRelease();
  startupGateRelease = null;
}

// Spinner-only phase: the loader shows but is NOT clickable — no "Tap to Play"
// text — until the game's assets have finished loading.
function setStartupGateLoading() {
  if (!ui.loader) return;
  clearStartupGateListeners();
  ui.loader.classList.remove('hidden', 'is-ready');
  ui.loader.classList.add('is-loading');
  ui.loader.setAttribute('aria-busy', 'true');
  if (ui.loaderCard) {
    ui.loaderCard.removeAttribute('role');
    ui.loaderCard.removeAttribute('tabindex');
    ui.loaderCard.removeAttribute('aria-label');
  }
  if (ui.loaderText) ui.loaderText.hidden = true;
  document.body.classList.add('startup-gate-active');
}

// Assets are ready: reveal "Tap to Play" and make ONLY the card clickable.
function setStartupGateReady() {
  if (!ui.loader) return;
  ui.loader.classList.remove('hidden', 'is-loading');
  ui.loader.classList.add('is-ready');
  ui.loader.setAttribute('aria-busy', 'false');
  if (ui.loaderCard) {
    ui.loaderCard.setAttribute('role', 'button');
    ui.loaderCard.setAttribute('tabindex', '0');
    ui.loaderCard.setAttribute('aria-label', 'Tap to open the game');
  }
  if (ui.loaderText) ui.loaderText.hidden = false;
  document.body.classList.add('startup-gate-active');
}

function hideStartupGate() {
  clearStartupGateListeners();
  document.body.classList.remove('startup-gate-active');
  ui.loader?.classList.add('hidden');
}

function activateStartupGate(onOpen) {
  // Only the "Tap to Play" card starts the game. The full-screen overlay stays
  // pointer-blocking (so clicks can't reach the game behind it) but is NOT a
  // trigger — clicking/tapping anywhere except the card does nothing.
  const trigger = ui.loaderCard || ui.loader;
  if (!trigger) {
    onOpen?.();
    return;
  }
  setStartupGateReady();
  ui.loaderCard?.focus?.();
  const openGate = (event) => {
    if (event.type === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(event.key)) return;
    event.preventDefault?.();
    // First user gesture: unlock/resume the Web Audio context so the voiceover
    // boost is running before the first line plays.
    resumeVoiceCtx();
    hideStartupGate();
    onOpen?.();
  };
  trigger.addEventListener('pointerdown', openGate, { once: true });
  trigger.addEventListener('keydown', openGate);
  startupGateRelease = () => {
    trigger.removeEventListener('pointerdown', openGate);
    trigger.removeEventListener('keydown', openGate);
  };
}

function playFirstPageInstruction() {
  // Hold the first-screen voiceover until the user clicks the yellow voice-prompt
  // bubble (matches the bubble-burst). The click-to-activate handler then plays it
  // via playScreenVoice once state.voiceActivated is set.
  if (isFirstActivityScreen() && !state.voiceActivated) return;
  pendingFirstPageInstruction = false;
  sfx.firstPageInstruction.pause();
  sfx.firstPageInstruction.currentTime = 0;
  // Sync the Real/Scam button highlight to the words in the voiceover:
  // "real" at 0s, "scam" at 1s (uses media currentTime so playback rate stays accurate).
  sfx.firstPageInstruction.ontimeupdate = () => {
    if (introVoiceoverDone) return;
    setIntroChoiceHighlight(sfx.firstPageInstruction.currentTime >= 1 ? 'scam' : 'real');
  };
  sfx.firstPageInstruction.onended = () => {
    sfx.firstPageInstruction.ontimeupdate = null;
    setIntroChoiceHighlight(null);
    if (introVoiceoverDone) return;
    introVoiceoverDone = true;
    renderGame();
  };
  // Lock the intro Continue button while the voiceover (re)plays.
  // If muted there is no voiceover to wait for, so leave it unlocked.
  introVoiceoverDone = state.muted;
  if (activities.length) renderGame();
  playSfx('firstPageInstruction').then((played) => {
    if (played) {
      setIntroChoiceHighlight('real');
    } else if (!state.muted) {
      pendingFirstPageInstruction = true;
      setupFirstPageInstructionUnlock();
    }
  });
}

// --- Per-screen voiceover (fear-triggers flow) ---
const screenVoice = new Audio(`${VOICEOVER_PATH}screen1_phone_notification.ogg`);
screenVoice.preload = 'auto';
screenVoice.playsInline = true;
let currentVoicePath = `${VOICEOVER_PATH}screen1_phone_notification.ogg`;
let currentVoiceOnEnded = null;
let currentVoiceFallbackMs = 0;
let voiceFallbackTimer = null;

// Muting sets every audio element to volume 0 (native .muted) WITHOUT pausing,
// so clips keep playing and unmuting restores the prior volume in place.
// Dynamic clips (playAudioSequence) call applyAudioMute on creation.
function applyAudioMute(audio) {
  if (audio) audio.muted = state.muted;
}

function applyAudioMuteAll() {
  // Skip 'click' — the mute button's feedback is always audible.
  Object.entries(sfx).forEach(([kind, audio]) => {
    if (kind !== 'click') applyAudioMute(audio);
  });
  applyAudioMute(screenVoice);
  applyAudioMute(activeAudio);
}

// Play a screen's voiceover, interrupting whatever is playing. Remembers the
// path (so unmuting replays the current line) and an optional onEnded callback
// (e.g. reveal the Screen-3 boxes + enable Check). onEnded fires when the clip
// ENDS. While muted there's no audio, so onEnded fires after `fallbackMs` (the
// clip's length) — keeping the read view visible first instead of jumping.
function playScreenVoice(path, onEnded, fallbackMs) {
  if (path) currentVoicePath = path;
  if (onEnded !== undefined) currentVoiceOnEnded = onEnded;
  if (fallbackMs !== undefined) currentVoiceFallbackMs = fallbackMs || 0;
  cancelVoice();
  sfx.firstPageInstruction.pause();
  screenVoice.pause();
  screenVoice.onended = null;
  window.clearTimeout(voiceFallbackTimer);
  const abs = new URL(currentVoicePath, document.baseURI).href;
  if (screenVoice.src !== abs) screenVoice.src = currentVoicePath;
  // Play at volume 0 when muted (don't skip) so the real onended drives the flow.
  screenVoice.muted = state.muted;
  screenVoice.currentTime = 0;
  screenVoice.playbackRate = 1;
  boostVoice(screenVoice);
  if (currentVoiceOnEnded) screenVoice.onended = currentVoiceOnEnded;
  screenVoice.play().catch(() => {
    // Autoplay blocked or load error: fall back to the timed advance so the
    // flow never stalls.
    if (currentVoiceOnEnded) {
      if (currentVoiceFallbackMs) voiceFallbackTimer = window.setTimeout(currentVoiceOnEnded, currentVoiceFallbackMs);
      else currentVoiceOnEnded();
    }
  });
}

// Screen-1 voiceover is held until the first user gesture (browsers block audio
// autoplay). The ONLY gesture that starts the game — and with it the voiceover —
// is the "Tap to Play" loader tap (see activateStartupGate). Tapping/clicking
// anywhere else does nothing. state.voiceActivated is flipped true by that tap
// (and by "Play Again" on restart, itself a gesture), after which
// renderInfoPageActivity plays the Screen-1 voiceover directly.
let voiceActivationHandler = null;

function clearVoiceActivation() {
  if (!voiceActivationHandler) return;
  document.removeEventListener('pointerdown', voiceActivationHandler);
  document.removeEventListener('touchstart', voiceActivationHandler);
  voiceActivationHandler = null;
}

function retryFirstPageInstructionIfNeeded() {
  if (state.phase !== 'activity' || state.sceneIndex !== 0 || state.activitySequenceIndex !== 0) return;
  if (state.muted) return;
  playFirstPageInstruction();
}

function isFirstActivityScreen() {
  return state.phase === 'activity' && state.sceneIndex === 0 && state.activitySequenceIndex === 0;
}

function setupFirstPageInstructionUnlock() {
  if (firstPageInstructionUnlockReady) return;
  firstPageInstructionUnlockReady = true;
  const retryFirstPageInstruction = (event) => {
    if (event?.target?.closest?.('#muteBtn, #resetGameBtn, #fullscreenBtn, #langBtn, #languagePopupOverlay')) {
      return;
    }
    if (!pendingFirstPageInstruction) return;
    playFirstPageInstruction();
  };
  document.addEventListener('pointerdown', retryFirstPageInstruction);
  document.addEventListener('keydown', retryFirstPageInstruction);
  document.addEventListener('touchstart', retryFirstPageInstruction);
}

function setFeedback(message, kind, effectKey = '') {
  state.feedback = message;
  state.feedbackKind = kind;
  state.reaction = kind;
  state.answerEffectKey = effectKey;
  const activity = getCurrentActivity();
  const isFinalClassifyFeedback = activity?.type === 'classify' && message === `${t('correct')} ${activity.coach}`;
  if (isFinalClassifyFeedback) {
    speakLine(message, 'simran', () => {});
  } else {
    playSfxThrough(kind === 'good' ? 'correct' : 'wrong', () => {
      speakLine(message, 'simran', () => {});
    });
  }
  window.setTimeout(() => {
    if (state.reaction === kind && (!effectKey || state.answerEffectKey === effectKey)) {
      state.reaction = '';
      state.answerEffectKey = '';
      renderGame();
    }
  }, 650);
}

function getWrongFeedback(detail = '') {
  const prefix = t('tryAgain');
  return detail ? `${prefix} ${detail}` : prefix;
}

function getActivityWrongFeedback(activity, detail = '') {
  return getWrongFeedback(detail || activity.wrongFeedback || activity.coach || activity.instruction);
}

function getQuestionWrongFeedback(question) {
  return getWrongFeedback(question.wrongFeedback || question.feedback || question.label);
}

function getItemWrongFeedback(item, activity) {
  return getWrongFeedback(item?.wrongFeedback || item?.flag || activity?.wrongFeedback || activity?.coach || '');
}

function getSortWrongFeedback(card, target) {
  const correctZone = card?.answer === 'safe' ? t('safeZone') : t('scamTrickZone');
  const pickedZone = target === 'safe' ? t('safeZone') : t('scamTrickZone');
  return getWrongFeedback(t('sortWrongDetail', {
    card: card?.text || '',
    picked: pickedZone,
    correct: correctZone
  }));
}

function getMatchWrongFeedback(pair) {
  return getWrongFeedback(pair?.feedback || t('matchWrongDetail', {
    clue: pair?.clueText || '',
    sign: pair?.signText || ''
  }));
}

function speakPrompt(text) {
  speakLine(text, 'simran', () => {});
}

function getOptionResultClass(activity, index) {
  if (!state.selected.has(index)) return '';
  if (activity.type === 'multi') {
    const canShowWrong = state.selected.size >= activity.correct.length;
    if (activity.correct.includes(index)) return ' good';
    return canShowWrong ? ' bad' : '';
  }
  return activity.correct === index ? ' good' : ' bad';
}

function getAnswerEffectClass(key, resultClass) {
  if (state.answerEffectKey !== key) return '';
  if (state.reaction === 'good' && resultClass.includes('good')) return ' sparkle';
  if (state.reaction === 'bad' && resultClass.includes('bad')) return ' shake';
  return '';
}

function isActivityCorrect(activity) {
  if (activity.id === 'q3-pay-first') {
    const cards = getSortCards();
    return cards.every((card) => state.sortPlacements[card.id] === card.answer);
  }
  if (activity.id === 'activity-4') {
    return getMatchPairs().every((pair) => state.matchPairs[pair.clue] === pair.sign);
  }
  if (activity.type === 'single') {
    return state.selected.has(activity.correct);
  }
  if (activity.type === 'multi') {
    return activity.correct.length === state.selected.size && activity.correct.every((index) => state.selected.has(index));
  }
  if (activity.type === 'quizSet') {
    return getQuizFrameQuestions(activity).every((question) => isQuizQuestionCorrect(question));
  }
  if (activity.type === 'classify') {
    return activity.items.every((item, index) => state.swipeAnswers[index] === item.answer || state.classifications[index] === item.answer);
  }
  return activity.items.every((item, index) => state.classifications[index] === item.answer);
}

const AVI_BY_SCREEN = {
  intro: './assets/images/avi/avi_screen1.webp',
  inbox: './assets/images/avi/avi_screen2.webp',
  select: './assets/images/avi/avi_screen3.webp',
  feedback: './assets/images/avi/avi_screen4.webp',
  explain: './assets/images/avi/avi_screen5.webp',
  complete: './assets/images/avi/avi_end_screen.webp'
};

function hasActivityAttempt(activity) {
  if (activity.type === 'infoPage') {
    return true;
  }
  if (activity.id === 'q3-pay-first') {
    return getSortCards().every((card) => state.sortPlacements[card.id]);
  }
  if (activity.id === 'activity-4') {
    return getMatchPairs().every((pair) => state.matchPairs[pair.clue]);
  }
  if (activity.type === 'mythFact') {
    return Boolean(state.mythAnswers[state.mythIndex]);
  }
  if (activity.type === 'classify') {
    return Object.keys(state.swipeAnswers).length === activity.items.length || Object.keys(state.classifications).length === activity.items.length;
  }
  if (activity.type === 'quizSet') {
    const question = getCurrentQuizQuestion(activity);
    if (!question) return false;
    const answer = state.quizAnswers[question.id];
    return question.type === 'multi' ? answer instanceof Set && answer.size > 0 : typeof answer === 'number';
  }
  return state.selected.size > 0;
}

function getQuizFrameQuestions(activity) {
  return activity.questions.slice(0, activity.frameQuestionCount ?? 2);
}

function getCurrentQuizQuestion(activity) {
  const questions = getQuizFrameQuestions(activity);
  return questions[Math.min(state.quizQuestionIndex, questions.length - 1)];
}

function isQuizQuestionCorrect(question) {
  const answer = state.quizAnswers[question.id];
  if (question.reflective) return Boolean(answer instanceof Set ? answer.size : typeof answer === 'number');
  if (question.type === 'multi') {
    return answer instanceof Set && question.correct.length === answer.size && question.correct.every((index) => answer.has(index));
  }
  return answer === question.correct;
}

function getQuizOptionResultClass(question, index) {
  const answer = state.quizAnswers[question.id];
  const selected = question.type === 'multi' ? answer?.has(index) : answer === index;
  if (!selected) return '';
  if (question.reflective) return ' good';
  if (question.type === 'multi') {
    const canShowWrong = answer instanceof Set && answer.size >= question.correct.length;
    if (question.correct.includes(index)) return ' good';
    return canShowWrong ? ' bad' : '';
  }
  return question.correct === index ? ' good' : ' bad';
}

function cancelVoice() {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
  }
  state.speaking = false;
}

function getPreRecordedAudioSequence(text) {
  if (currentLanguage !== 'en') return [];
  const activity = activities.find((item) => item.type === 'classify');
  if (!activity) return [];

  const basePath = ENGLISH_AUDIO_PATH;
  const flagAudio = {
    [activity.items?.[0]?.flag]: `${basePath}flag-whatsapp-forward.ogg`,
    [activity.items?.[1]?.flag]: `${basePath}flag-browser-popup.ogg`,
    [activity.items?.[2]?.flag]: `${basePath}flag-instagram-dm.ogg`
  };
  const tryAgain = t('tryAgain');
  const correctComplete = `${t('correct')} ${activity.coach}`;

  // Reserve the first-page instruction audio for initial load/restart only.
  if (text === activity.instruction) return [];
  if (text === t('correct')) return [];
  if (text === activity.coach) return [`${basePath}activity-coach.ogg`];
  if (text === correctComplete) return [`${basePath}correct.ogg`, `${basePath}activity-coach.ogg`];
  if (text === tryAgain) return [`${basePath}tryAgain.ogg`];
  if (flagAudio[text]) return [flagAudio[text]];

  const wrongFlag = Object.keys(flagAudio).find((flag) => text === `${tryAgain} ${flag}`);
  if (wrongFlag) return [`${basePath}tryAgain.ogg`, flagAudio[wrongFlag]];

  return [];
}

function playAudioSequence(sources, onDone) {
  let index = 0;
  const playNext = () => {
    if (index >= sources.length) {
      activeAudio = null;
      onDone();
      return;
    }

    const audio = new Audio(sources[index]);
    audio.muted = state.muted;
    audio.playbackRate = AUDIO_PLAYBACK_RATE;
    boostVoice(audio);
    index += 1;
    activeAudio = audio;
    audio.onended = playNext;
    audio.onerror = playNext;
    audio.play().catch(playNext);
  };

  playNext();
}

function speakLine(text, who, onDone) {
  cancelVoice();
  const audioSequence = getPreRecordedAudioSequence(text);
  if (audioSequence.length) {
    playAudioSequence(audioSequence, onDone);
    return;
  }
  window.setTimeout(onDone, 650);
}

function playSceneLine() {
  const scene = scenes[state.sceneIndex];
  if (scene.prelude && !state.preludeDone) {
    state.preludeVisible = true;
    state.speaking = true;
    renderGame();
    speakLine(scene.prelude.text, scene.prelude.who, () => {
      state.preludeDone = true;
      state.preludeVisible = false;
      state.speaking = false;
      renderGame();
      window.setTimeout(playSceneLine, 450);
    });
    return;
  }

  const line = scene.lines[state.revealedLineCount];
  if (!line) {
    state.speaking = false;
    renderGame();
    return;
  }

  state.speaking = true;
  state.revealedLineCount += 1;
  renderGame();
  speakLine(line.text, line.who, () => {
    state.speaking = false;
    renderGame();
    if (state.revealedLineCount < scene.lines.length) {
      window.setTimeout(playSceneLine, 450);
    }
  });
}

function startScene(index = 0) {
  cancelVoice();
  state.phase = 'scene';
  state.sceneIndex = index;
  state.step = index + 1;
  state.activitySequenceIndex = 0;
  state.revealedLineCount = 0;
  state.scenePageFrameId = '';
  state.preludeVisible = false;
  state.preludeDone = !scenes[index].prelude;
  resetActivityState();
  updateGameWithCircles();
  renderGame();
  window.setTimeout(playSceneLine, 250);
}

function goToActivity() {
  cancelVoice();
  state.phase = 'activity';
  state.step = 1;
  state.activitySequenceIndex = 0;
  resetActivityState();
  updateGameWithCircles();
  renderGame();
  const activity = getCurrentActivity();
}

function goNextSceneOrComplete() {
  if (state.sceneIndex < scenes.length - 1) {
    startScene(state.sceneIndex + 1);
  } else {
    state.phase = 'complete';
    state.step = GAME_STEPS;
    trackGameCompletion();
    updateGameWithCircles();
    renderGame();
    if (!state.completeAudioPlayed) {
      state.completeAudioPlayed = true;
      playSfx('complete');
    }
  }
}

function goNextActivityOrScene() {
  const scene = scenes[state.sceneIndex];
  const activityIndices = getSceneActivityIndices(scene);
  if (state.activitySequenceIndex < activityIndices.length - 1) {
    state.activitySequenceIndex += 1;
    state.step = state.sceneIndex + 1;
    resetActivityState();
    updateGameWithCircles();
    renderGame();
    return;
  }
  goNextSceneOrComplete();
}

function goToNextQuizFrame() {
  stopQuizTimer();
  const activity = getCurrentActivity();
  const questions = getQuizFrameQuestions(activity);
  if (state.quizQuestionIndex < questions.length - 1) {
    state.quizQuestionIndex += 1;
    state.feedback = '';
    state.feedbackKind = '';
    state.reaction = '';
    state.answerEffectKey = '';
    renderGame();
    speakPrompt(getCurrentQuizQuestion(activity).label);
    return;
  }
  goNextActivityOrScene();
}

function goToNextMythFrame() {
  const activity = getCurrentActivity();
  if (state.mythIndex < activity.myths.length - 1) {
    state.mythIndex += 1;
    state.feedback = '';
    state.feedbackKind = '';
    state.reaction = '';
    state.answerEffectKey = '';
    renderGame();
    speakPrompt(activity.myths[state.mythIndex].myth);
    return;
  }
  goNextActivityOrScene();
}

function restartGame() {
  cancelVoice();
  clearVoiceActivation();
  // "Play Again" is itself a user gesture, so audio is already unlocked — keep
  // the voiceover activated so Screen 1 speaks again without another tap.
  state.voiceActivated = true;
  sfx.firstPageInstruction.pause();
  sfx.firstPageInstruction.currentTime = 0;
  stopQuizTimer();
  state.phase = 'activity';
  state.step = 1;
  state.sceneIndex = 0;
  state.activitySequenceIndex = 0;
  state.revealedLineCount = 0;
  state.scenePageFrameId = '';
  state.preludeVisible = false;
  state.preludeDone = false;
  state.points = 0;
  state.scoredKeys = new Set();
  state.completeAudioPlayed = false;
  state.triggerScore = null;
  resetActivityState();
  updateGameWithCircles();
  renderGame();
  startAnalyticsRun();
}

function renderScene(scene) {
  const visibleLines = scene.lines.slice(0, state.revealedLineCount);
  const showImageOnly = Boolean(scene.prelude && state.preludeVisible && !state.preludeDone);
  const pageFrame = !showImageOnly && state.revealedLineCount > 0
    ? scene.pageFrames?.find((frame) => state.revealedLineCount >= frame.fromLine && state.revealedLineCount <= frame.toLine)
    : null;
  const showNotebookPage = Boolean(pageFrame);
  const pageTurnClass = showNotebookPage && state.scenePageFrameId && state.scenePageFrameId !== pageFrame.id ? ' page-turning' : '';
  if (showNotebookPage) state.scenePageFrameId = pageFrame.id;
  const waitingLine = scene.lines[Math.max(state.revealedLineCount - 1, 0)];
  const transcript = visibleLines.map((line, index) => renderBubble(line, index)).join('');
  const waitingName = scene.prelude && state.preludeVisible && !state.preludeDone
    ? characters[scene.prelude.who].name
    : waitingLine
      ? characters[waitingLine.who].name
      : '';
  const waiting = '';
  const prelude = scene.prelude && state.preludeVisible
    ? `
      <article class="scene-prelude ${showImageOnly ? 'image-only' : ''}">
        <img src="${scene.prelude.image}" alt="${escapeHtml(t('sceneIllustrationAlt'))}">
        <div ${showImageOnly ? 'hidden' : ''}>
          <strong>${characters[scene.prelude.who].name}</strong>
          <p>${escapeHtml(scene.prelude.text)}</p>
        </div>
      </article>
    `
    : '';
  const notebookPage = showNotebookPage
    ? `
      <article class="scene-notebook-page${pageTurnClass}" aria-live="polite">
        <div class="notebook-binding" aria-hidden="true"></div>
        <div class="notebook-sheet">
          <img src="${pageFrame.image}" alt="${escapeHtml(pageFrame.alt || t('sceneIllustrationAlt'))}">
        </div>
      </article>
    `
    : '';

  ui.host.innerHTML = `
    <section class="scam-game scene-stage ${showImageOnly ? 'image-scene-stage' : ''}${showNotebookPage ? ' notebook-scene-stage' : ''}">
      <div class="scene-topline" ${showImageOnly || showNotebookPage ? 'hidden' : ''}>
        <span>${escapeHtml(scene.setting)}</span>
        <strong>${escapeHtml(t('sceneCount', { current: state.sceneIndex + 1, total: scenes.length }))}</strong>
      </div>
      <div class="phone-scam-card" hidden>
        <div class="phone-header">${escapeHtml(t('suspiciousMessageHeader'))}</div>
        <div class="phone-copy">
          ${escapeHtml(t('suspiciousMessageCopy'))}
        </div>
      </div>
      <div class="dialogue-track" aria-live="polite" ${showNotebookPage ? 'hidden' : ''}>
        ${prelude}
        ${transcript}
        ${waiting}
      </div>
      ${notebookPage}
    </section>
  `;
}

function renderBubble(line, index) {
  const person = characters[line.who];
  const side = index % 2 === 0 ? 'left' : 'right';
  return `
    <article class="dialogue-bubble-row ${side}">
      <img class="character-photo ${person.tone}" src="${person.image}" alt="${person.name}">
      <div class="dialogue-bubble">
        <div class="speaker-line">
          <strong>${person.name}</strong>
          <span>${escapeHtml(line.mood)}</span>
        </div>
        <p>${escapeHtml(line.text)}</p>
      </div>
    </article>
  `;
}

function getSortCards(activity = getCurrentActivity()) {
  return activity.sortCards || [];
}

function getMatchPairs(activity = getCurrentActivity()) {
  return activity.matchPairs || [];
}

function getShuffledMatchSigns(activity = getCurrentActivity()) {
  return activity.matchSigns || getMatchPairs(activity).map((pair) => ({ id: pair.sign, text: pair.signText }));
}

function getMatchLineGeometry(leftIndex, rightIndex) {
  const startY = 13 + leftIndex * 25;
  const endY = 13 + rightIndex * 25;
  return `M 6 ${startY} C 38 ${startY}, 62 ${endY}, 94 ${endY}`;
}

function shuffleItems(items) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function renderScoreStrip(extra = '') {
  return `
    <div class="game-score-strip">
      <strong>${state.points} pts</strong>
      ${extra ? `<span>${escapeHtml(extra)}</span>` : ''}
    </div>
  `;
}

function renderActivity(activity) {
  if (activity.type === 'infoPage') {
    renderInfoPageActivity(activity);
    return;
  }
  if (activity.id === 'activity-1') {
    renderBubbleBurstActivity(activity);
    return;
  }
  if (activity.id === 'q3-pay-first') {
    renderSortActivity(activity);
    return;
  }
  if (activity.id === 'activity-4') {
    renderMatchActivity(activity);
    return;
  }
  if (activity.type === 'mythFact') {
    renderMythFactActivity(activity);
    return;
  }
  if (activity.type === 'classify') {
    renderClassifyActivity(activity);
    return;
  }
  if (activity.type === 'quizSet') {
    renderQuizSetActivity(activity);
    return;
  }

  const options = activity.options.map((option, index) => {
    const selected = state.selected.has(index);
    const resultClass = getOptionResultClass(activity, index);
    const effectClass = getAnswerEffectClass(`${activity.id}:${index}`, resultClass);
    return `
      <button class="answer-option${selected ? ' selected' : ''}${resultClass}${effectClass}" type="button" data-option="${index}">
        <span class="${activity.type === 'multi' ? 'check-box' : 'radio-dot'}">${selected && activity.type === 'multi' ? '✓' : ''}</span>
        <span>${escapeHtml(option)}</span>
      </button>
    `;
  }).join('');

  ui.host.innerHTML = `
    <section class="scam-game activity-stage ${state.reaction === 'bad' ? 'is-wrong' : ''}">
      <div class="activity-panel ${state.reaction}">
        ${renderScoreStrip('Choose safely')}
        <div class="activity-prompt">${escapeHtml(activity.instruction)}</div>
        <div class="answer-grid ${activity.type}">${options}</div>
      </div>
    </section>
  `;

  ui.host.querySelectorAll('[data-option]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.option);
      const effectKey = `${activity.id}:${index}`;
      speakPrompt(activity.instruction);
      if (activity.type === 'single') {
        state.selected = new Set([index]);
      } else if (state.selected.has(index)) {
        state.selected.delete(index);
      } else {
        state.selected.add(index);
      }
      if (isActivityCorrect(activity)) {
        setFeedback(`${t('correct')} ${activity.coach}`, 'good', effectKey);
      } else if (activity.type === 'single') {
        setFeedback(getActivityWrongFeedback(activity), 'bad', effectKey);
      } else if (activity.correct.includes(index)) {
        setFeedback(t('redFlagFound'), 'good', effectKey);
      } else {
        setFeedback(getActivityWrongFeedback(activity), 'bad', effectKey);
      }
      renderGame();
    });
  });
}

function renderBubbleBurstActivity(activity) {
  const safeBubbles = [
    t('safeBubbleAsk'),
    t('safeBubbleNoClick'),
    t('safeBubbleAdult')
  ];
  const bubbles = [
    ...activity.options.map((option, index) => ({ id: `flag-${index}`, text: option, redFlag: true, optionIndex: index })),
    ...safeBubbles.map((text, index) => ({ id: `safe-${index}`, text, redFlag: false }))
  ];

  if (!state.bubbleLayout[activity.id]) {
    const positions = shuffleItems([
      [13, 19, 1.05], [35, 15, 0.94], [61, 18, 1.02],
      [82, 24, 0.9], [20, 50, 0.88], [47, 43, 1.08],
      [74, 50, 0.95], [31, 76, 0.94], [59, 74, 0.9]
    ]);
    state.bubbleLayout[activity.id] = bubbles.reduce((layout, bubble, index) => {
      layout[bubble.id] = {
        position: positions[index],
        driftX: Math.round((Math.random() * 28) - 14),
        driftY: Math.round((Math.random() * 24) - 18),
        duration: (3.8 + Math.random() * 2.2).toFixed(2)
      };
      return layout;
    }, {});
  }

  const bubbleHtml = bubbles.map((bubble, index) => {
    const layout = state.bubbleLayout[activity.id]?.[bubble.id];
    const [left, top, scale] = layout?.position || [50, 50, 1];
    const selected = bubble.redFlag && state.selected.has(bubble.optionIndex);
    const popping = selected && state.answerEffectKey === bubble.id && state.reaction === 'good';
    const wrong = !bubble.redFlag && state.answerEffectKey === bubble.id && state.reaction === 'bad';
    const longText = bubble.text.length > 34;
    if (selected && !popping) return '';
    return `
      <button
        class="burst-bubble${bubble.redFlag ? ' red-flag' : ' safe-bubble'}${longText ? ' long-bubble' : ''}${popping ? ' popped' : ''}${wrong ? ' wrong-pop' : ''}"
        type="button"
        data-bubble="${bubble.id}"
        style="--x:${left}%; --y:${top}%; --s:${scale}; --dx:${layout?.driftX || 10}px; --dy:${layout?.driftY || -12}px; --dur:${layout?.duration || 4.4}s; --d:${index * -0.35}s;"
        ${selected ? 'disabled' : ''}>
        <span>${escapeHtml(bubble.text)}</span>
      </button>
    `;
  }).join('');
  const riskyLeft = activity.correct.length - state.selected.size;

  ui.host.innerHTML = `
    <section class="scam-game activity-stage burst-stage ${state.reaction === 'bad' ? 'is-wrong' : ''}">
      <div class="activity-panel">
        <div class="bubble-frame">
          <div class="bubble-info-row">
            <div class="bubble-info-card"><strong>${escapeHtml(t('riskyBubblesLeft', { count: riskyLeft }))}</strong></div>
            <div class="bubble-info-card"><strong>${escapeHtml(t('tipLabel'))}</strong> ${escapeHtml(t('bubbleTip'))}</div>
          </div>
          <div class="bubble-arena">${bubbleHtml}</div>
        </div>
      </div>
    </section>
  `;

  ui.host.querySelectorAll('[data-bubble]').forEach((button) => {
    button.addEventListener('click', () => {
      const bubble = bubbles.find((item) => item.id === button.dataset.bubble);
      if (!bubble) return;
      if (bubble.redFlag) {
        state.selected.add(bubble.optionIndex);
        awardPoints(`${activity.id}:${bubble.optionIndex}`, 10);
        if (isActivityCorrect(activity)) {
          setFeedback(`${t('correct')} ${activity.coach}`, 'good', bubble.id);
        } else {
          setFeedback(t('redFlagFound'), 'good', bubble.id);
        }
      } else {
        state.reaction = 'bad';
        state.answerEffectKey = bubble.id;
        state.feedback = getActivityWrongFeedback(activity, t('safeBubbleWrongDetail'));
        state.feedbackKind = 'bad';
        playSfx('wrong');
        window.setTimeout(() => {
          if (state.answerEffectKey === bubble.id && state.reaction === 'bad') {
            state.reaction = '';
            state.answerEffectKey = '';
            state.feedback = '';
            state.feedbackKind = '';
            renderGame();
          }
        }, 2000);
      }
      renderGame();
    });
  });
}

function showWrongSortAttempt(cardId, detail = '') {
  state.sortMistakeCard = cardId;
  state.answerEffectKey = cardId;
  state.feedback = detail || t('tryAgain');
  state.feedbackKind = 'bad';
  state.reaction = 'bad';
  playSfx('wrong');
  renderGame();
  window.setTimeout(() => {
    if (state.sortMistakeCard === cardId && state.reaction === 'bad') {
      state.sortMistakeCard = '';
      state.feedback = '';
      state.feedbackKind = '';
      state.reaction = '';
      state.answerEffectKey = '';
      renderGame();
    }
  }, 2000);
}

function renderSortActivity(activity) {
  const cards = getSortCards();
  const poolCards = cards.filter((card) => !state.sortPlacements[card.id]);
  const scamCards = cards.filter((card) => state.sortPlacements[card.id] === 'scam');
  const safeCards = cards.filter((card) => state.sortPlacements[card.id] === 'safe');
  const placedCount = cards.length - poolCards.length;

  const renderCard = (card) => {
    const placement = state.sortPlacements[card.id];
    const result = placement ? (placement === card.answer ? ' correct' : ' wrong') : '';
    const sparkle = placement === card.answer && state.answerEffectKey === card.id && state.reaction === 'good' ? ' sparkle' : '';
    const mistake = !placement && state.sortMistakeCard === card.id && state.reaction === 'bad' ? ' wrong' : '';
    return `
      <button class="sort-card${result}${sparkle}${mistake}${state.selectedSortCard === card.id ? ' selected' : ''}" type="button" draggable="true" data-card="${card.id}">
        ${escapeHtml(card.text)}
      </button>
    `;
  };

  ui.host.innerHTML = `
    <section class="scam-game activity-stage sort-stage">
      <div class="activity-panel">
        <div class="sort-frame">
          <div class="sort-info-row">
            <div class="bubble-info-card"><strong>${escapeHtml(t('cardsSorted', { count: placedCount, total: cards.length }))}</strong></div>
            <div class="bubble-info-card"><strong>${escapeHtml(t('tipLabel'))}</strong> ${escapeHtml(t('sortTip'))}</div>
          </div>
          <div class="sort-pool" data-drop-zone="pool">${poolCards.map(renderCard).join('')}</div>
          <div class="sort-zones">
            <div class="sort-zone scam-zone" data-drop-zone="scam">
              <strong>${escapeHtml(t('scamTrickZone'))}</strong>
              <div>${scamCards.map(renderCard).join('')}</div>
            </div>
            <div class="sort-zone safe-zone" data-drop-zone="safe">
              <strong>${escapeHtml(t('safeZone'))}</strong>
              <div>${safeCards.map(renderCard).join('')}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  let draggedCard = null;
  ui.host.querySelectorAll('[data-card]').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCard = cardEl.dataset.card;
      event.dataTransfer?.setData('text/plain', draggedCard);
    });
    cardEl.addEventListener('click', () => {
      if (state.sortPlacements[cardEl.dataset.card]) {
        return;
      }
      state.selectedSortCard = state.selectedSortCard === cardEl.dataset.card ? '' : cardEl.dataset.card;
      renderGame();
    });
  });

  ui.host.querySelectorAll('[data-drop-zone]').forEach((zone) => {
    zone.addEventListener('dragover', (event) => event.preventDefault());
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      const cardId = event.dataTransfer?.getData('text/plain') || draggedCard;
      const target = zone.dataset.dropZone;
      if (!cardId || target === 'pool') return;
      state.selectedSortCard = '';
      const card = cards.find((item) => item.id === cardId);
      const correct = card?.answer === target;
      if (correct) {
        state.sortPlacements[cardId] = target;
        state.sortMistakeCard = '';
        awardPoints(`${activity.id}:${cardId}`, 10);
        setFeedback(t('correctPlacement'), 'good', cardId);
      } else {
        showWrongSortAttempt(cardId, getSortWrongFeedback(card, target));
      }
      renderGame();
    });
  });

  ui.host.querySelectorAll('.sort-zone').forEach((zone) => {
    zone.addEventListener('click', (event) => {
      if (event.target.closest('[data-card]')) return;
      const firstCard = cards.find((card) => card.id === state.selectedSortCard) || poolCards[0];
      if (!firstCard || state.sortPlacements[firstCard.id]) return;
      const target = zone.dataset.dropZone;
      state.selectedSortCard = '';
      const correct = firstCard.answer === target;
      if (correct) {
        state.sortPlacements[firstCard.id] = target;
        state.sortMistakeCard = '';
        awardPoints(`${activity.id}:${firstCard.id}`, 10);
        setFeedback(t('correctPlacement'), 'good', firstCard.id);
      } else {
        showWrongSortAttempt(firstCard.id, getSortWrongFeedback(firstCard, target));
      }
      renderGame();
    });
  });
}

function startQuizTimer(activity, question) {
  const key = `${activity.id}:${question.id}`;
  if (state.quizTimerKey === key && state.quizTimerId) return;
  stopQuizTimer();
  state.quizTimerKey = key;
  state.quizRemaining = 15;
  state.quizDeadline = Date.now() + 15000;
  state.quizTimerId = window.setInterval(() => {
    const remaining = Math.max(0, Math.ceil((state.quizDeadline - Date.now()) / 1000));
    if (remaining !== state.quizRemaining) {
      state.quizRemaining = remaining;
      const timerEl = ui.host.querySelector('[data-timer-value]');
      const barEl = ui.host.querySelector('.timer-fill');
      if (timerEl) timerEl.textContent = `${remaining}s`;
      if (barEl) barEl.style.transform = `scaleX(${remaining / 15})`;
    }
    if (remaining <= 0) {
      stopQuizTimer();
      state.quizLocked[question.id] = true;
      state.feedback = t('timeUp');
      state.feedbackKind = 'bad';
      state.reaction = 'bad';
      renderGame();
    }
  }, 250);
}

function renderQuizSetActivity(activity) {
  stopQuizTimer();
  const frameQuestions = getQuizFrameQuestions(activity);
  const questions = frameQuestions
    .filter((_, questionIndex) => questionIndex === state.quizQuestionIndex)
    .map((question) => {
    const answer = state.quizAnswers[question.id];
    const locked = Boolean(state.quizLocked[question.id]);
    const options = question.options.map((option, optionIndex) => {
      const selected = question.type === 'multi' ? answer?.has(optionIndex) : answer === optionIndex;
      const correctOption = question.reflective ? selected : question.type === 'multi'
        ? question.correct.includes(optionIndex)
        : question.correct === optionIndex;
      const resultClass = locked
        ? correctOption
          ? ' good'
          : selected
            ? ' bad'
            : ''
        : getQuizOptionResultClass(question, optionIndex);
      const effectClass = getAnswerEffectClass(`${question.id}:${optionIndex}`, resultClass);
      return `
        <button class="answer-option${selected ? ' selected' : ''}${resultClass}${effectClass}" type="button" data-question="${question.id}" data-option="${optionIndex}" ${locked ? 'disabled' : ''}>
          <span class="${question.type === 'multi' ? 'check-box' : 'radio-dot'}">${selected && question.type === 'multi' ? '✓' : ''}</span>
          <span>${escapeHtml(option)}</span>
        </button>
      `;
    }).join('');

    return `
      <article class="quiz-question-card">
        <div class="quiz-frame-count">${escapeHtml(t('countOf', { current: state.quizQuestionIndex + 1, total: frameQuestions.length }))}</div>
        <div class="quiz-question-title">${escapeHtml(question.label)}</div>
        <div class="answer-grid ${question.type}">${options}</div>
      </article>
    `;
  }).join('');

  ui.host.innerHTML = `
    <section class="scam-game activity-stage final-activity-stage ${state.reaction === 'bad' ? 'is-wrong' : ''}">
      <div class="activity-panel ${state.reaction}">
        ${renderScoreStrip(t('quizLabel'))}
        <div class="activity-prompt">${escapeHtml(activity.instruction)}</div>
        <div class="case-study-card">${escapeHtml(activity.intro)}</div>
        <div class="quiz-question-stack">${questions}</div>
      </div>
    </section>
  `;

  ui.host.querySelectorAll('[data-question]').forEach((button) => {
    button.addEventListener('click', () => {
      const question = activity.questions.find((item) => item.id === button.dataset.question);
      const optionIndex = Number(button.dataset.option);
      const effectKey = `${button.dataset.question}:${optionIndex}`;
      if (!question || state.quizLocked[question.id]) return;
      speakPrompt(question.label);

      if (question.type === 'multi') {
        const next = new Set(state.quizAnswers[question.id] || []);
        if (next.has(optionIndex)) {
          next.delete(optionIndex);
        } else {
          next.add(optionIndex);
        }
        state.quizAnswers[question.id] = next;
      } else {
        state.quizAnswers[question.id] = optionIndex;
      }

      if (question.reflective || isQuizQuestionCorrect(question)) {
        awardPoints(`${activity.id}:${question.id}`, 10);
        setFeedback(question.feedback, 'good', effectKey);
      } else if (question.type === 'single') {
        setFeedback(getQuestionWrongFeedback(question), 'bad', effectKey);
      } else if (question.correct.includes(optionIndex)) {
        setFeedback(t('redFlagFound'), 'good', effectKey);
      } else {
        setFeedback(getQuestionWrongFeedback(question), 'bad', effectKey);
      }
      const currentAnswer = state.quizAnswers[question.id];
      const multiComplete = question.type === 'multi' && currentAnswer instanceof Set && currentAnswer.size >= question.correct.length;
      if (question.type === 'single' || question.reflective || isQuizQuestionCorrect(question) || multiComplete) {
        state.quizLocked[question.id] = true;
        stopQuizTimer();
      }
      renderGame();
    });
  });
}

function renderMythFactActivity(activity) {
  const myth = activity.myths[state.mythIndex];
  const answer = state.mythAnswers[state.mythIndex];
  const speakers = [
    { name: 'Simran', initial: 'S' },
    { name: 'Tej', initial: 'T' },
    { name: 'Zara', initial: 'Z' }
  ];
  const speaker = speakers[state.mythIndex % speakers.length];
  const bustClass = answer === 'myth' ? ' correct' : answer ? ' dim' : '';
  const keepClass = answer === 'truth' ? ' wrong' : answer ? ' dim' : '';

  ui.host.innerHTML = `
    <section class="scam-game activity-stage final-activity-stage myth-stage-shell">
      <div class="quest-stage myth-panel${answer ? ' answered' : ''}">
        <div class="speaker-card">
          <div class="speaker-badge">${escapeHtml(speaker.initial)}</div>
          <div>
            <strong>${escapeHtml(speaker.name)}</strong>
            <span>${escapeHtml(t('mythSpeakerPrompt'))}</span>
          </div>
        </div>
        <div class="myth-bubble">
          <div class="myth-bubble-label">${escapeHtml(t('statementLabel'))}</div>
          <div class="myth-statement">"${escapeHtml(myth.myth)}"</div>
        </div>
        <div class="myth-actions">
          <button class="myth-btn${bustClass}" type="button" data-myth-answer="myth" ${answer ? 'disabled' : ''}>
            ${escapeHtml(t('mythButtonLine1'))}<br>${escapeHtml(t('mythButtonLine2'))}
          </button>
          <button class="myth-btn${keepClass}" type="button" data-myth-answer="truth" ${answer ? 'disabled' : ''}>
            ${escapeHtml(t('truthButtonLine1'))}<br>${escapeHtml(t('truthButtonLine2'))}
          </button>
        </div>
        <div class="myth-fact ${answer ? 'show' : ''}">
          <strong>${escapeHtml(t('factLabel'))}</strong>
          <p>${answer ? escapeHtml(myth.fact) : ''}</p>
        </div>
      </div>
    </section>
  `;

  ui.host.querySelectorAll('[data-myth-answer]').forEach((button) => {
    button.addEventListener('click', () => {
      const picked = button.dataset.mythAnswer;
      state.mythAnswers[state.mythIndex] = picked;
      state.feedback = '';
      state.feedbackKind = '';
      state.reaction = picked === 'myth' ? 'good' : 'bad';
      state.answerEffectKey = `myth:${state.mythIndex}:${picked}`;
      playSfx(picked === 'myth' ? 'correct' : 'wrong');
      speakLine(myth.fact, 'simran', () => {});
      renderGame();
      window.setTimeout(() => {
        state.reaction = '';
        state.answerEffectKey = '';
      }, 650);
    });
  });
}

function renderSwipeActivity(activity) {
  const current = activity.items[state.swipeIndex];
  const answeredCount = Object.keys(state.swipeAnswers).length;
  const done = answeredCount >= activity.items.length;
  const summary = done
    ? activity.items.map((item, index) => {
      const picked = state.swipeAnswers[index];
      const correct = picked === item.answer;
      return `
        <li class="${correct ? 'correct' : 'wrong'}">
          <strong>${escapeHtml(item.from)}</strong>
          <span>${escapeHtml(t('yourAnswerSummary', { picked: picked || t('noneLabel'), correct: item.answer }))}</span>
        </li>
      `;
    }).join('')
    : '';

  ui.host.innerHTML = `
    <section class="scam-game activity-stage swipe-stage">
      <div class="activity-panel">
        ${renderScoreStrip(done ? t('deckComplete') : `${state.swipeIndex + 1} of ${activity.items.length}`)}
        <div class="activity-prompt">${escapeHtml(activity.instruction)}</div>
        ${done ? `
          <div class="swipe-summary">
            <h4>${escapeHtml(t('resultsLabel'))}</h4>
            <ul>${summary}</ul>
          </div>
        ` : `
          <div class="swipe-deck">
            <article class="swipe-card phone-choice ${current.app}" data-swipe-card>
              <div class="mock-phone">
                <div class="mock-status"><span>10:${15 + state.swipeIndex * 7}</span><span>4G</span></div>
            <div class="mock-appbar">${escapeHtml(t(current.app === 'whatsapp' ? 'appWhatsApp' : current.app === 'popup' ? 'appBrowser' : 'appInstagramDm'))}</div>
                <div class="mock-screen-body">
                  <small>${escapeHtml(current.from)}</small>
                  <p>${escapeHtml(current.message)}</p>
                </div>
              </div>
              <small>${escapeHtml(current.label)}</small>
            </article>
          </div>
          <div class="swipe-actions">
            <button type="button" data-swipe="real">${escapeHtml(t('safeButton'))}</button>
            <button type="button" data-swipe="scam">${escapeHtml(t('scamButton'))}</button>
          </div>
        `}
      </div>
    </section>
  `;

  const answerSwipe = (value) => {
    const item = activity.items[state.swipeIndex];
    if (!item) return;
    state.swipeAnswers[state.swipeIndex] = value;
    state.classifications[state.swipeIndex] = value;
    const correct = value === item.answer;
    if (correct) awardPoints(`${activity.id}:${state.swipeIndex}`, 10);
    setFeedback(correct ? item.flag : getItemWrongFeedback(item, activity), correct ? 'good' : 'bad', `swipe:${state.swipeIndex}:${value}`);
    state.swipeIndex += 1;
    renderGame();
  };

  ui.host.querySelectorAll('[data-swipe]').forEach((button) => {
    button.addEventListener('click', () => answerSwipe(button.dataset.swipe));
  });

  const card = ui.host.querySelector('[data-swipe-card]');
  if (card) {
    let startX = 0;
    card.addEventListener('pointerdown', (event) => {
      startX = event.clientX;
      card.setPointerCapture?.(event.pointerId);
    });
    card.addEventListener('pointerup', (event) => {
      const deltaX = event.clientX - startX;
      if (Math.abs(deltaX) < 45) return;
      card.classList.add(deltaX > 0 ? 'fly-right' : 'fly-left');
      window.setTimeout(() => answerSwipe(deltaX > 0 ? 'scam' : 'real'), 180);
    });
  }
}

function renderMatchActivity(activity) {
  const pairs = getMatchPairs();
  const signs = getShuffledMatchSigns();
  const completed = pairs.every((pair) => state.matchPairs[pair.clue]);
  if (completed) {
    ui.host.innerHTML = `
      <section class="scam-game activity-stage match-stage">
        <div class="activity-panel">
          ${renderScoreStrip(t('matchedCount', { count: pairs.length, total: pairs.length }))}
          <div class="activity-prompt">${escapeHtml(t('matchPrompt'))}</div>
          <div class="match-complete-list">
            ${pairs.map((pair, index) => `
              <div class="match-complete-row" style="--i:${index};">
                <button class="match-node clue-node paired" type="button" disabled>
                  ${escapeHtml(pair.clueText)}
                </button>
                <span class="match-arrow" aria-hidden="true">&rarr;</span>
                <button class="match-node sign-node paired" type="button" disabled>
                  ${escapeHtml(pair.signText)}
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      </section>
    `;
    return;
  }
  const lines = pairs
    .map((pair, leftIndex) => ({ pair, leftIndex }))
    .filter(({ pair }) => state.matchPairs[pair.clue])
    .map(({ pair, leftIndex }) => {
      const correct = state.matchPairs[pair.clue] === pair.sign;
      const rightIndex = Math.max(0, signs.findIndex((sign) => sign.id === state.matchPairs[pair.clue]));
      return `<path class="${correct ? 'correct' : 'wrong'}" d="${getMatchLineGeometry(leftIndex, rightIndex)}" />`;
    }).join('');

  ui.host.innerHTML = `
    <section class="scam-game activity-stage match-stage">
      <div class="activity-panel">
        ${renderScoreStrip(t('matchedCount', { count: Object.keys(state.matchPairs).length, total: pairs.length }))}
        <div class="activity-prompt">${escapeHtml(t('matchPrompt'))}</div>
        <div class="match-board${completed ? ' complete-shuffle' : ''}">
          <div class="match-column">
            ${pairs.map((pair) => {
              const clueMistake = state.matchMistakeKey.startsWith(`${pair.clue}:`);
              return `
              <button class="match-node clue-node${state.activeMatch === pair.clue ? ' active' : ''}${state.matchPairs[pair.clue] ? ' paired' : ''}${clueMistake ? ' shake' : ''}" type="button" data-clue="${pair.clue}" ${state.matchPairs[pair.clue] ? 'disabled' : ''}>
                ${escapeHtml(pair.clueText)}
              </button>
            `;
            }).join('')}
          </div>
          <svg class="match-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
          <div class="match-column">
            ${signs.map((sign, index) => `
              <button class="match-node sign-node${state.matchMistakeKey.endsWith(`:${sign.id}`) ? ' shake' : ''}" type="button" data-sign="${sign.id}" style="--i:${index};">
                ${escapeHtml(sign.text)}
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    </section>
  `;

  ui.host.querySelectorAll('[data-clue]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.matchPairs[button.dataset.clue]) return;
      state.activeMatch = button.dataset.clue;
      state.matchMistakeKey = '';
      if (state.feedbackKind === 'bad') {
        state.feedback = '';
        state.feedbackKind = '';
        state.reaction = '';
        state.answerEffectKey = '';
      }
      renderGame();
    });
  });
  ui.host.querySelectorAll('[data-sign]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.activeMatch) {
        showToast(t('pickClueFirst'));
        return;
      }
      const pair = pairs.find((item) => item.clue === state.activeMatch);
      const correct = pair?.sign === button.dataset.sign;
      if (correct) {
        state.matchPairs[state.activeMatch] = button.dataset.sign;
        state.matchMistakeKey = '';
        awardPoints(`${activity.id}:${state.activeMatch}`, 10);
        setFeedback(t('correctMatch'), 'good', state.activeMatch);
        state.activeMatch = null;
      } else {
        const mistakeKey = `${state.activeMatch}:${button.dataset.sign}`;
        state.matchMistakeKey = mistakeKey;
        state.feedback = getMatchWrongFeedback(pair);
        state.feedbackKind = 'bad';
        state.reaction = 'bad';
        state.answerEffectKey = mistakeKey;
        playSfx('wrong');
        window.setTimeout(() => {
          if (state.matchMistakeKey === mistakeKey) {
            state.matchMistakeKey = '';
            state.feedback = '';
            state.feedbackKind = '';
            state.reaction = '';
            state.answerEffectKey = '';
            renderGame();
          }
        }, 650);
      }
      renderGame();
    });
  });
}

function renderInfoPageActivity(activity) {
  state.step = 1; // Progress phase 1/3 ("Spot it": notification + inbox)
  const total = activity.progressTotal || 3;
  ui.host.innerHTML = `
    <section class="scam-game activity-stage">
      <div class="activity-panel">
        <header class="mobile-mission-banner">
          <span class="mission-bubble" aria-hidden="true"></span>
          <div><strong>${accentLastWord(activity.title)}</strong><small>${escapeHtml(activity.instruction)}</small></div>
        </header>
        <div class="mobile-screen-progress">
          <strong>Screen ${state.step}/${total}</strong>
          <span class="mobile-progress-dots" aria-hidden="true">
            ${mobileProgressDotsHtml(total)}
          </span>
        </div>
        <div class="classify-grid classify-grid-empty">
          <div class="classify-intro-panel" aria-label="${escapeHtml(activity.title)}">
            <div class="intro-phone-wrap">
              <div class="intro-phone-frame">
                <img class="intro-phone-image" src="./assets/images/phone.webp" alt="Phone showing a lock screen" />
                <img class="intro-phone-notification-img" src="./assets/images/notification.webp" alt="Scam alert: URGENT, your SBI account will be blocked in 2 hours" />
                <button class="intro-notif-hit" id="introNotification" type="button" aria-label="Open the scam notification"></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  const introNotification = ui.host.querySelector('#introNotification');
  if (introNotification) {
    // Tap anytime (even mid-voiceover) to open the Messages inbox (Screen 2).
    introNotification.addEventListener('click', renderInboxScreen);
  }

  // Intro has no footer button (advance by tapping the notification).
  setFooterButtons([]);
  // Screen-1 sidebar: Avi's intro pose with his intro line (always shown). The
  // voiceover is held until the first user gesture unlocks audio; that gesture is
  // the "Tap to Play" loader tap, which flips state.voiceActivated and re-renders
  // this screen. So the user taps "Tap to Play" once and the voiceover starts —
  // tapping anywhere else does nothing.
  const AVI_INTRO_SPEECH = "This alert looks scary. <strong>Let's find the fear tricks before we trust it!</strong>";
  setGuide(AVI_BY_SCREEN.intro, AVI_INTRO_SPEECH);
  if (state.voiceActivated) {
    playScreenVoice(`${VOICEOVER_PATH}screen1_phone_notification.ogg`, null);
  }
}

// Fear-triggers Screen 2 — Messages inbox. Same shell + same phone frame as the
// intro; only the phone's screen content changes (overlaid on phone.webp).
function renderInboxScreen() {
  const activity = getCurrentActivity();
  state.step = 1; // Progress phase 1/3 ("Spot it": notification + inbox)
  const total = activity.progressTotal || 3;
  ui.host.innerHTML = `
    <section class="scam-game activity-stage">
      <div class="activity-panel">
        <header class="mobile-mission-banner mobile-mission-banner--compact">
          <span class="mission-bubble" aria-hidden="true"></span>
          <div><strong>Choose the <em>Message</em></strong></div>
        </header>
        <div class="mobile-screen-progress">
          <strong>Screen ${state.step}/${total}</strong>
          <span class="mobile-progress-dots" aria-hidden="true">
            ${mobileProgressDotsHtml(total)}
          </span>
        </div>
        <div class="classify-grid classify-grid-empty">
          <div class="classify-intro-panel">
            <div class="intro-phone-wrap">
              <div class="intro-phone-frame">
                <img class="intro-phone-image" src="./assets/images/phone.webp" alt="Phone showing the Messages app" />
                <div class="phone-inbox">
                  <div class="phone-inbox-header">
                    <div class="phone-inbox-title">Messages</div>
                  </div>
                  <div class="phone-inbox-list">
                    <button class="inbox-row inbox-row--alert" id="inboxOpenBtn" type="button" aria-label="Open the SBI Alert message">
                      <span class="inbox-avatar inbox-avatar--sbi">S</span>
                      <span class="inbox-row-main">
                        <span class="inbox-row-top"><strong>SBI Alert</strong><span class="inbox-now">Now</span></span>
                        <span class="inbox-row-sub">URGENT: Your SBI accou&hellip;</span>
                      </span>
                      <span class="inbox-dot" aria-hidden="true"></span>
                    </button>
                    <div class="inbox-row">
                      <span class="inbox-avatar inbox-avatar--mom">A</span>
                      <span class="inbox-row-main">
                        <span class="inbox-row-top"><strong>Avi's Mom</strong><span class="inbox-time">8:58</span></span>
                        <span class="inbox-row-sub">Reach home and call me.</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  const inboxOpenBtn = ui.host.querySelector('#inboxOpenBtn');
  if (inboxOpenBtn) {
    // Opening the SBI Alert advances to Screen 3 (Box the Fear Triggers).
    inboxOpenBtn.addEventListener('click', renderSelectScreen);
  }

  // Screen-2 sidebar: Avi pointing pose + matching speech bubble + coach.
  setGuide(AVI_BY_SCREEN.inbox, "Look, <strong>one message is unread.</strong>", COACH_INBOX);
  // Back button (primary style, like Continue) returns to Screen 1.
  setFooterButtons([{ label: 'Back', onClick: () => renderInfoPageActivity(getCurrentActivity()) }]);
  // Screen-2 voiceover starts on arrival (interrupts Screen-1's).
  playScreenVoice(`${VOICEOVER_PATH}screen2_messages_inbox.ogg`, null);
}

// Shared SMS bubble markup (same six phrases on Screen 3 select + Screen 5
// explain). data-id drives grading (checkSelection) and clue highlighting.
const SMS_BUBBLE_INNER = `<button class="sms-word" type="button" data-id="urgent">URGENT</button>: <button class="sms-word" type="button" data-id="account">Your SBI account</button> will be <button class="sms-word" type="button" data-id="blocked">BLOCKED</button> in <button class="sms-word" type="button" data-id="deadline">2 hrs</button>. <button class="sms-word" type="button" data-id="verify">Verify now</button>: <button class="sms-word sms-word--link" type="button" data-id="url">sbi-secure-verify.xyz</button>`;

// The four real fear triggers (id -> label + reason + clue voiceover). Copy is
// ported from Activity 1 / the voiceover script (it matches the spoken audio).
const FEAR_TRIGGERS = [
  { id: 'urgent', label: 'URGENT', voice: 'screen6_clue1_urgent.ogg', reason: 'This word tries to create fear so you react quickly instead of checking calmly.' },
  { id: 'blocked', label: 'BLOCKED', voice: 'screen6_clue2_blocked.ogg', reason: 'It threatens that the account will be blocked. Scammers use loss to push fast action.' },
  { id: 'deadline', label: '2 hrs', voice: 'screen6_clue3_two_hours.ogg', reason: 'A short time limit creates urgency. Real support gives clear steps, not a panic clock.' },
  { id: 'url', label: 'Fake link', voice: 'screen6_clue4_fake_link.ogg', reason: 'The link looks bank-related but is not the official bank domain. It is bait for a fake page.' }
];
const TRIGGER_IDS = FEAR_TRIGGERS.map((trigger) => trigger.id);

// Fear-triggers Screen 3 — "Box the Fear Triggers". The SMS opens; the learner
// taps the scary phrases (they toggle a red box). Same shell + phone frame.
function renderSelectScreen() {
  const activity = getCurrentActivity();
  state.step = 2; // Progress phase 2/3 ("Box it": select triggers + grade)
  const total = activity.progressTotal || 3;
  ui.host.innerHTML = `
    <section class="scam-game activity-stage">
      <div class="activity-panel">
        <header class="mobile-mission-banner mobile-mission-banner--compact">
          <span class="mission-bubble" aria-hidden="true"></span>
          <div><strong>Box the Fear <em>Triggers</em></strong></div>
        </header>
        <div class="mobile-screen-progress">
          <strong>Screen ${state.step}/${total}</strong>
          <span class="mobile-progress-dots" aria-hidden="true">
            ${mobileProgressDotsHtml(total)}
          </span>
        </div>
        <div class="classify-grid classify-grid-empty">
          <div class="classify-intro-panel">
            <div class="intro-phone-wrap">
              <div class="intro-phone-frame">
                <img class="intro-phone-image" src="./assets/images/phone.webp" alt="Phone showing the SBI Alert message" />
                <div class="phone-sms">
                  <div class="phone-sms-nav"><span class="phone-sms-back" aria-hidden="true">&#8249;</span>Messages</div>
                  <div class="phone-sms-contact">
                    <span class="phone-sms-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="#fff"><circle cx="12" cy="9" r="3.4"/><path d="M5.6 19c.5-3.2 3.2-5 6.4-5s5.9 1.8 6.4 5z"/></svg></span>
                    <strong class="phone-sms-name">SBI-Alert</strong>
                  </div>
                  <div class="phone-sms-body">
                    <div class="phone-sms-bubble" id="smsBubble">${SMS_BUBBLE_INNER}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  // Screen-3 sidebar: Avi open-hand pose + bubble + coach.
  setGuide(AVI_BY_SCREEN.select, "These words are <strong>trying to scare me.</strong>", COACH_SELECT);
  // Check button (replaces Back); disabled until the Screen-3 voiceover finishes,
  // then grades the boxed phrases (Screen 4 feedback) via checkSelection.
  setFooterButtons([{ label: 'Check', disabled: true, onClick: checkSelection }]);
  const checkBtn = ui.footerActions.querySelector('.btn');
  const smsBubble = ui.host.querySelector('#smsBubble');
  // Phase 1: read-only SMS while the voiceover plays. When it ENDS (or, if muted,
  // after the clip's ~7.5s length so the read view still shows), reveal the
  // clickable boxes (tap to select) and enable the Check button.
  playScreenVoice(`${VOICEOVER_PATH}screen3_select_triggers.ogg`, () => {
    if (smsBubble) {
      smsBubble.classList.add('boxing-active');
      smsBubble.querySelectorAll('.sms-word').forEach((word) => {
        word.addEventListener('click', () => {
          if (smsBubble.classList.contains('checked')) return; // locked after Check
          word.classList.toggle('selected');
        });
      });
    }
    // Boxes appear -> bubble switches to the "find the fear triggers" prompt.
    const speech = document.querySelector('.tej-speech');
    if (speech) speech.innerHTML = "Find the <strong>fear triggers.</strong>";
    if (checkBtn) checkBtn.disabled = false;
  }, 7500);
}

// Reusable phone-frame shell that overlays the SBI-Alert SMS on phone.webp.
// `bubbleClass` switches between the Screen-3 (select) and Screen-5 (explain)
// bubble; `title` sets the compact banner.
function renderSmsPhoneScreen(title, bubbleClass, total) {
  return `
    <section class="scam-game activity-stage">
      <div class="activity-panel">
        <header class="mobile-mission-banner mobile-mission-banner--compact">
          <span class="mission-bubble" aria-hidden="true"></span>
          <div><strong>${accentLastWord(title)}</strong></div>
        </header>
        <div class="mobile-screen-progress">
          <strong>Screen ${state.step}/${total}</strong>
          <span class="mobile-progress-dots" aria-hidden="true">
            ${mobileProgressDotsHtml(total)}
          </span>
        </div>
        <div class="classify-grid classify-grid-empty">
          <div class="classify-intro-panel">
            <div class="intro-phone-wrap">
              <div class="intro-phone-frame">
                <img class="intro-phone-image" src="./assets/images/phone.webp" alt="Phone showing the SBI Alert message" />
                <div class="phone-sms">
                  <div class="phone-sms-nav"><span class="phone-sms-back" aria-hidden="true">&#8249;</span>Messages</div>
                  <div class="phone-sms-contact">
                    <span class="phone-sms-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="#fff"><circle cx="12" cy="9" r="3.4"/><path d="M5.6 19c.5-3.2 3.2-5 6.4-5s5.9 1.8 6.4 5z"/></svg></span>
                    <strong class="phone-sms-name">SBI-Alert</strong>
                  </div>
                  <div class="phone-sms-body">
                    <div class="phone-sms-bubble ${bubbleClass}" id="smsBubble">${SMS_BUBBLE_INNER}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

// Fear-triggers Screen 4 — grade the boxed phrases (wired to the Check button on
// Screen 3). Marks each box correct / wrong / missed, locks further tapping, then
// shows Avi's feedback (avi_screen4) + the matching voiceover. Stays on the same
// phone so the learner sees their answer marked (matches Activity 1).
function checkSelection() {
  const bubble = ui.host.querySelector('#smsBubble');
  if (!bubble || bubble.classList.contains('checked')) return;
  bubble.classList.add('checked');

  const words = [...bubble.querySelectorAll('.sms-word')];
  const selectedIds = words.filter((word) => word.classList.contains('selected')).map((word) => word.dataset.id);
  const allTriggers = TRIGGER_IDS.every((id) => selectedIds.includes(id));
  const noExtras = selectedIds.every((id) => TRIGGER_IDS.includes(id));
  const correct = selectedIds.length > 0 && allTriggers && noExtras;

  // Record the real score for the complete screen: count the fear triggers the
  // learner correctly boxed, minus any safe words boxed by mistake (so boxing
  // every word can't fake a perfect score). Clamped to 0..total.
  const triggersBoxed = selectedIds.filter((id) => TRIGGER_IDS.includes(id)).length;
  const extrasBoxed = selectedIds.length - triggersBoxed;
  state.triggerScore = {
    correct: Math.max(0, triggersBoxed - extrasBoxed),
    total: TRIGGER_IDS.length
  };

  practiceQuestionAttempted({
    category: GAME_CATEGORY,
    question: 1,
    selectedAnswer: selectedIds.join(', ') || 'none',
    isCorrect: correct
  });
  // Only the first grading counts toward the completion event's score;
  // Try Again re-checks don't overwrite it.
  if (firstTryTriggerCorrect === null) firstTryTriggerCorrect = state.triggerScore.correct;

  words.forEach((word) => {
    const isTrigger = TRIGGER_IDS.includes(word.dataset.id);
    const isSelected = word.classList.contains('selected');
    word.classList.toggle('correct', isSelected && isTrigger);
    word.classList.toggle('wrong', isSelected && !isTrigger);
    word.classList.toggle('missed', isTrigger && !isSelected);
  });

  playSfx(correct ? 'correct' : 'wrong');

  const speech = "Nice! We found the fear clues.";
  setGuide(AVI_BY_SCREEN.explain, speech, COACH_SELECT);

  // Both buttons disabled until the feedback voiceover finishes (like Check).
  setFooterButtons([
    { label: 'Try Again', secondary: true, disabled: true, onClick: renderSelectScreen },
    { label: 'Learn Why', disabled: true, onClick: renderExplainScreen }
  ]);
  document.getElementById('footerButtons')?.classList.add('fear-feedback-actions');
  const feedbackBtns = [...ui.footerActions.querySelectorAll('.btn')];
  playScreenVoice(`${VOICEOVER_PATH}${correct ? 'screen4_feedback_correct.ogg' : 'screen4_feedback_wrong.ogg'}`, () => {
    feedbackBtns.forEach((btn) => { btn.disabled = false; });
  });
}

// Fear-triggers Screen 5 — "Why These Are Triggers". Read-only SMS; after the
// intro line, each trigger word highlights one at a time with its clue voiceover
// (350 ms gap between clues), ending on the safe-action line which unlocks Finish.
let clueStep = 0;
function renderExplainScreen() {
  const activity = getCurrentActivity();
  state.step = 3; // Progress phase 3/3 ("Learn it": explain + complete)
  const total = activity.progressTotal || 3;
  clueStep = 0;
  ui.host.innerHTML = renderSmsPhoneScreen('Why These Are Triggers', 'phone-sms-bubble--explain', total);
  setGuide(AVI_BY_SCREEN.explain, "Let's see <strong>why each word is a trick.</strong>", COACH_SELECT);
  setFooterButtons([
    { label: 'Replay', secondary: true, disabled: true, onClick: playClueReveal },
    { label: 'Finish', disabled: true, onClick: renderCompleteScreen }
  ]);
  document.getElementById('footerButtons')?.classList.add('fear-explain-actions');
  // Intro line, then auto-start the clue reveal.
  playScreenVoice(`${VOICEOVER_PATH}screen5_why_triggers.ogg`, playClueReveal, 5000);
}

function playClueReveal() {
  clueStep = 0;
  const bubble = ui.host.querySelector('#smsBubble');
  if (bubble) bubble.querySelectorAll('.sms-word').forEach((word) => word.classList.remove('clue-active'));
  setFooterButtons([
    { label: 'Replay', secondary: true, disabled: true, onClick: playClueReveal },
    { label: 'Finish', disabled: true, onClick: renderCompleteScreen }
  ]);
  document.getElementById('footerButtons')?.classList.add('fear-explain-actions');
  showNextClue();
}

function showNextClue() {
  const bubble = ui.host.querySelector('#smsBubble');
  if (!bubble) return;
  bubble.querySelectorAll('.sms-word').forEach((word) => word.classList.remove('clue-active'));

  if (clueStep >= FEAR_TRIGGERS.length) {
    // Safe-action wrap-up, then unlock Finish + Replay.
    setGuide(AVI_BY_SCREEN.explain, "Safe move: <strong>Don't tap. Open the real app and ask a trusted adult.</strong>", COACH_SAFE);
    playScreenVoice(`${VOICEOVER_PATH}screen6b_safe_action.ogg`, () => {
      setFooterButtons([
        { label: 'Replay', secondary: true, onClick: playClueReveal },
        { label: 'Finish', onClick: renderCompleteScreen }
      ]);
      document.getElementById('footerButtons')?.classList.add('fear-explain-actions');
    }, 4500);
    return;
  }

  const clue = FEAR_TRIGGERS[clueStep];
  const word = bubble.querySelector(`.sms-word[data-id="${clue.id}"]`);
  if (word) word.classList.add('clue-active');
  setGuide(AVI_BY_SCREEN.explain, `<strong>${escapeHtml(clue.label)}:</strong> ${escapeHtml(clue.reason)}`, COACH_SELECT);
  clueStep += 1;
  // After this clue's voiceover ends (or its fallback while muted), pause 350 ms
  // then move to the next clue.
  playScreenVoice(`${VOICEOVER_PATH}${clue.voice}`, () => {
    window.setTimeout(showNextClue, 350);
  }, 3500);
}

// Fear-triggers End screen — completion summary. No phone; celebratory Avi.
function renderCompleteScreen() {
  state.step = 3; // Progress phase 3/3 ("Learn it": explain + complete)
  trackGameCompletion();
  // Real fear-trigger score (set when the learner pressed Check). Default to a
  // zero score if somehow reached without grading, so we never fake a result.
  const score = state.triggerScore || { correct: 0, total: TRIGGER_IDS.length };
  const confetti = Array.from({ length: 70 }, (_, index) => `
    <i class="final-confetti ${index % 8 === 0 ? 'confetti-star' : ''}" aria-hidden="true"
       style="--x:${(index * 29) % 98}%; --delay:${(index % 9) * -0.38}s; --dur:${3.3 + (index % 6) * 0.34}s; --spin:${80 + (index % 7) * 54}deg;"></i>
  `).join('');
  // Layout ported from Activity 4 (final-mission-stage). Content is unchanged:
  // Avi, the three fear-trigger clue cards (with their sprite icons), the 3/3
  // score and the cyber-fraud note. The .final-mission-stage class triggers the
  // shared CSS that hides the app chrome and lays out the side panel + board.
  const learned = [
    { icon: 'panic', title: 'Panic Words', detail: 'Urgent words create panic' },
    { icon: 'deadline', title: 'Threats and Deadlines', detail: 'Threats and short deadlines add pressure' },
    { icon: 'link', title: 'Strange Links', detail: 'Check links before you trust them' }
  ];
  ui.host.innerHTML = `
    <section class="scam-game final-mission-stage">
      <div class="final-confetti-layer" aria-hidden="true">${confetti}</div>
      <aside class="final-side-panel">
        <section class="final-side-mission-card">
          <img src="./assets/images/sorting-final-icons/mission-shield.webp" alt="" aria-hidden="true">
          <strong>Mission<br><em>Complete!</em></strong>
          <span>You made smart choices online!</span>
        </section>
        <section class="final-found-card">
          <img class="final-target-icon" src="./assets/images/sorting-final-icons/target.webp" alt="" aria-hidden="true">
          <div>
            <strong>Clues Found</strong>
            <b>${score.correct} / ${score.total}</b>
            <span>Great work!</span>
          </div>
        </section>
        <div class="sidebar-motto"><span aria-hidden="true"></span> Be <b>Smart.</b> Be <b>Safe.</b> Be <b>Secure.</b></div>
      </aside>
      <main class="final-board">
        <header class="final-heading">
          <h3><span>Great Job,</span> <em class="final-heading-name">Avi</em>!</h3>
          <p>You found the pressure words and fake-link clues that phishing messages use to rush people.</p>
        </header>
        <div class="final-hero-row">
          <img class="final-simran" src="./assets/images/avi/avi_end_screen.webp" alt="Avi celebrating">
          <img class="final-shield" src="./assets/images/final badge.webp" alt="Safety shield badge">
          <img class="final-scam-trash" src="./assets/images/sorting-final-icons/clipboard.webp" alt="Scam messages stopped">
        </div>
        <section class="final-spotted-panel">
          <strong class="final-spotted-ribbon">Here&rsquo;s What You <em>Learned:</em></strong>
          <div class="final-spotted-grid">
            ${learned.map((item) => `
              <article class="final-clue-card">
                <div class="ft-learned-icon ft-learned-icon--${item.icon}" aria-hidden="true"></div>
                <strong>${item.title}</strong>
                <span>${item.detail}</span>
              </article>
            `).join('')}
          </div>
        </section>
        <button class="final-play-again" type="button">&#8635; <span>Play Again</span></button>
      </main>
    </section>
  `;
  playSfx('complete');
  // App chrome (left panel + footer) is hidden via the .final-mission-stage CSS;
  // the in-board Play Again button restarts the activity.
  setFooterButtons([]);
  ui.host.querySelector('.final-play-again').addEventListener('click', () => {
    startAnalyticsRun();
    renderInfoPageActivity(getCurrentActivity());
  });
  playScreenVoice(`${VOICEOVER_PATH}screen7_complete.ogg`, null);
}

let originalCoachHtml = null;
// Swap the left-panel guide image + speech bubble + safety-coach list per screen.
// Pass coachHtml = undefined to keep the original (intro) coach.
function setGuide(imageSrc, speechHtml, coachHtml) {
  const guideImg = document.querySelector('.tej-guide-image');
  if (guideImg) guideImg.src = imageSrc;
  const speech = document.querySelector('.tej-speech');
  if (speech) speech.innerHTML = speechHtml;
  const coachList = document.querySelector('.safety-coach-list');
  if (coachList) {
    if (originalCoachHtml === null) originalCoachHtml = coachList.innerHTML;
    coachList.innerHTML = coachHtml || originalCoachHtml;
  }
}

// Replace sidebar with Mission Complete design for the final screen
function setCompleteMissionSidebar() {
  const total = getCurrentActivity()?.progressTotal || 3;
  const score = document.getElementById('finalSidebarScore');
  if (score) score.textContent = `${total}/${total}`;
}


// Screen-2 Safety Coach (magnifying glass / red triangle / green shield).
const COACH_INBOX = `
  <svg class="coach-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#d7e7ff"/><circle cx="10.6" cy="10.6" r="4" fill="none" stroke="#2f6fe0" stroke-width="1.8"/><line x1="13.7" y1="13.7" x2="17" y2="17" stroke="#2f6fe0" stroke-width="2" stroke-linecap="round"/></svg><strong>Unread means notice</strong>
  <svg class="coach-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><defs><linearGradient id="coachTri2" x1="12" y1="3" x2="12" y2="20" gradientUnits="userSpaceOnUse"><stop stop-color="#f4584a"/><stop offset="1" stop-color="#d52e21"/></linearGradient></defs><path d="M10.27 3.85a2 2 0 0 1 3.46 0l7.64 13.3A2 2 0 0 1 19.64 20H4.36a2 2 0 0 1-1.73-2.85l7.64-13.3Z" fill="url(#coachTri2)"/><rect x="10.85" y="8" width="2.3" height="6.4" rx="1.15" fill="#fff"/><circle cx="12" cy="17.1" r="1.35" fill="#fff"/></svg><strong>Urgent can trick</strong>
  <svg class="coach-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.2 4.4 5.3v5.8c0 4.9 3.2 8.5 7.6 10.5 4.4-2 7.6-5.6 7.6-10.5V5.3L12 2.2Z" fill="#aee3bd"/><path d="M12 3.9 6 6.4v4.7c0 3.9 2.6 7 6 8.6 3.4-1.6 6-4.7 6-8.6V6.4L12 3.9Z" fill="#28a745"/><path d="m8.7 12 2.3 2.3 4.4-4.6" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg><strong>Check before trust</strong>
`;

// Screen-3 Safety Coach (bell / clock / chain).
const COACH_SELECT = `
  <svg class="coach-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.6c-.7 0-1.2.5-1.2 1.2v.5A5.5 5.5 0 0 0 6.5 10c0 4-1.8 5-1.8 6.6 0 .5.4.9.9.9h12.8c.5 0 .9-.4.9-.9 0-1.6-1.8-2.6-1.8-6.6a5.5 5.5 0 0 0-4.3-5.7v-.5c0-.7-.5-1.2-1.2-1.2Z" fill="#ef5b3b"/><path d="M9.8 19.2a2.3 2.3 0 0 0 4.4 0" stroke="#ef5b3b" stroke-width="1.8" stroke-linecap="round"/><path d="M3.6 8.2C4 6.8 4.8 5.6 5.9 4.7M20.4 8.2c-.4-1.4-1.2-2.6-2.3-3.5" stroke="#f6a13a" stroke-width="1.6" stroke-linecap="round"/></svg><strong>Urgent words create panic</strong>
  <svg class="coach-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12.5" r="8.4" fill="none" stroke="#7c3aed" stroke-width="2"/><path d="M12 7.6v5l3.4 2" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><strong>Deadlines add pressure</strong>
  <svg class="coach-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9.2 14.8 14.8 9.2M8.6 11 6.7 12.9a3.3 3.3 0 0 0 4.7 4.7L13.3 15.7M15.4 13l1.9-1.9a3.3 3.3 0 0 0-4.7-4.7L10.7 8.3" stroke="#2f6fe0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><strong>Strange links can trick you</strong>
`;

// Screen-5 (explanation) + End Safety Coach — the safe action: stop, check the
// real app/website, ask a trusted adult. (Ported from Activity 1's safe-action.)
const COACH_SAFE = `
  <svg class="coach-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8.2 2.8h7.6L21.2 8.2v7.6L15.8 21.2H8.2L2.8 15.8V8.2L8.2 2.8Z" fill="#ef5b3b"/><rect x="10.85" y="7.4" width="2.3" height="6.4" rx="1.15" fill="#fff"/><circle cx="12" cy="16.6" r="1.35" fill="#fff"/></svg><strong>Stop, don't rush</strong>
  <svg class="coach-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.2 4.4 5.3v5.8c0 4.9 3.2 8.5 7.6 10.5 4.4-2 7.6-5.6 7.6-10.5V5.3L12 2.2Z" fill="#aee3bd"/><path d="M12 3.9 6 6.4v4.7c0 3.9 2.6 7 6 8.6 3.4-1.6 6-4.7 6-8.6V6.4L12 3.9Z" fill="#28a745"/><path d="m8.7 12 2.3 2.3 4.4-4.6" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg><strong>Check the real app</strong>
  <svg class="coach-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="8.6" cy="9.2" r="3" fill="#2f6fe0"/><circle cx="16" cy="10" r="2.5" fill="#7c3aed"/><path d="M3.4 18.4c.5-2.9 2.7-4.6 5.2-4.6s4.7 1.7 5.2 4.6z" fill="#2f6fe0"/><path d="M14.4 18.4c.3-2 1.7-3.4 3.6-3.4 1.7 0 3.1 1.1 3.6 3.4z" fill="#7c3aed"/></svg><strong>Ask a trusted adult</strong>
`;

function renderClassifyActivity(activity) {
    const answeredCount = Object.keys(state.classifications).length;
    const statusTimes = ['10:15', '10:22', '10:29'];

  const items = activity.items.map((item, index) => {
    const picked = state.classifications[index];
    const answeredCorrectly = picked && picked === item.answer;
    const answeredWrongly = picked && picked !== item.answer;
    const realResultClass = picked === 'real' ? (item.answer === 'real' ? 'selected good' : 'selected bad') : '';
    const scamResultClass = picked === 'scam' ? (item.answer === 'scam' ? 'selected good' : 'selected bad') : '';
    const realEffectClass = getAnswerEffectClass(`classify:${index}:real`, realResultClass);
    const scamEffectClass = getAnswerEffectClass(`classify:${index}:scam`, scamResultClass);
    const realButtonClass = ['button-2', realResultClass, realEffectClass].filter(Boolean).join(' ');
    const scamButtonClass = ['button-2', scamResultClass, scamEffectClass].filter(Boolean).join(' ');
    const disabledAttribute = picked ? ' disabled aria-disabled="true"' : '';
    const appTitle = t(item.app === 'whatsapp' ? 'appWhatsApp' : item.app === 'popup' ? 'appBrowser' : 'appInstagramDm');
    const screenBody = item.app === 'whatsapp'
      ? `
          <div class="wa-notice">Messages and calls are end-to-end encrypted. No one outside this chat can read or listen to them.</div>
          <div class="wa-message"><small>Forwarded</small><p>${escapeHtml(item.message)}</p></div>
          <div class="wa-input"><span>Type a message</span><b></b></div>
        `
      : item.app === 'popup'
        ? `
          <div class="popup-card">
            <span class="popup-gift" aria-hidden="true"></span>
            <strong>Congratulations!</strong>
            <p>${escapeHtml(item.message.replace('Congratulations! ', ''))}</p>
          </div>
        `
        : `
          <div class="dm-profile"><strong>${escapeHtml(item.from)}</strong><span>Active now</span></div>
          <div class="dm-time">Today 10:28 AM</div>
          <div class="dm-message">${escapeHtml(item.message)}</div>
          <div class="dm-input"><span>Message...</span></div>
        `;
    return `
      <article class="phone-choice ${item.app} ${answeredCorrectly ? 'answered good' : ''}${answeredWrongly ? ' answered bad' : ''}">
        <div class="mock-phone">
          <span class="mock-phone-side-buttons" aria-hidden="true"></span>
          <div class="mock-status"><span>${statusTimes[index] || `10:${15 + index * 7}`}</span><span>4G</span></div>
          <div class="mock-appbar">${escapeHtml(item.app === 'popup' ? 'bestdeals-now.com' : appTitle)}</div>
          <div class="mock-screen-body">${screenBody}</div>
        </div>
        <div class="classify-actions">
          <button type="button" class="${realButtonClass}" role="button" data-classify="${index}" data-value="real"${disabledAttribute}><span class="text">${escapeHtml(t('realButton'))}</span></button>
          <button type="button" class="${scamButtonClass}" role="button" data-classify="${index}" data-value="scam"${disabledAttribute}><span class="text">${escapeHtml(t('scamButton'))}</span></button>
        </div>
      </article>
    `;
  }).join('');

  ui.host.innerHTML = `
    <section class="scam-game activity-stage ${state.reaction === 'bad' ? 'is-wrong' : ''}">
      <div class="activity-panel ${state.reaction}">
        <header class="mobile-mission-banner">
          <span class="mission-bubble" aria-hidden="true"></span>
          <div><strong>${accentLastWord(activity.title)}</strong><small>${escapeHtml(activity.instruction)}</small></div>
        </header>
        <div class="mobile-screen-progress">
          <strong>Screen ${answeredCount}/${activity.items.length}</strong>
          <span class="mobile-progress-dots" aria-hidden="true">
            ${Array.from({ length: activity.items.length }, (_, index) => `<i class="${index < answeredCount ? 'done' : ''}"></i>`).join('')}
          </span>
        </div>
        <div class="classify-grid">${items}</div>
      </div>
    </section>
  `;

  ui.host.querySelectorAll('[data-classify]').forEach((button) => {
    button.addEventListener('click', () => {
      const classifyIndex = button.dataset.classify;
      if (state.classifications[classifyIndex]) return;
      state.classifications[classifyIndex] = button.dataset.value;
      const item = activity.items[Number(classifyIndex)];
      const effectKey = `classify:${classifyIndex}:${button.dataset.value}`;
      if (button.dataset.value === item.answer) {
        if (isActivityCorrect(activity)) {
          setFeedback(`${t('correct')} ${activity.coach}`, 'good', effectKey);
        } else {
          setFeedback(item.flag, 'good', effectKey);
        }
      } else {
        setFeedback(getItemWrongFeedback(item, activity), 'bad', effectKey);
      }
      renderGame();
    });
  });
}

function renderFeedback() {
  if (!state.feedback) return '';
  return `<div class="activity-feedback ${state.feedback.includes('Correct') ? 'good' : 'bad'}">${escapeHtml(state.feedback)}</div>`;
}

function checkActivity() {
  const activity = getCurrentActivity();
  let correct = false;

  if (activity.type === 'single') {
    correct = state.selected.has(activity.correct);
  } else if (activity.type === 'multi') {
    correct = activity.correct.length === state.selected.size && activity.correct.every((index) => state.selected.has(index));
  } else {
    correct = activity.items.every((item, index) => state.classifications[index] === item.answer);
  }

  const hasAnswer = activity.type === 'classify'
    ? Object.keys(state.classifications).length === activity.items.length
    : state.selected.size > 0;

  if (!hasAnswer) {
    showToast(t('chooseAnswer'));
    return;
  }

  state.feedback = correct ? `${t('correct')} ${activity.coach}` : getActivityWrongFeedback(activity);
  renderGame();
}

function updateChrome() {
  const scene = scenes[state.sceneIndex] || scenes[0];
  const activity = getCurrentActivity();
  const isMythFact = state.phase === 'activity' && activity.type === 'mythFact';
  document.title = t('appTitle');
  document.documentElement.lang = currentLanguage;
  if (ui.moduleLabel) ui.moduleLabel.innerHTML = accentLastWord(t('moduleLabel'));
  ui.title.innerHTML = accentLastWord(isMythFact ? t('mythTitle') : state.phase === 'activity' ? activity.title : t('title'));
  ui.subtitle.textContent = state.phase === 'intro'
    ? t('subtitle')
    : isMythFact
      ? t('mythSubtitle')
      : state.phase === 'activity'
        ? activity.instruction
        : scene.title;
  ui.coachEyebrow.textContent = t('coachTitle');
  const activityCoach = isMythFact
    ? t('mythCoach')
    : activity.type === 'quizSet'
      ? t('quizCoach')
      : `${activity.coach} ${t('tried')}`;
  ui.coach.textContent = state.phase === 'activity' ? activityCoach : t('coach');
  if (ui.feedbackCard && ui.feedbackText) {
    ui.feedbackCard.hidden = !state.feedback;
    ui.feedbackText.textContent = state.feedback;
    ui.feedbackCard.classList.toggle('feedback-good', state.feedbackKind === 'good');
    ui.feedbackCard.classList.toggle('feedback-bad', state.feedbackKind === 'bad');
  }
  ui.canvasTitle.textContent = isMythFact ? t('mythStage') : state.phase === 'activity' ? t('activityCanvas') : t('boardTitle');
  if (state.phase === 'activity' && activity.id === 'activity-1') {
    ui.canvasTitle.textContent = t('bubbleArena');
  } else if (state.phase === 'activity' && activity.id === 'q3-pay-first') {
    ui.canvasTitle.textContent = t('sortArena');
  }
  ui.sideProgress.hidden = state.phase === 'intro';
  ui.sideProgress.textContent = state.phase === 'intro'
    ? ''
    : isMythFact
      ? t('countOf', { current: state.mythIndex + 1, total: activity.myths.length })
      : t('stepPoints', { step: Math.max(state.step, 1), total: GAME_STEPS, points: state.points });
  updateStaticText();
  updateProgressDots(state.step);
  updateMobileProgressDots();
}

function renderGame() {
  updateChrome();

  if (state.phase === 'intro') {
    ui.host.innerHTML = `
      <section class="scam-game intro-stage">
        <div class="intro-copy mission-intro-banner">
          <span class="mission-bubble" aria-hidden="true"></span>
          <div class="mission-intro-text">
            <span>${escapeHtml(t('introKicker'))}</span>
            <h3>${escapeHtml(t('introTitle'))}</h3>
            <p>${escapeHtml(t('introBody'))}</p>
          </div>
        </div>
        <div class="cast-row">
          ${Object.values(characters).map((person) => `
            <div class="cast-card">
              <img src="${person.image}" alt="${person.name}">
              <strong>${person.name}</strong>
            </div>
          `).join('')}
        </div>
      </section>
    `;
    setFooterButtons([{ label: t('start'), onClick: () => startScene(0) }]);
    return;
  }

  if (state.phase === 'scene') {
    const scene = scenes[state.sceneIndex];
    renderScene(scene);
    const complete = state.preludeDone && state.revealedLineCount >= scene.lines.length && !state.speaking;
    setFooterButtons([
      { label: complete ? t('activity') : t('sceneLocked'), disabled: !complete, onClick: goToActivity }
    ]);
    return;
  }

  if (state.phase === 'activity') {
    const activity = getCurrentActivity();
    renderActivity(activity);
    if (activity.type === 'quizSet') {
      const questions = getQuizFrameQuestions(activity);
      const isLastQuestion = state.quizQuestionIndex >= questions.length - 1;
      setFooterButtons([
        { label: isLastQuestion ? t('continue') : t('continue'), disabled: !hasActivityAttempt(activity), onClick: goToNextQuizFrame }
      ]);
      return;
    }
    if (activity.type === 'mythFact') {
      const isLastMyth = state.mythIndex >= activity.myths.length - 1;
      setFooterButtons([
        { label: isLastMyth ? t('continue') : t('nextMyth'), disabled: !hasActivityAttempt(activity), onClick: goToNextMythFrame }
      ]);
      return;
    }
    if (activity.type === 'infoPage') {
      // Intro screen has no Continue button — tapping the notification advances.
      setFooterButtons([]);
      return;
    }
    setFooterButtons([
      {
        label: t('continue'),
        disabled: !hasActivityAttempt(activity),
        onClick: goNextActivityOrScene
      }
    ]);
    return;
  }

  const learnedCards = [
    [
      './assets/images/sorting-icons/shield.webp',
      'Panic Words',
      'Urgent words create panic',
      'Don&rsquo;t let them rush you'
    ],
    [
      './assets/images/sorting-icons/shield.webp',
      'Threats and Deadlines',
      'Threats and short deadlines add pressure',
      'Take time to verify'
    ],
    [
      './assets/images/sorting-icons/globe.webp',
      'Strange Links',
      'Check links before you trust them',
      'Look for red flags'
    ]
  ];
  const finalClassifyActivity = activities.find((activity) => activity.type === 'classify');
  const finalScreensTotal = finalClassifyActivity?.items?.length || 3;
  const finalScreensCorrect = finalClassifyActivity?.items
    ? finalClassifyActivity.items.reduce((count, item, index) => (
      state.classifications[index] === item.answer ? count + 1 : count
    ), 0)
    : 0;
  const confetti = Array.from({ length: 34 }, (_, index) => `
    <i class="final-confetti ${index % 8 === 0 ? 'confetti-star' : ''}" aria-hidden="true"
      style="--x:${(index * 29) % 98}%; --delay:${(index % 9) * -0.38}s; --dur:${3.3 + (index % 6) * 0.34}s; --spin:${80 + (index % 7) * 54}deg;"></i>
  `).join('');

  ui.host.innerHTML = `
    <section class="scam-game activity-stage">
      <div class="final-confetti-layer" aria-hidden="true">${confetti}</div>
      <aside class="final-side-panel">
        <section class="final-side-mission-card">
          <img src="./assets/images/sorting-final-icons/mission-shield.webp" alt="">
          <strong>Mission<br><em>Complete!</em></strong>
          <span>You made smart choices online!</span>
        </section>
        <section class="final-found-card">
          <img class="final-target-icon" src="./assets/images/sorting-final-icons/target.webp" alt="">
          <div>
            <strong>Screens Correct</strong>
            <b>${finalScreensCorrect} / ${finalScreensTotal}</b>
            <span>Great work!</span>
          </div>
        </section>
        <div class="sidebar-motto"><span aria-hidden="true"></span> Be <b>Smart.</b> Be <b>Safe.</b> Be <b>Secure.</b></div>
      </aside>
      <main class="final-board">
        <header class="final-heading">
          <h3><span>Great Job,</span> <em class="final-heading-name">Avi</em>!</h3>
          <p>You found the pressure words and fake-link clues that phishing messages use to rush people.</p>
        </header>
        <div class="final-hero-row">
          <img class="final-simran" src="./assets/images/avi/avi_screen1.webp" alt="Avi giving a thumbs up">
          <img class="final-shield" src="./assets/images/final badge.webp" alt="Safety shield badge">
          <img class="final-scam-trash" src="./assets/images/sorting-final-icons/clipboard.webp" alt="Scam messages stopped">
        </div>
        <section class="final-spotted-panel">
          <strong class="final-spotted-ribbon">Here&rsquo;s What You <em>Learned:</em></strong>
          <div class="final-spotted-grid">
            ${learnedCards.map(([icon, title, verdict, detail]) => `
              <article class="final-clue-card">
                <img src="${icon}" alt="">
                <strong>${title}</strong>
                <em>${verdict}</em>
                <span>${detail}</span>
              </article>
            `).join('')}
          </div>
        </section>
        <button class="final-play-again" type="button">&#8635; <span>${escapeHtml(t('playAgain'))}</span></button>
      </main>
    </section>
  `;
  ui.coach.textContent = t('complete');
  setFooterButtons([]);
  ui.host.querySelector('.final-play-again').addEventListener('click', restartGame);
}

function updateStaticText() {
  document.querySelector('[data-i18n="rotateTitle"]').textContent = t('rotateTitle');
  document.querySelector('[data-i18n="rotateMessage"]').textContent = t('rotateMessage');
  document.getElementById('langPopupTitle').textContent = t('languageTitle');
  document.getElementById('langPopupSubtitle').textContent = t('languageSubtitle');
  document.getElementById('langCancelBtn').textContent = t('cancel');
  document.getElementById('langApplyBtn').textContent = t('apply');
  document.getElementById('langSelectedTitle').textContent = t('languageSelectedTitle');
  document.getElementById('langSelectedMessageEnd').textContent = t('languageSelectedEnd');
  syncMuteIconState();
  syncFullscreenState();
}

function setupLanguageSwitcher() {
  const overlay = document.getElementById('languagePopupOverlay');
  const trigger = document.getElementById('customSelectTrigger');
  const selectedText = document.getElementById('selectedLangText');
  const options = document.getElementById('customSelectOptions');
  const applyBtn = document.getElementById('langApplyBtn');
  const cancelBtn = document.getElementById('langCancelBtn');
  const closeBtn = document.getElementById('langPopupCloseBtn');
  const mainPanel = document.getElementById('langMainPanel');
  const confirmPanel = document.getElementById('langConfirmPanel');
  const popup = document.getElementById('languagePopup');
  let pendingLanguage = currentLanguage;

  const toggleDropdown = (open) => {
    const nextOpen = typeof open === 'boolean' ? open : !trigger.classList.contains('open');
    trigger.classList.toggle('open', nextOpen);
    options.classList.toggle('open', nextOpen);
    trigger.setAttribute('aria-expanded', String(nextOpen));
  };

  const populateOptions = () => {
    options.innerHTML = '';
    selectedText.textContent = supportedLanguages[pendingLanguage] || supportedLanguages.en;
    Object.entries(supportedLanguages).forEach(([code, name]) => {
      const option = document.createElement('div');
      option.className = 'custom-select-option';
      option.dataset.lang = code;
      option.textContent = name;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(code === pendingLanguage));
      option.classList.toggle('selected', code === pendingLanguage);
      option.addEventListener('click', () => {
        pendingLanguage = code;
        selectedText.textContent = name;
        applyBtn.disabled = pendingLanguage === currentLanguage;
        populateOptions();
        toggleDropdown(false);
      });
      options.appendChild(option);
    });
  };

  const closePopup = () => {
    popup.classList.remove('confirm-only');
    toggleDropdown(false);
    overlay.style.display = 'none';
  };

  ui.langBtn.addEventListener('click', () => {
    pendingLanguage = currentLanguage;
    applyBtn.disabled = true;
    mainPanel.hidden = false;
    confirmPanel.hidden = true;
    confirmPanel.classList.remove('show');
    popup.classList.remove('confirm-only');
    populateOptions();
    overlay.style.display = 'flex';
  });

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDropdown();
  });
  cancelBtn.addEventListener('click', closePopup);
  closeBtn.addEventListener('click', closePopup);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closePopup();
  });
  applyBtn.addEventListener('click', () => {
    if (pendingLanguage === currentLanguage) {
      overlay.style.display = 'none';
      return;
    }
    if (typeof cancelVoice === 'function') cancelVoice();
    currentLanguage = pendingLanguage;
    applyLocaleContent();
    localStorage.setItem('digital_safety_language', currentLanguage);
    renderGame();
    document.getElementById('langSelectedMessageStart').textContent = t('languageSelectedStart', {
      language: supportedLanguages[currentLanguage]
    });
    mainPanel.hidden = true;
    confirmPanel.hidden = false;
    confirmPanel.classList.add('show');
    popup.classList.add('confirm-only');
    window.setTimeout(closePopup, 2000);
  });
}

function syncMuteIconState() {
  const onIcon = ui.muteBtn.querySelector('.mute-on-icon');
  const offIcon = ui.muteBtn.querySelector('.mute-off-icon');
  ui.muteBtn.classList.toggle('is-muted', state.muted);
  ui.muteBtn.title = state.muted ? t('muted') : t('unmuted');
  ui.muteBtn.setAttribute('aria-label', state.muted ? t('muted') : t('unmuted'));
  if (onIcon) onIcon.style.display = state.muted ? 'none' : 'block';
  if (offIcon) offIcon.style.display = state.muted ? 'block' : 'none';
}

function syncFullscreenState() {
  const btn = document.getElementById('fullscreenBtn');
  const enterIcon = btn.querySelector('.fullscreen-enter-icon');
  const exitIcon = btn.querySelector('.fullscreen-exit-icon');
  const active = Boolean(document.fullscreenElement);
  btn.classList.toggle('is-fullscreen', active);
  // Drive the fullscreen-only layout overrides (see game.css "is-browser-fullscreen"
  // block). Windowed has no class, so the windowed layout stays exactly as-is.
  document.body.classList.toggle('is-browser-fullscreen', active);
  btn.title = active ? t('exitFullscreen') : t('enterFullscreen');
  btn.setAttribute('aria-label', active ? t('exitFullscreen') : t('enterFullscreen'));
  if (enterIcon) enterIcon.style.display = active ? 'none' : 'block';
  if (exitIcon) exitIcon.style.display = active ? 'block' : 'none';
}

function setupControls() {
  ui.muteBtn.addEventListener('click', () => {
    // Mute = drop every clip to volume 0 in place (keep playing); unmute =
    // restore the prior volume. No pausing or restarting.
    state.muted = !state.muted;
    applyAudioMuteAll();
    playSfx('click');
    syncMuteIconState();
  });
  document.getElementById('resetGameBtn').addEventListener('click', restartGame);
  document.getElementById('fullscreenBtn').addEventListener('click', async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen?.();
    } else {
      await document.documentElement.requestFullscreen?.();
    }
    syncFullscreenState();
  });
  document.addEventListener('fullscreenchange', syncFullscreenState);
}

// Images the game shows across its screens, preloaded before the "Tap to Play"
// gate becomes clickable so nothing pops in mid-play.
const GAME_IMAGE_ASSETS = [
  './assets/images/loader.gif',
  './assets/images/logo.webp',
  './assets/images/phone.webp',
  './assets/images/notification.webp',
  './assets/images/avi/avi_screen1.webp',
  './assets/images/avi/avi_screen2.webp',
  './assets/images/avi/avi_screen3.webp',
  './assets/images/avi/avi_screen4.webp',
  './assets/images/avi/avi_screen5.webp',
  './assets/images/avi/avi_end_screen.webp',
  './assets/images/badge.webp',
  './assets/images/final badge.webp',
  './assets/images/sorting-final-icons/clipboard.webp',
  './assets/images/sorting-final-icons/mission-shield.webp',
  './assets/images/sorting-final-icons/target.webp'
];

function preloadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = src;
  });
}

function preloadAudioReady(audio) {
  return new Promise((resolve) => {
    if (!audio || audio.readyState >= 3) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    audio.addEventListener('canplaythrough', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });
    audio.load();
    window.setTimeout(finish, 5000);
  });
}

// Resolves once the game's visible assets (images, fonts, intro audio) are
// ready, so the "Tap to Play" gate only becomes clickable after everything
// has loaded.
async function waitForGameAssets() {
  const tasks = GAME_IMAGE_ASSETS.map(preloadImage);
  if (document.fonts && document.fonts.ready) {
    tasks.push(document.fonts.ready.catch(() => {}));
  }
  tasks.push(preloadAudioReady(sfx.firstPageInstruction));
  tasks.push(preloadAudioReady(screenVoice));
  await Promise.all(tasks);
}

async function initialize() {
  setStartupGateLoading();
  const savedLanguage = localStorage.getItem('digital_safety_language') || initialLang;
  if (savedLanguage && supportedLanguages[savedLanguage]) {
    currentLanguage = savedLanguage;
  }
  sfx.firstPageInstruction.load();
  await loadLocaleContent();
  buildProgressDots();
  updateGameWithCircles();
  setupControls();
  setupLanguageSwitcher();
  renderGame();
  // Keep the loader spinner up and non-clickable until the game's assets have
  // finished loading; only then reveal the clickable "Tap to Play" gate.
  await waitForGameAssets();
  activateStartupGate(() => {
    startAnalyticsRun();
    // The "Tap to Play" tap is the audio-unlocking gesture: mark voice activated
    // and re-render so Screen 1 plays its voiceover.
    state.voiceActivated = true;
    renderGame();
  });
}

// Pause any audio that is playing when the tab is hidden, and resume the very
// same clips (from where they left off) when the tab becomes visible again.
let audioPausedForHiddenTab = [];

function pauseAudioForHiddenTab() {
  audioPausedForHiddenTab = [];
  const clips = [...Object.values(sfx), screenVoice, activeAudio];
  clips.forEach((audio) => {
    if (audio && !audio.paused && !audio.ended) {
      audioPausedForHiddenTab.push(audio);
      audio.pause();
    }
  });
}

function resumeAudioForVisibleTab() {
  const clips = audioPausedForHiddenTab;
  audioPausedForHiddenTab = [];
  clips.forEach((audio) => {
    if (audio && audio.paused && !audio.ended) {
      audio.play().catch(() => {});
    }
  });
}

window.addEventListener('beforeunload', cancelVoice);
// NOTE: visibilitychange only pauses/resumes the audio in place — it must NOT
// re-trigger the intro voiceover or re-render the game (that used to bounce
// the user back to Screen 1 on tab switch). The current screen stays put.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pauseAudioForHiddenTab();
  } else {
    resumeAudioForVisibleTab();
  }
});
window.addEventListener('load', initialize);
