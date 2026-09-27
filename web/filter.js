(() => {
  "use strict";

  // NG-user / NG-word filter. Designed for MANY entries while staying light:
  //   * NG users/channels -> Sets (O(1) exact author/channel match)
  //   * NG words  -> an Aho-Corasick automaton: built once from all words, then
  //                  each comment is scanned in O(text length) no matter how many
  //                  words are registered. That is the whole point — adding more
  //                  words does not slow down per-comment matching.
  // Lists live in chrome.storage.local (~5MB) so thousands of entries fit.
  // Classic script (export-free) so Chrome can load it as a content script;
  // consumers read globalThis.SYCFilter.

  const STORAGE_KEY = "syc:filter";
  const MAX_REGEX_RULES = 64;
  const MAX_REGEX_SOURCE_LENGTH = 160;
  const REGEX_BUDGET_MS = 2;
  const MODES = ["drop", "censor", "replace"];
  const DEFAULT_MODE = "drop";
  const DEFAULT_REPLACEMENT = "＊";
  const MAX_REPLACEMENT_LENGTH = 8;

  // Optional starter presets the options UI can offer. NONE are applied by
  // default — the user opts in. Keep these generic and small.
  const PRESETS = {
    "spam-basic": {
      label: "Common spam",
      words: ["t.me/", "discord.gg/", "bit.ly/", "free nitro", "check my profile", "私のプロフィール"]
    },
    "emote-spam": {
      label: "Emote/letter spam",
      words: ["wwwwwww", "aaaaaaa", "8888888", "草草草草"]
    }
  };

  let userSet = new Set();
  let channelSet = new Set();
  let automaton = null;
  let regexRules = [];
  let masker = null;
  let mode = DEFAULT_MODE;
  let replacement = DEFAULT_REPLACEMENT;
  let lists = { users: [], words: [], channels: [] };

  function localArea() {
    if (typeof chrome === "undefined" || !chrome.storage) return null;
    return chrome.storage.local;
  }

  function norm(value) {
    return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  }

  // De-dupe, normalize, drop empties. Accepts an array or a newline string.
  function cleanList(input) {
    const arr = Array.isArray(input)
      ? input
      : String(input || "").split("\n");
    return [...new Set(arr.map(norm).filter(Boolean))];
  }

  function normChannelId(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, "").trim();
  }

  function cleanChannelList(input) {
    const arr = Array.isArray(input)
      ? input
      : String(input || "").split("\n");
    return [...new Set(arr.map(normChannelId).filter(Boolean))];
  }

  function cleanWordList(input) {
    const arr = Array.isArray(input)
      ? input
      : String(input || "").split("\n");
    return [...new Set(arr.map(cleanWordEntry).filter(Boolean))];
  }

  function cleanWordEntry(value) {
    const raw = String(value || "").normalize("NFKC").trim();
    if (!raw) return "";
    return parseRegexEntry(raw) ? raw : norm(raw);
  }

  function parseRegexEntry(value) {
    const match = String(value || "").match(/^\/(.+)\/([imsu]*)$/);
    if (!match) return null;
    const [, source, flags] = match;
    if (!source || source.length > MAX_REGEX_SOURCE_LENGTH) return null;
    try {
      return new RegExp(source, flags);
    } catch {
      return null;
    }
  }

  // --- Aho-Corasick over Unicode code points -------------------------------
  function buildAutomaton(words) {
    if (!words.length) return null;
    const next = [new Map()]; // node -> Map(char -> node)
    const fail = [0];
    const out = [false];

    for (const word of words) {
      let node = 0;
      for (const ch of word) { // for..of iterates code points
        let nx = next[node].get(ch);
        if (nx === undefined) {
          nx = next.length;
          next.push(new Map());
          fail.push(0);
          out.push(false);
          next[node].set(ch, nx);
        }
        node = nx;
      }
      out[node] = true;
    }

    // BFS to compute fail links + propagate outputs.
    const queue = [];
    for (const nx of next[0].values()) { fail[nx] = 0; queue.push(nx); }
    for (let qi = 0; qi < queue.length; qi++) {
      const node = queue[qi];
      for (const [ch, nx] of next[node]) {
        queue.push(nx);
        let f = fail[node];
        while (f !== 0 && !next[f].has(ch)) f = fail[f];
        const candidate = next[f].get(ch);
        fail[nx] = candidate !== undefined && candidate !== nx ? candidate : 0;
        if (out[fail[nx]]) out[nx] = true;
      }
    }
    return { next, fail, out };
  }

  function automatonMatches(ac, text) {
    let node = 0;
    for (const ch of text) {
      while (node !== 0 && !ac.next[node].has(ch)) node = ac.fail[node];
      node = ac.next[node].get(ch) ?? 0;
      if (ac.out[node]) return true;
    }
    return false;
  }

  function rebuild() {
    userSet = new Set(lists.users);
    channelSet = new Set(lists.channels);
    const fixedWords = [];
    regexRules = [];
    for (const word of lists.words) {
      const regex = regexRules.length < MAX_REGEX_RULES ? parseRegexEntry(word) : null;
      if (regex) regexRules.push(regex);
      else fixedWords.push(word);
    }
    automaton = buildAutomaton(fixedWords);
    masker = buildMasker();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // One combined pattern over the ORIGINAL text, used only by the censor/replace
  // modes and only after the fast Aho-Corasick path already found a match.
  function buildMasker() {
    if (!lists.words.length) return null;
    const parts = [];
    for (const word of lists.words) {
      const regex = parseRegexEntry(word);
      // Strip flags and force the ones needed for textual masking.
      parts.push(regex ? `(?:${regex.source})` : escapeRegExp(word));
    }
    try {
      return new RegExp(parts.join("|"), "gi");
    } catch {
      return null;
    }
  }

  function maskText(text) {
    if (!masker) return text;
    const fill = replacement || "*";
    masker.lastIndex = 0;
    if (mode === "replace") return text.replace(masker, fill);
    // censor: replace each matched run with the fill character, one per char.
    return text.replace(masker, (match) => fill.repeat([...match].length || 1));
  }

  function setState(raw) {
    lists = {
      users: cleanList(raw && raw.users),
      words: cleanWordList(raw && raw.words),
      channels: cleanChannelList(raw && raw.channels)
    };
    mode = MODES.includes(raw && raw.mode) ? raw.mode : DEFAULT_MODE;
    const rep = raw && typeof raw.replacement === "string" ? raw.replacement.slice(0, MAX_REPLACEMENT_LENGTH) : "";
    replacement = rep || DEFAULT_REPLACEMENT;
    rebuild();
  }

  // The hot path — called per comment at extraction time. Returns whether the
  // comment should be dropped, and the (possibly masked) text to display next.
  function apply(author, text, channelId) {
    const original = String(text || "");
    if (channelSet.size && channelSet.has(normChannelId(channelId))) return { drop: true, text: original };
    if (userSet.size && userSet.has(norm(author))) return { drop: true, text: original };
    const normalizedText = norm(original);
    const hit =
      (automaton && automatonMatches(automaton, normalizedText)) ||
      (regexRules.length > 0 && regexMatches(normalizedText));
    if (!hit) return { drop: false, text: original };
    if (mode === "drop") return { drop: true, text: original };
    return { drop: false, text: maskText(original) };
  }

  function shouldDrop(author, text, channelId) {
    return apply(author, text, channelId).drop;
  }

  function regexMatches(text) {
    const now = globalThis.performance?.now?.bind(globalThis.performance) || Date.now;
    const start = now();
    for (const regex of regexRules) {
      if (now() - start > REGEX_BUDGET_MS) return false;
      if (regex.test(text)) return true;
    }
    return false;
  }

  async function load() {
    const area = localArea();
    if (area) {
      try {
        const got = await area.get(STORAGE_KEY);
        setState(got && got[STORAGE_KEY]);
      } catch {
        setState(null);
      }
    }
    return lists;
  }

  async function save(next) {
    setState(next);
    const area = localArea();
    if (area) await area.set({ [STORAGE_KEY]: { ...lists, mode, replacement } });
    return lists;
  }

  function onChange(callback) {
    if (typeof chrome === "undefined" || !chrome.storage) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[STORAGE_KEY]) {
        setState(changes[STORAGE_KEY].newValue);
        callback?.(lists);
      }
    });
  }

  globalThis.SYCFilter = {
    STORAGE_KEY,
    MODES,
    PRESETS,
    load,
    save,
    onChange,
    apply,
    shouldDrop,
    cleanList,
    cleanChannelList,
    cleanWordList,
    get lists() { return lists; },
    get mode() { return mode; },
    get replacement() { return replacement; },
    stats() {
      return {
        users: userSet.size,
        channels: channelSet.size,
        words: lists.words.length,
        regexes: regexRules.length,
        nodes: automaton ? automaton.out.length : 0,
        mode
      };
    }
  };
})();
