/**
 * 効果音。
 *
 * 天鳳の音源そのものは著作物なので使わず、Web Audio API で合成する。
 * 牌の音は「硬い樹脂が卓のマットに当たる音」なので、
 *   減衰の速いノイズ (打面のアタック) + 低い正弦波 (卓に響く胴の音)
 * の重ね合わせで作ると近くなる。外部ファイルは一切読み込まない。
 */

let ctx: AudioContext | null = null
let master: GainNode | null = null
let enabled = true

const getCtx = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
  }
  // ユーザー操作前に作られた AudioContext は suspended のことがある。
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

export const setSoundEnabled = (v: boolean) => {
  enabled = v
}
export const isSoundEnabled = () => enabled

/**
 * 音を解錠する。必ずユーザー操作 (開始ボタンのクリック等) の中から呼ぶこと。
 * ブラウザは操作なしに音を鳴らすことを禁じており、操作外で作った AudioContext は
 * suspended のまま止まってしまう。
 */
export const unlockAudio = async (): Promise<void> => {
  const c = getCtx()
  if (!c) return
  if (c.state === 'suspended') {
    try {
      await c.resume()
    } catch {
      /* 解錠できなくても進行は止めない */
    }
  }
}

/** 減衰の速いノイズ。牌が当たる瞬間のアタックを作る。 */
const noiseBurst = (c: AudioContext, dest: AudioNode, dur: number, freq: number, q: number, gain: number, decay: number) => {
  const len = Math.max(1, Math.floor(c.sampleRate * dur))
  const buf = c.createBuffer(1, len, c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) {
    const t = i / len
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay)
  }
  const src = c.createBufferSource()
  src.buffer = buf
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = freq
  bp.Q.value = q
  const g = c.createGain()
  g.gain.value = gain
  src.connect(bp).connect(g).connect(dest)
  src.start()
  src.stop(c.currentTime + dur)
}

/** 正弦波を1発。和音・チャイム用。 */
const tone = (
  c: AudioContext,
  dest: AudioNode,
  freq: number,
  start: number,
  dur: number,
  gain: number,
  type: OscillatorType = 'sine',
) => {
  const o = c.createOscillator()
  o.type = type
  o.frequency.value = freq
  const g = c.createGain()
  const t0 = c.currentTime + start
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  o.connect(g).connect(dest)
  o.start(t0)
  o.stop(t0 + dur + 0.02)
}

/**
 * 牌が卓に当たる音。
 *
 * 乾いた「カッ」にするための要点:
 *   - 減衰を速くする (残響が伸びると湿って聞こえる)
 *   - 低音を削る (低い胴鳴りが強いと「ボッ」という湿った音になる)
 *   - 高めの帯域を立てる (硬い樹脂どうしが当たる成分)
 * 強さと音程を少し散らして、機械的な繰り返しに聞こえないようにする。
 */
const clack = (strength: number) => {
  const c = getCtx()
  if (!c || !master || !enabled) return
  const v = 0.85 + Math.random() * 0.3

  // アタックの芯。短く鋭く切る。
  noiseBurst(c, master, 0.028, 3200 * v, 0.7, 0.55 * strength, 16)
  // 硬さを出す高域。
  noiseBurst(c, master, 0.018, 6800 * v, 1.1, 0.3 * strength, 20)

  // 胴の成分。前より高く・短くして、湿った余韻を残さない。
  const o = c.createOscillator()
  o.type = 'triangle'
  o.frequency.value = 320 * v
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 220 // ボワつく低域を落とす
  const g = c.createGain()
  g.gain.setValueAtTime(0.3 * strength, c.currentTime)
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.035)
  o.connect(hp).connect(g).connect(master)
  o.start()
  o.stop(c.currentTime + 0.04)
}

/*
 * 掛け声は「ピロリン系」のベル音で表す。
 *
 * フォルマント合成で肉声を作る手も試したが、合成音声はどうしても機械的で
 * かえって安っぽくなるため、素直に澄んだベル音にしている。
 * ベルらしさは「基音 + わずかにずれた倍音」を指数減衰させると出る。
 */
const bell = (c: AudioContext, dest: AudioNode, freq: number, start: number, dur: number, gain: number) => {
  const t0 = c.currentTime + start
  const out = c.createGain()
  out.gain.setValueAtTime(0, t0)
  out.gain.linearRampToValueAtTime(gain, t0 + 0.006)
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  out.connect(dest)

  // 基音
  const o1 = c.createOscillator()
  o1.type = 'sine'
  o1.frequency.value = freq
  const g1 = c.createGain()
  g1.gain.value = 1
  o1.connect(g1).connect(out)

  // 倍音を少しずらすと金属的な響きになる
  const o2 = c.createOscillator()
  o2.type = 'sine'
  o2.frequency.value = freq * 2.01
  const g2 = c.createGain()
  g2.gain.value = 0.34
  o2.connect(g2).connect(out)

  const o3 = c.createOscillator()
  o3.type = 'sine'
  o3.frequency.value = freq * 3.02
  const g3 = c.createGain()
  g3.gain.value = 0.12
  o3.connect(g3).connect(out)

  for (const o of [o1, o2, o3]) {
    o.start(t0)
    o.stop(t0 + dur + 0.03)
  }
}

/** 音階を順に鳴らす「ピロリン」。 */
const chime = (notes: number[], step = 0.075, dur = 0.42, gain = 0.2) => {
  const c = getCtx()
  if (!c || !master || !enabled) return
  notes.forEach((f, i) => bell(c, master!, f, 0.02 + i * step, dur, gain))
}

/** 和音を一斉に鳴らす。単音より厚みが出て高級感につながる。 */
const chord = (notes: number[], start: number, dur: number, gain: number) => {
  const c = getCtx()
  if (!c || !master || !enabled) return
  for (const f of notes) bell(c, master!, f, start, dur, gain)
}

// 音名 (Hz)
const C4 = 261.63, G4 = 392, A4 = 440, B4 = 493.88
const C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99, A5 = 880, B5 = 987.77
const C6 = 1046.5, D6 = 1174.7, E6 = 1318.5, G6 = 1568, A6 = 1760
const C7 = 2093, E7 = 2637

/**
 * 仏壇の「おりん」の音。上がったときの「チーン」。
 *
 * おりんは金属の椀なので、倍音が整数比ではなく非整数比 (1 : 2.7 : 5.4 …) で並ぶ。
 * これが澄んだ金属的な響きを生む。減衰は非常に長く、各倍音を少しずつデチューンして
 * 2本重ねると「うなり」が出て、本物のような揺れる余韻になる。
 */
const rin = () => {
  const c = getCtx()
  if (!c || !master || !enabled) return
  const t0 = c.currentTime

  // 撞木で縁を打つ瞬間の、ごく短い金属的アタック。
  noiseBurst(c, master, 0.02, 5200, 1.4, 0.1, 30)

  const fund = 1318.5 // 明るく澄んだ「チーン」(E6 あたり)
  // 椀の非整数倍音。r=比率, g=音量, d=減衰(秒)。上の倍音ほど速く消える。
  const partials = [
    { r: 1, g: 0.5, d: 3.4 },
    { r: 2.76, g: 0.26, d: 2.7 },
    { r: 5.4, g: 0.12, d: 1.9 },
    { r: 8.93, g: 0.05, d: 1.2 },
  ]
  for (const p of partials) {
    // わずかにずらした2本でうなり (揺れる余韻) を作る。
    for (const detune of [-1.2, 1.2]) {
      const o = c.createOscillator()
      o.type = 'sine'
      o.frequency.value = fund * p.r + detune
      const g = c.createGain()
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(p.g * 0.5, t0 + 0.004)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.d)
      o.connect(g).connect(master)
      o.start(t0)
      o.stop(t0 + p.d + 0.05)
    }
  }
}

/**
 * 木魚 (もくぎょ) の音。「ポクッ」という中空の木の響き。SE2 の打牌音。
 * 高い音から低い音へ落とすと、あの丸い中空感が出る。
 */
const mokugyo = (strength = 1) => {
  const c = getCtx()
  if (!c || !master || !enabled) return
  const t0 = c.currentTime
  // 撞木が当たる瞬間の短いアタック。
  noiseBurst(c, master, 0.012, 2200, 1.6, 0.14 * strength, 45)
  // 中空の胴鳴り。高→低へ落として「ポクッ」を作る。少し高めの音程。
  const o = c.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(540, t0)
  o.frequency.exponentialRampToValueAtTime(330, t0 + 0.05)
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 660
  bp.Q.value = 2.2
  const g = c.createGain()
  g.gain.setValueAtTime(0.5 * strength, t0)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09)
  o.connect(bp).connect(g).connect(master)
  o.start(t0)
  o.stop(t0 + 0.12)
}

/**
 * 太鼓の淵 (ふち) を叩く「カッ」。SE2 のポン・リーチ音。
 * 皮ではなく縁を打つので、胴鳴りのない乾いた高域のクラックにする。
 */
const taikoRim = (strength = 1) => {
  const c = getCtx()
  if (!c || !master || !enabled) return
  const t0 = c.currentTime
  // 乾いた高域のクラック。
  noiseBurst(c, master, 0.014, 3600, 2.2, 0.42 * strength, 50)
  noiseBurst(c, master, 0.007, 7200, 2.6, 0.22 * strength, 65)
  // 木の芯 (「カッ」の実体)。低域は削って湿らせない。
  const o = c.createOscillator()
  o.type = 'triangle'
  o.frequency.value = 950
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 550
  const g = c.createGain()
  g.gain.setValueAtTime(0.34 * strength, t0)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.028)
  o.connect(hp).connect(g).connect(master)
  o.start(t0)
  o.stop(t0 + 0.04)
}

/** 流局。下降して沈む2音。両テーマ共通。 */
const drawGameTones = () => {
  const c = getCtx()
  if (!c || !master || !enabled) return
  tone(c, master, 392, 0, 0.32, 0.16)
  tone(c, master, 294, 0.14, 0.42, 0.15)
}

export type SoundTheme = 'se1' | 'se2'

interface Scheme {
  discard: () => void
  draw: () => void
  pon: () => void
  kan: () => void
  riichi: () => void
  ron: () => void
  tsumo: () => void
  draw_game: () => void
}

/**
 * SE1: おりんに変える前の音。牌の音 + 和音 + 音階の上昇 (ピロリーん)。
 * 和了は当時どおり、ロン/ツモの上昇に和了のフレーズを重ねる。
 */
const SE1: Scheme = {
  discard: () => clack(1),
  draw: () => clack(0.45),
  pon: () => {
    clack(1.1)
    chord([A4, C5, E5], 0.03, 0.5, 0.1)
    chime([A5, E6], 0.08, 0.5, 0.17)
  },
  kan: () => {
    clack(1.2)
    chord([G4, B4, D5, G5], 0.03, 0.6, 0.1)
    chime([B5, D6, G6], 0.075, 0.6, 0.17)
  },
  riichi: () => {
    clack(1.1)
    chord([C4, G4, C5], 0.02, 0.9, 0.11)
    chime([C6, E6, G6, C7], 0.075, 0.75, 0.19)
  },
  ron: () => {
    clack(1.25)
    chord([C5, E5, G5], 0.02, 1.0, 0.12)
    chime([G5, C6, E6, G6, C7], 0.06, 0.85, 0.2)
    chord([C6, E6, G6, C7, E7], 0.42, 1.5, 0.07)
    chime([A6], 0.42, 1.4, 0.06)
  },
  tsumo: () => {
    clack(1.25)
    chord([F5, A5, C6], 0.02, 1.0, 0.11)
    chime([C5, E5, G5, C6, E6, G6], 0.055, 0.8, 0.18)
    chord([C6, E6, G6, C7, E7], 0.42, 1.5, 0.07)
    chime([A6], 0.42, 1.4, 0.06)
  },
  draw_game: drawGameTones,
}

/** SE2: 和了=仏壇のおりん / 打牌=木魚 / ポン・カン・リーチ=太鼓の淵「カッ」。 */
const SE2: Scheme = {
  discard: () => mokugyo(1),
  draw: () => mokugyo(0.5),
  pon: () => taikoRim(1.15),
  kan: () => {
    taikoRim(1.2)
    // 少し遅らせてもう1発、「カッカ」でカンらしく。
    setTimeout(() => taikoRim(0.95), 70)
  },
  riichi: () => taikoRim(1.1),
  ron: () => rin(),
  tsumo: () => rin(),
  draw_game: drawGameTones,
}

const SCHEMES: Record<SoundTheme, Scheme> = { se1: SE1, se2: SE2 }
let theme: SoundTheme = 'se2'
export const setSoundTheme = (t: SoundTheme) => {
  theme = t
}
export const getSoundTheme = (): SoundTheme => theme

// 実際に呼ばれる効果音。選択中のテーマへ委譲する。
export const sfx = {
  discard: () => SCHEMES[theme].discard(),
  draw: () => SCHEMES[theme].draw(),
  pon: () => SCHEMES[theme].pon(),
  kan: () => SCHEMES[theme].kan(),
  riichi: () => SCHEMES[theme].riichi(),
  ron: () => SCHEMES[theme].ron(),
  tsumo: () => SCHEMES[theme].tsumo(),
  draw_game: () => SCHEMES[theme].draw_game(),
}
