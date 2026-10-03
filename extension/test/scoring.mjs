// Scorer behaviour (extension/scoring.js; web/scoring.js is byte-identical).
// The rules are explained in docs/SCORING.md.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const sandbox = {}
sandbox.globalThis = sandbox
runInNewContext(readFileSync(new URL("../scoring.js", import.meta.url), "utf8"), sandbox, {
  filename: "extension/scoring.js",
})
const S = sandbox.SYCScoring
const { FAST, NORMAL, SLOW } = S.TIER
let assertions = 0
const eq = (actual, expected, message) => {
  assert.equal(actual, expected, message)
  assertions++
}

const fresh = () => S.createFallbackScorer()
const tierOf = (input, scorer = fresh()) => scorer.score(input).tier
const emojiImage = name => ({ u: "https://yt3.ggpht.com/emoji", a: name })

// 1. Emoji count once each; a custom emoji's alt text (its name) is not read.
const customRun = {
  text: "スバルさいなりうむあひるスバルさいなりうむあひるスバルさいなりうむあひる",
  parts: [1, 2, 3].map(() => emojiImage("スバルさいなりうむあひる")),
}
eq(S.visibleLength(customRun.text, customRun.parts), 3, "three emoji images are three characters")
eq(tierOf(customRun), FAST, "a run of custom emoji is fast, whatever their names")
eq(tierOf("👏👏👏👏👏"), FAST, "a run of Unicode emoji is fast")
eq(tierOf({ text: "かわいい", parts: [{ t: "かわいい" }, emojiImage(":heart:")] }), FAST, "a short word plus emoji is a reaction")

// 2. Nothing is dropped by the scorer.
for (const text of ["草", "おお", "いいね", "w", "👏👏👏", "88888888"]) {
  const result = fresh().score(text)
  eq(result.show, true, `${text} is shown`)
  eq(S.buildRenderPlan(text, result) !== null, true, `${text} gets a render plan`)
}
eq(fresh().score("").show, false, "only an empty comment has nothing to show")

// 3. Reactions are fast; ordinary text normal; long text slow.
for (const text of ["草", "おお", "lol", "nice play", "wwwwwwww", "ｗｗｗｗ", "草草草草草", "8888888"]) {
  eq(tierOf(text), FAST, `${text} is a reaction`)
}
for (const text of ["おつかれさまです", "what song is this", "聞こえてますよ配信お疲れ様です"]) {
  eq(tierOf(text), NORMAL, `${text} is normal`)
}
eq(tierOf("中利夫（なか としお）…昭和の頃に在籍した中日の外野手。俊足巧打で理想的なアベレージヒッター。"), SLOW, "long Japanese text is slow")
eq(tierOf("thanks for the explanation that really helped me understand it"), SLOW, "long English text is slow")
eq(tierOf("without spoiling anything, the next arc is going to be great for everyone watching"), SLOW, "a long sentence is not mistaken for a repeat")

// 4. A copy of a comment posted moments ago is a reaction; first posts are not.
{
  const scorer = fresh()
  eq(scorer.score("今日の配信めっちゃ楽しかった").tier, NORMAL, "the first post is normal")
  const copy = scorer.score("今日の配信めっちゃ楽しかった！")
  eq(copy.tier, FAST, "a near-identical repost is fast")
  eq(copy.reasons.includes("copy"), true, "the repost is marked as a copy")
}

// 5. Deterministic: unrelated history does not change a comment's tier.
{
  const target = "このステージの攻略ルートって前回と同じ？"
  const expected = tierOf(target)
  const scorer = fresh()
  for (let i = 0; i < 200; i++) scorer.score(`unrelated message number ${i} about topic ${i * 7}`)
  eq(scorer.score(target).tier, expected, "200 unrelated comments do not change the tier")
}

// 6. Quality ranks informative text above reactions.
{
  const long = fresh().score("thanks for the explanation that really helped me understand it").quality
  const short = fresh().score("草").quality
  const repeat = fresh().score("wwwwwwwwww").quality
  eq(long > short && short > repeat, true, "long text > short reaction > repeated characters")
}

// 7. Signatures for the renderer's near-duplicate drop measure closeness.
{
  const d = (a, b) => S.signatureDistance(S.textSignature(a), S.textSignature(b))
  eq(d("Ｆｏｏ　BAR!!!", "foo bar"), 0, "width, case, spacing and punctuation are ignored")
  eq(d("草草草", "草草草草"), 0, "the same run of characters has the same signature")
  eq(d("今日の配信めっちゃ楽しかった", "今日の配信めっちゃ楽しかった！！") <= 3, true, "a near-duplicate is within the default strictness")
  eq(d("今日の配信めっちゃ楽しかった", "what song is this") > 3, true, "unrelated comments are far apart")
}

// 8. buildRenderPlan honours the scorer's tier.
{
  const plan = S.buildRenderPlan("x", { tier: SLOW, quality: 0.9, emphasis: 0.7, show: true })
  eq(plan.tier, SLOW, "the scorer's tier is kept")
  eq(plan.durationMs, S.FALLBACK_DURATIONS[SLOW], "the tier's fallback duration fills in")
}

console.log(`scoring ok (${assertions} assertions)`)
