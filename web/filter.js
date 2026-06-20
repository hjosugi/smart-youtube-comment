(() => {
  "use strict";

  // NG-user / NG-word filter. Designed for MANY entries while staying light:
  //   * NG users  -> a Set (O(1) exact author match)
  //   * NG words  -> an Aho-Corasick automaton: built once from all words, then
  //                  each comment is scanned in O(text length) no matter how many
  //                  words are registered. That is the whole point — adding more
  //                  words does not slow down per-comment matching.
  // Lists live in chrome.storage.local (~5MB) so thousands of entries fit.
  // Classic script (export-free) so Chrome can load it as a content script;
  // consumers read globalThis.SYCFilter.

  const STORAGE_KEY = "syc:filter";

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
  let automaton = null;
  let lists = { users: [], words: [] };

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
    automaton = buildAutomaton(lists.words);
  }

  function apply(raw) {
    lists = {
      users: cleanList(raw && raw.users),
      words: cleanList(raw && raw.words)
    };
    rebuild();
  }

  // The hot path — called per comment at extraction time.
  function shouldDrop(author, text) {
    if (userSet.size && userSet.has(norm(author))) return true;
    if (automaton && automatonMatches(automaton, norm(text))) return true;
    return false;
  }

  async function load() {
    const area = localArea();
    if (area) {
      try {
        const got = await area.get(STORAGE_KEY);
        apply(got && got[STORAGE_KEY]);
      } catch {
        apply(null);
      }
    }
    return lists;
  }

  async function save(next) {
    apply(next);
    const area = localArea();
    if (area) await area.set({ [STORAGE_KEY]: lists });
    return lists;
  }

  function onChange(callback) {
    if (typeof chrome === "undefined" || !chrome.storage) return;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[STORAGE_KEY]) {
        apply(changes[STORAGE_KEY].newValue);
        callback?.(lists);
      }
    });
  }

  globalThis.SYCFilter = {
    STORAGE_KEY,
    PRESETS,
    load,
    save,
    onChange,
    shouldDrop,
    cleanList,
    get lists() { return lists; },
    stats() { return { users: userSet.size, words: lists.words.length, nodes: automaton ? automaton.out.length : 0 }; }
  };
})();
