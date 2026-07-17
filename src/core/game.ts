/**
 * 韓麻の局進行。
 *
 * 一局精算・半荘なしなので、状態は「1局」で完結する。
 * 親は第一ツモを取るだけの意味しかなく、席替えも無い。
 */
import {
  buildWall,
  toCounts,
  tileName,
  type Tile,
} from './tiles'
import { agariShape, waitingTiles, isTenpai, type AgariShape } from './agari'
import { makeRng, shuffle, type Rng } from './rng'
import { DEFAULT_RULES, doraTilesFrom, scoreHand, type Rules, type ScoreBreakdown } from './score'

export type Seat = number

export type MeldKind = 'pon' | 'ankan' | 'minkan' | 'kakan'

export interface Meld {
  kind: MeldKind
  tile: Tile
  /** 誰から鳴いたか。暗槓は null。 */
  from: Seat | null
}

export interface Player {
  seat: Seat
  hand: Tile[]
  melds: Meld[]
  discards: Tile[]
  /**
   * 各捨て牌が手出し (true) かツモ切り (false) か。discards と同じ長さで並ぶ。
   * ツモ切り = その巡に引いた牌をそのまま切ったこと (tile === drawnTile)。
   * 鳴いた直後などツモ無しの打牌は手出し扱い。
   */
  tedashi: boolean[]
  riichi: boolean
  /** リーチ宣言牌の捨て牌インデックス (横向き表示用)。 */
  riichiTileIndex: number | null
  /**
   * リーチ宣言牌が鳴かれて河から無くなった状態。
   * 麻雀の慣習どおり、次に切る牌を代わりに横に置く。
   */
  riichiMarkPending: boolean
  /**
   * 同巡の見逃し。韓麻にフリテンは無いが、同巡のみ見逃しロンができない。
   * ロンを見送った時点で立ち、次の自分のツモで解除される。
   * (リーチ後の見逃しも同巡だけの制限で、恒久フリテンにはならない)
   */
  missedRon: boolean
  score: number
  isCpu: boolean
}

/** 誰の入力を待っているか。 */
export type Phase =
  | 'discard' // turn の手番。打牌 or ツモ/カン/リーチ
  | 'call' // 直前の打牌に対する鳴き/ロンの応答待ち
  | 'end'

export type CallOption = 'ron' | 'pon' | 'minkan' | 'pass'

export interface PendingCall {
  seat: Seat
  options: CallOption[]
  /** null = 未応答。 */
  response: CallOption | null
}

export type EndReason = 'tsumo' | 'ron' | 'exhaustive' | 'kanLimit'

export interface HandResult {
  reason: EndReason
  winner: Seat | null
  loser: Seat | null
  shape: AgariShape | null
  score: ScoreBreakdown | null
  /**
   * 和了牌。ロンのときは和了者の手牌に含まれないので、表示時に補うために持つ。
   * ツモのときは手牌に含まれている。
   */
  winningTile: Tile | null
  /** 各席の増減。 */
  deltas: number[]
  uraIndicators: Tile[]
}

export interface GameState {
  /** 3人打ち or 4人打ち。韓麻はどちらも136枚を使う。 */
  seatCount: number
  players: Player[]
  wall: Tile[]
  /** 次にツモる山のインデックス。 */
  drawIndex: number
  /** 嶺上牌として山の後ろから取った枚数。 */
  rinshanTaken: number
  doraIndicators: Tile[]
  uraIndicators: Tile[]
  dealer: Seat
  turn: Seat
  phase: Phase
  /** 直前に切られた牌 (call フェーズ中のみ有効)。 */
  lastDiscard: { seat: Seat; tile: Tile } | null
  pendingCalls: PendingCall[]
  /** 直前のツモ牌 (discard フェーズ中、その巡でツモっていれば)。 */
  drawnTile: Tile | null
  /** 直前のツモが嶺上牌だったか。 */
  drawnFromRinshan: boolean
  /**
   * 食い替えで切れない牌。ポンした直後の打牌でのみ立つ。
   * (韓麻にチーは無いので、鳴いた牌と同じ牌を切る現物の食い替えだけが対象)
   */
  kuikae: Tile | null
  kanCount: number
  result: HandResult | null
  log: string[]
  rules: Rules
  rng: Rng
}

const HAND_SIZE = 13
/** 嶺上牌の枚数。カンの上限4回と一致する。 */
const RINSHAN_COUNT = 4
/** 王牌 = 嶺上牌4枚 + ドラ表示2枚 + 裏ドラ表示2枚 = 8枚。 */
const DEAD_WALL = RINSHAN_COUNT + 4

/**
 * 席の呼び名。親を東家とし、そこから順に南家・西家・北家。
 * 3人打ちは3席しかないので北家は存在しない。
 * 親は局ごとに移るので、同じ席でも局によって呼び名が変わる。
 */
const WINDS = ['東家', '南家', '西家', '北家']

export const seatName = (s: Seat, seatCount = 4, dealer = 0): string => {
  const rel = ((s - dealer) % seatCount + seatCount) % seatCount
  return WINDS[rel] ?? `P${s}`
}

export const calledMeldCount = (p: Player): number => p.melds.length

/** 手牌 + 副露の全牌 (ドラを数える対象)。カンは4枚とも数える。 */
export const allTilesOf = (p: Player): Tile[] => {
  const out = [...p.hand]
  for (const m of p.melds) {
    const n = m.kind === 'pon' ? 3 : 4
    for (let i = 0; i < n; i++) out.push(m.tile)
  }
  return out
}

/**
 * 山に残っているツモ可能枚数。王牌8枚は含まない。
 * 嶺上牌は王牌の中の専用4枚なので、カンしてもここは減らない。
 */
export const wallRemaining = (s: GameState): number => s.wall.length - DEAD_WALL - s.drawIndex

/** 残っている嶺上牌の枚数。 */
export const rinshanRemaining = (s: GameState): number => RINSHAN_COUNT - s.rinshanTaken

/** 王牌の並び (表示用)。嶺上牌4枚 + ドラ表示2枚 + 裏ドラ表示2枚。 */
export const deadWallOf = (s: GameState): { rinshan: Tile[]; dora: Tile[]; ura: Tile[] } => {
  const n = s.wall.length
  return {
    rinshan: s.wall.slice(n - DEAD_WALL, n - 4),
    dora: [s.wall[n - 4], s.wall[n - 3]],
    ura: [s.wall[n - 2], s.wall[n - 1]],
  }
}

export const createGame = (
  opts: { seed?: number; startScore?: number; dealer?: Seat; seatCount?: number; rules?: Rules } = {},
): GameState => {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31)
  const rng = makeRng(seed)
  const wall = shuffle(buildWall(), rng)
  const seatCount = opts.seatCount ?? 4
  const dealer = (opts.dealer ?? 0) % seatCount

  const players: Player[] = []
  let idx = 0
  for (let s = 0; s < seatCount; s++) {
    players.push({
      seat: s,
      hand: wall.slice(idx, idx + HAND_SIZE).sort((a, b) => a - b),
      melds: [],
      discards: [],
      tedashi: [],
      riichi: false,
      riichiTileIndex: null,
      riichiMarkPending: false,
      missedRon: false,
      score: opts.startScore ?? 0,
      isCpu: s !== 0,
    })
    idx += HAND_SIZE
  }

  // 山の末尾8枚が王牌。前4枚が嶺上牌、続く2枚がドラ表示、最後の2枚が裏ドラ表示。
  const doraIndicators = [wall[wall.length - 4], wall[wall.length - 3]]
  const uraIndicators = [wall[wall.length - 2], wall[wall.length - 1]]

  const state: GameState = {
    seatCount,
    players,
    wall,
    drawIndex: idx,
    rinshanTaken: 0,
    doraIndicators,
    uraIndicators,
    dealer,
    turn: dealer,
    phase: 'discard',
    lastDiscard: null,
    pendingCalls: [],
    drawnTile: null,
    drawnFromRinshan: false,
    kuikae: null,
    kanCount: 0,
    result: null,
    log: [],
    rules: opts.rules ?? DEFAULT_RULES,
    rng,
  }

  state.log.push(
    `${seatCount}人打ち 局開始 (seed=${seed}) ドラ表示: ${doraIndicators.map(tileName).join(' ')}`,
  )
  drawFor(state, dealer) // 親の第一ツモ
  return state
}

const drawFor = (s: GameState, seat: Seat): void => {
  const tile = s.wall[s.drawIndex++]
  takeTile(s, seat, tile)
  s.drawnFromRinshan = false
}

const drawRinshan = (s: GameState, seat: Seat): void => {
  // 嶺上牌は王牌の中の専用4枚。ツモ山からは取らないので、山の残りは減らない。
  const tile = s.wall[s.wall.length - DEAD_WALL + s.rinshanTaken]
  s.rinshanTaken++
  takeTile(s, seat, tile)
  s.drawnFromRinshan = true
}

/**
 * ツモ牌を手に加える。理牌済みの手牌の末尾に置き、ツモ牌だけを分けて表示できるようにする
 * (リーチ後のツモ切り判定にも使う)。
 */
const takeTile = (s: GameState, seat: Seat, tile: Tile): void => {
  const p = s.players[seat]
  sortHand(p)
  p.hand.push(tile)
  // 同巡の見逃しは自分のツモまで。ツモった時点で解除される。
  p.missedRon = false
  // ツモってからの打牌は食い替えにならない。
  s.kuikae = null
  s.drawnTile = tile
  s.turn = seat
  s.phase = 'discard'
}

/** 理牌。萬子 → 筒子 → 索子 → 字牌 の順に並べる。 */
const sortHand = (p: Player) => p.hand.sort((a, b) => a - b)

const doraForWin = (s: GameState, riichi: boolean): Tile[] =>
  doraTilesFrom(riichi ? [...s.doraIndicators, ...s.uraIndicators] : s.doraIndicators)

/** ツモ和了。 */
export const declareTsumo = (s: GameState, seat: Seat): boolean => {
  const p = s.players[seat]
  const shape = agariShape(toCounts(p.hand), calledMeldCount(p))
  if (!shape) return false

  const riichi = p.riichi
  const score = scoreHand(
    {
      shape,
      allTiles: allTilesOf(p),
      byTsumo: true,
      riichi,
      doraTiles: doraForWin(s, riichi),
      rules: s.rules,
    },
    s.seatCount - 1,
  )

  const deltas = new Array(s.seatCount).fill(0)
  for (let i = 0; i < s.seatCount; i++) {
    if (i === seat) deltas[i] = score.total
    else deltas[i] = -score.perPayer
  }
  applyResult(s, {
    reason: 'tsumo',
    winner: seat,
    loser: null,
    shape,
    score,
    winningTile: s.drawnTile,
    deltas,
    uraIndicators: riichi ? s.uraIndicators : [],
  })
  return true
}

const applyResult = (s: GameState, r: HandResult): void => {
  for (let i = 0; i < s.seatCount; i++) s.players[i].score += r.deltas[i]
  s.result = r
  s.phase = 'end'
  if (r.winner !== null && r.score) {
    const detail = r.score.parts.map((x) => `${x.label}`).join(' + ')
    s.log.push(
      `${seatName(r.winner, s.seatCount, s.dealer)} ${r.reason === 'tsumo' ? 'ツモ' : 'ロン'} ${detail} = ${r.score.perPayer}点` +
        (r.reason === 'tsumo' ? ` × ${s.seatCount - 1} = ${r.score.total}点` : '') +
        (r.score.capped ? ' (上限適用)' : ''),
    )
  } else {
    s.log.push('流局')
  }
}

/** ロン和了。 */
export const declareRon = (s: GameState, seat: Seat): boolean => {
  if (!s.lastDiscard) return false
  const p = s.players[seat]
  const counts = toCounts([...p.hand, s.lastDiscard.tile])
  const shape = agariShape(counts, calledMeldCount(p))
  if (!shape) return false

  const riichi = p.riichi
  const score = scoreHand(
    {
      shape,
      allTiles: [...allTilesOf(p), s.lastDiscard.tile],
      byTsumo: false,
      riichi,
      doraTiles: doraForWin(s, riichi),
      rules: s.rules,
    },
    s.seatCount - 1,
  )

  const deltas = new Array(s.seatCount).fill(0)
  deltas[seat] = score.total
  deltas[s.lastDiscard.seat] = -score.total

  applyResult(s, {
    reason: 'ron',
    winner: seat,
    loser: s.lastDiscard.seat,
    shape,
    score,
    winningTile: s.lastDiscard.tile,
    deltas,
    uraIndicators: riichi ? s.uraIndicators : [],
  })
  return true
}

/** その席が今カンできる牌 (暗槓・加槓)。 */
export const selfKanOptions = (s: GameState, seat: Seat): Tile[] => {
  if (s.kanCount >= s.rules.maxKansPerHand) return []
  const p = s.players[seat]
  const counts = toCounts(p.hand)
  const out: Tile[] = []

  for (let t = 0; t < 34; t++) {
    if (counts[t] !== 4) continue
    // リーチ後の暗槓は、ツモった牌で槓が成立し、かつ待ちが変わらない場合のみ許す。
    if (p.riichi && (s.drawnTile !== t || !ankanKeepsWait(p, t))) continue
    out.push(t)
  }
  // 加槓: ポン済みの牌を手牌から足す。リーチ後は不可 (手牌が固定されるため)。
  if (!p.riichi) {
    for (const m of p.melds) {
      if (m.kind === 'pon' && counts[m.tile] >= 1) out.push(m.tile)
    }
  }
  return out
}

/** リーチ後の暗槓が待ちを変えないか。 */
const ankanKeepsWait = (p: Player, tile: Tile): boolean => {
  const called = calledMeldCount(p)
  // ツモ牌を含む14枚から、暗槓する4枚を除いた10枚(+新メンツ)で待ちを比べる。
  const before = p.hand.filter((t) => t !== tile)
  const withoutDrawn = p.hand.slice()
  const di = withoutDrawn.lastIndexOf(tile)
  if (di >= 0) withoutDrawn.splice(di, 1)

  const waitBefore = waitingTiles(toCounts(withoutDrawn), called)
  const after = before
  const waitAfter = waitingTiles(toCounts(after), called + 1)
  if (waitBefore.length !== waitAfter.length) return false
  return waitBefore.every((t, i) => t === waitAfter[i])
}

/** 暗槓 or 加槓。 */
export const declareSelfKan = (s: GameState, seat: Seat, tile: Tile): boolean => {
  if (!selfKanOptions(s, seat).includes(tile)) return false
  const p = s.players[seat]
  const counts = toCounts(p.hand)
  const existingPon = p.melds.find((m) => m.kind === 'pon' && m.tile === tile)

  if (counts[tile] === 4) {
    p.hand = p.hand.filter((t) => t !== tile)
    p.melds.push({ kind: 'ankan', tile, from: null })
    s.log.push(`${seatName(seat, s.seatCount, s.dealer)} 暗槓 ${tileName(tile)}`)
  } else if (existingPon) {
    const i = p.hand.indexOf(tile)
    p.hand.splice(i, 1)
    existingPon.kind = 'kakan'
    s.log.push(`${seatName(seat, s.seatCount, s.dealer)} 加槓 ${tileName(tile)}`)
  } else {
    return false
  }
  sortHand(p)

  s.kanCount++
  // 嶺上牌は王牌の専用4枚なので、ツモ山が尽きていても引ける。
  drawRinshan(s, seat)
  return true
}

/** リーチ宣言。門前かつテンパイのときのみ。供託は無い。 */
export const canRiichi = (s: GameState, seat: Seat): boolean => {
  const p = s.players[seat]
  if (p.riichi) return false
  if (p.melds.some((m) => m.kind !== 'ankan')) return false // 暗槓のみ門前を保つ
  if (s.turn !== seat || s.phase !== 'discard') return false
  if (wallRemaining(s) <= 0) return false
  return riichiDiscards(s, seat).length > 0
}

/** リーチ宣言可能な打牌 (それを切ればテンパイになる牌)。 */
export const riichiDiscards = (s: GameState, seat: Seat): Tile[] => {
  const p = s.players[seat]
  const called = calledMeldCount(p)
  const out: Tile[] = []
  const seen = new Set<Tile>()
  for (const t of p.hand) {
    if (seen.has(t)) continue
    seen.add(t)
    const rest = p.hand.slice()
    rest.splice(rest.indexOf(t), 1)
    if (isTenpai(toCounts(rest), called)) out.push(t)
  }
  return out
}

/** 打牌。riichi=true ならリーチ宣言を伴う。 */
export const discard = (s: GameState, seat: Seat, tile: Tile, riichi = false): boolean => {
  if (s.phase !== 'discard' || s.turn !== seat) return false
  const p = s.players[seat]
  const i = p.hand.indexOf(tile)
  if (i < 0) return false
  // リーチ後はツモ切りのみ。
  if (p.riichi && s.drawnTile !== null && tile !== s.drawnTile) return false
  // ポンした牌と同じ牌は切れない (食い替え)。
  if (s.kuikae !== null && tile === s.kuikae) return false
  if (riichi && !riichiDiscards(s, seat).includes(tile)) return false

  // ツモ切り = その巡に引いた牌をそのまま切った。ツモが無い (鳴き後の打牌) なら手出し。
  const isTedashi = s.drawnTile === null || tile !== s.drawnTile
  p.hand.splice(i, 1)
  sortHand(p)
  s.kuikae = null
  p.discards.push(tile)
  p.tedashi.push(isTedashi)
  if (riichi) {
    p.riichi = true
    p.riichiTileIndex = p.discards.length - 1
    s.log.push(`${seatName(seat, s.seatCount, s.dealer)} リーチ (打 ${tileName(tile)})`)
  } else if (p.riichiMarkPending) {
    // 宣言牌が鳴かれていたので、この牌を代わりに横に置く。
    p.riichiTileIndex = p.discards.length - 1
    p.riichiMarkPending = false
  }
  s.lastDiscard = { seat, tile }
  s.drawnTile = null

  openCallWindow(s)
  return true
}

/** 打牌に対して鳴き/ロンの候補がある席を集める。無ければ次の席へ進める。 */
const openCallWindow = (s: GameState): void => {
  const d = s.lastDiscard!
  const pending: PendingCall[] = []

  for (let off = 1; off < s.seatCount; off++) {
    const seat = (d.seat + off) % s.seatCount
    const p = s.players[seat]
    const options: CallOption[] = []
    const called = calledMeldCount(p)

    // ロン: フリテンが無いので、形になっていれば常にアガれる。
    // ただし同巡に見逃していると、次の自分のツモまでロンできない。
    if (!p.missedRon && agariShape(toCounts([...p.hand, d.tile]), called)) options.push('ron')

    // リーチ中は鳴けない。
    if (!p.riichi) {
      const n = toCounts(p.hand)[d.tile]
      if (n >= 2) options.push('pon')
      if (n >= 3 && s.kanCount < s.rules.maxKansPerHand) options.push('minkan')
    }

    if (options.length > 0) {
      options.push('pass')
      pending.push({ seat, options, response: null })
    }
  }

  if (pending.length === 0) {
    advanceTurn(s)
    return
  }
  s.pendingCalls = pending
  s.phase = 'call'
}

/** 鳴き/ロンへの応答。全員の応答が揃ったら解決する。 */
export const respondCall = (s: GameState, seat: Seat, response: CallOption): boolean => {
  if (s.phase !== 'call') return false
  const pc = s.pendingCalls.find((c) => c.seat === seat)
  if (!pc || !pc.options.includes(response)) return false
  pc.response = response
  if (s.pendingCalls.every((c) => c.response !== null)) resolveCalls(s)
  return true
}

const resolveCalls = (s: GameState): void => {
  const d = s.lastDiscard!

  // ロンできたのにしなかった席は「同巡の見逃し」になる。
  for (const c of s.pendingCalls) {
    if (c.options.includes('ron') && c.response !== 'ron') s.players[c.seat].missedRon = true
  }

  // ロン優先。ダブロン・トリロンは頭ハネ (放銃者から見て手番が近い席が総取り)。
  const rons = s.pendingCalls.filter((c) => c.response === 'ron')
  if (rons.length > 0) {
    const winner = rons
      .map((c) => ({ c, dist: (c.seat - d.seat + s.seatCount) % s.seatCount }))
      .sort((a, b) => a.dist - b.dist)[0].c
    if (rons.length > 1) s.log.push(`頭ハネ: ${seatName(winner.seat, s.seatCount, s.dealer)} が総取り`)
    s.pendingCalls = []
    declareRon(s, winner.seat)
    return
  }

  const kan = s.pendingCalls.find((c) => c.response === 'minkan')
  const pon = s.pendingCalls.find((c) => c.response === 'pon')
  const caller = kan ?? pon
  if (!caller) {
    s.pendingCalls = []
    advanceTurn(s)
    return
  }

  const p = s.players[caller.seat]
  const kind: MeldKind = kan ? 'minkan' : 'pon'
  const need = kan ? 3 : 2
  for (let i = 0; i < need; i++) p.hand.splice(p.hand.indexOf(d.tile), 1)
  sortHand(p)
  p.melds.push({ kind, tile: d.tile, from: d.seat })
  // 鳴かれた牌は捨て牌から取り除く。手出し/ツモ切りの記録も揃えて外す。
  const discarder = s.players[d.seat]
  discarder.discards.pop()
  discarder.tedashi.pop()
  // 取り除いたのがリーチ宣言牌だと、横向きの目印が河から消えてしまう。
  // 麻雀の慣習どおり、次に切る牌を代わりに横に置く。
  if (discarder.riichiTileIndex !== null && discarder.riichiTileIndex >= discarder.discards.length) {
    discarder.riichiTileIndex = null
    discarder.riichiMarkPending = true
  }
  s.log.push(`${seatName(caller.seat, s.seatCount, s.dealer)} ${kan ? '大明槓' : 'ポン'} ${tileName(d.tile)}`)

  s.pendingCalls = []
  s.lastDiscard = null

  if (kan) {
    s.kanCount++
    drawRinshan(s, caller.seat)
  } else {
    // ポンは打牌から始まる (ツモらない)。
    // 直後に同じ牌を切る「食い替え」は禁止。
    s.kuikae = d.tile
    s.turn = caller.seat
    s.drawnTile = null
    s.phase = 'discard'
  }
}

const advanceTurn = (s: GameState): void => {
  s.lastDiscard = null
  if (wallRemaining(s) <= 0) {
    endExhaustive(s)
    return
  }
  drawFor(s, (s.turn + 1) % s.seatCount)
}

const endExhaustive = (s: GameState): void => {
  // ノーテン罰符は無い。
  applyResult(s, {
    reason: 'exhaustive',
    winner: null,
    loser: null,
    shape: null,
    score: null,
    winningTile: null,
    deltas: new Array(s.seatCount).fill(0),
    uraIndicators: [],
  })
}

/** 手番の席が今できること。 */
export interface TurnOptions {
  canTsumo: boolean
  riichiTiles: Tile[]
  kanTiles: Tile[]
  discardable: Tile[]
}

export const turnOptions = (s: GameState, seat: Seat): TurnOptions => {
  if (s.phase !== 'discard' || s.turn !== seat) {
    return { canTsumo: false, riichiTiles: [], kanTiles: [], discardable: [] }
  }
  const p = s.players[seat]
  const canTsumo =
    s.drawnTile !== null && agariShape(toCounts(p.hand), calledMeldCount(p)) !== null
  // リーチ後はツモ切りのみ。食い替えの牌は選べない。
  const discardable = (
    p.riichi && s.drawnTile !== null ? [s.drawnTile] : [...new Set(p.hand)]
  ).filter((t) => t !== s.kuikae)
  return {
    canTsumo,
    riichiTiles: canRiichi(s, seat) ? riichiDiscards(s, seat) : [],
    kanTiles: selfKanOptions(s, seat),
    discardable,
  }
}

