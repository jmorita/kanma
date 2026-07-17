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

// 音名 (Hz)
const A5 = 880, C6 = 1046.5, D6 = 1174.7, E6 = 1318.5, G6 = 1568, C7 = 2093
const E5 = 659.25, G5 = 783.99, C5 = 523.25

export const sfx = {
  /** 打牌。 */
  discard: () => clack(1),
  /** ツモ (山から取る)。打牌より軽い。 */
  draw: () => clack(0.45),

  /** ポン: 軽い2音。 */
  pon: () => {
    clack(1.1)
    chime([A5, D6], 0.07, 0.34, 0.19)
  },
  /** カン: ポンより1音多く、少し重く。 */
  kan: () => {
    clack(1.15)
    chime([A5, D6, G6], 0.07, 0.38, 0.19)
  },
  /** リーチ: 上昇する明るい4音。 */
  riichi: () => {
    clack(1.1)
    chime([C6, E6, G6, C7], 0.065, 0.5, 0.2)
  },
  /** ロン: 決め手らしく低音から一気に上げる。 */
  ron: () => {
    clack(1.2)
    chime([G5, C6, E6, G6], 0.06, 0.6, 0.22)
  },
  /** ツモ: ロンより柔らかい上昇。 */
  tsumo: () => {
    clack(1.2)
    chime([C5, E5, G5, C6, E6], 0.055, 0.55, 0.2)
  },

  /** 和了時に重ねる余韻。 */
  win: () => {
    const c = getCtx()
    if (!c || !master || !enabled) return
    bell(c, master, C7, 0.34, 0.9, 0.1)
    bell(c, master, G6, 0.34, 0.9, 0.08)
  },
  /** 流局。下降して沈む2音。 */
  draw_game: () => {
    const c = getCtx()
    if (!c || !master || !enabled) return
    tone(c, master, 392, 0, 0.32, 0.16)
    tone(c, master, 294, 0.14, 0.42, 0.15)
  },
}
