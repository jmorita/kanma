import { describe, it, expect } from 'vitest'
import {
  createGame,
  wallRemaining,
  discard,
  turnOptions,
  respondCall,
  declareTsumo,
  declareSelfKan,
  rinshanRemaining,
  deadWallOf,
  seatName,
} from './game'
import { cpuTurnAction, cpuCallResponse } from '../ai/cpu'
import { parseHand, tileFromName, toCounts } from './tiles'

describe('席の呼び名', () => {
  it('親が東家で、そこから南家・西家・北家と続く', () => {
    expect(seatName(0, 4, 0)).toBe('東家')
    expect(seatName(1, 4, 0)).toBe('南家')
    expect(seatName(2, 4, 0)).toBe('西家')
    expect(seatName(3, 4, 0)).toBe('北家')
  })

  it('親が移ると呼び名も移る', () => {
    // 親が seat1 なら seat1 が東家
    expect(seatName(1, 4, 1)).toBe('東家')
    expect(seatName(2, 4, 1)).toBe('南家')
    expect(seatName(0, 4, 1)).toBe('北家')
  })

  it('3人打ちに北家は無い', () => {
    const names = [0, 1, 2].map((s) => seatName(s, 3, 0))
    expect(names).toEqual(['東家', '南家', '西家'])
    expect(names).not.toContain('北家')
  })
})

describe('局の初期化', () => {
  it('全員13枚 + 親が第一ツモ', () => {
    const s = createGame({ seed: 1 })
    expect(s.players).toHaveLength(4)
    expect(s.players[0].hand).toHaveLength(14) // 親 = seat 0
    for (let i = 1; i < s.seatCount; i++) expect(s.players[i].hand).toHaveLength(13)
    expect(s.turn).toBe(0)
    expect(s.phase).toBe('discard')
  })

  it('ドラ表示2枚 + 裏ドラ表示2枚', () => {
    const s = createGame({ seed: 1 })
    expect(s.doraIndicators).toHaveLength(2)
    expect(s.uraIndicators).toHaveLength(2)
  })

  it('王牌8枚を除いたツモ山は76枚 (4人打ち)', () => {
    const s = createGame({ seed: 1 })
    // 136 - 52(配牌) - 8(王牌: 嶺上4 + ドラ表示2 + 裏ドラ表示2) = 76。親の第一ツモを引いて75。
    expect(wallRemaining(s)).toBe(75)
    expect(rinshanRemaining(s)).toBe(4)
  })

  it('王牌は嶺上4枚 + ドラ表示2枚 + 裏ドラ表示2枚の8枚', () => {
    const s = createGame({ seed: 1 })
    const dw = deadWallOf(s)
    expect(dw.rinshan).toHaveLength(4)
    expect(dw.dora).toHaveLength(2)
    expect(dw.ura).toHaveLength(2)
    // ドラ表示・裏ドラ表示は王牌の該当位置と一致する
    expect(dw.dora).toEqual(s.doraIndicators)
    expect(dw.ura).toEqual(s.uraIndicators)
  })

  it('カンしても嶺上牌が減るだけで、ツモ山は減らない', () => {
    const s = createGame({ seed: 1 })
    s.players[0].hand = parseHand('1111m234m567m99p1p')
    const before = wallRemaining(s)
    expect(declareSelfKan(s, 0, tileFromName('1m'))).toBe(true)
    expect(wallRemaining(s)).toBe(before) // ツモ山は変わらない
    expect(rinshanRemaining(s)).toBe(3) // 嶺上牌が1枚減る
  })

  it('同じシードなら同じ局になる', () => {
    const a = createGame({ seed: 42 })
    const b = createGame({ seed: 42 })
    expect(a.players[0].hand).toEqual(b.players[0].hand)
    expect(a.doraIndicators).toEqual(b.doraIndicators)
  })
})

describe('局の進行', () => {
  it('打牌すると次の席にツモが回る', () => {
    const s = createGame({ seed: 7 })
    const tile = s.players[0].hand[0]
    const before = wallRemaining(s)
    expect(discard(s, 0, tile)).toBe(true)
    // 誰も鳴かなければ手番が進む
    if (s.phase === 'discard') {
      expect(s.turn).toBe(1)
      expect(s.players[1].hand).toHaveLength(14)
      expect(wallRemaining(s)).toBe(before - 1)
    }
  })

  it('手番でない席は打牌できない', () => {
    const s = createGame({ seed: 7 })
    expect(discard(s, 1, s.players[1].hand[0])).toBe(false)
  })

  it('チーは存在しない', () => {
    const s = createGame({ seed: 3 })
    discard(s, 0, s.players[0].hand[0])
    for (const c of s.pendingCalls) {
      expect(c.options).not.toContain('chi')
    }
  })
})

describe('リーチ宣言牌の横向き', () => {
  it('宣言牌が鳴かれたら、次に切る牌を代わりに横に置く', () => {
    const s = createGame({ seed: 5 })
    // seat0 をテンパイにして 3p でリーチ宣言させる
    s.players[0].hand = parseHand('234m678m99p123s45s3p')
    // seat1 は 3p を2枚持ちなのでポンできる
    s.players[1].hand = parseHand('33p456m789m123s45s')
    for (const i of [2, 3]) s.players[i].hand = parseHand('147m258p369s1234z')

    expect(discard(s, 0, tileFromName('3p'), true)).toBe(true)
    expect(s.players[0].riichi).toBe(true)
    expect(s.players[0].riichiTileIndex).toBe(0) // 河の1枚目が横向き

    // その宣言牌をポンされると、河から消えて目印が無くなる
    respondCall(s, 1, 'pon')
    expect(s.players[0].discards).toHaveLength(0)
    expect(s.players[0].riichiTileIndex).toBeNull()
    expect(s.players[0].riichiMarkPending).toBe(true)

    // seat0 の次の打牌が代わりに横向きになる
    while (s.phase === 'discard' && s.turn !== 0) {
      discard(s, s.turn, turnOptions(s, s.turn).discardable[0])
    }
    expect(s.turn).toBe(0)
    discard(s, 0, s.drawnTile!)
    expect(s.players[0].riichiTileIndex).toBe(s.players[0].discards.length - 1)
    expect(s.players[0].riichiMarkPending).toBe(false)
  })

  it('宣言牌より後の牌が鳴かれても、宣言牌の横向きは動かない', () => {
    const s = createGame({ seed: 5 })
    s.players[0].hand = parseHand('234m678m99p123s45s3p')
    for (const i of [1, 2, 3]) s.players[i].hand = parseHand('147m258p369s1234z')
    discard(s, 0, tileFromName('3p'), true)
    expect(s.players[0].riichiTileIndex).toBe(0)

    // 一巡して seat0 がもう1枚切る (ツモ切り)
    while (s.phase === 'discard' && s.turn !== 0) {
      discard(s, s.turn, turnOptions(s, s.turn).discardable[0])
    }
    discard(s, 0, s.drawnTile!)
    // 宣言牌は河の1枚目のまま
    expect(s.players[0].riichiTileIndex).toBe(0)
    expect(s.players[0].discards.length).toBeGreaterThan(1)
  })
})

describe('食い替え', () => {
  /** seat1 に 3p を3枚持たせ、seat0 の 3p をポンさせる。手に3pが1枚残る。 */
  const ponned = () => {
    const s = createGame({ seed: 5 })
    s.players[0].hand = parseHand('123m456m789m123p3p')
    s.players[1].hand = parseHand('333p456m789m123s4s')
    for (const i of [2, 3]) s.players[i].hand = parseHand('147m258p369s1234z')
    discard(s, 0, tileFromName('3p'))
    respondCall(s, 1, 'pon')
    return s
  }

  it('ポンした牌と同じ牌は切れない', () => {
    const s = ponned()
    expect(s.turn).toBe(1)
    expect(s.kuikae).toBe(tileFromName('3p'))
    // 手には3pがまだ1枚あるが、切ろうとしても弾かれる
    expect(s.players[1].hand).toContain(tileFromName('3p'))
    expect(discard(s, 1, tileFromName('3p'))).toBe(false)
    expect(turnOptions(s, 1).discardable).not.toContain(tileFromName('3p'))
  })

  it('ポンした牌以外は切れる', () => {
    const s = ponned()
    expect(turnOptions(s, 1).discardable).toContain(tileFromName('4m'))
    expect(discard(s, 1, tileFromName('4m'))).toBe(true)
    expect(s.kuikae).toBeNull() // 打牌したら制限は解ける
  })

  it('ツモった後の打牌は食い替えにならない', () => {
    const s = ponned()
    discard(s, 1, tileFromName('4m')) // ポン後の1打
    // 一巡してツモ番が戻れば、3pも切れるようになる
    while (s.phase === 'discard' && s.turn !== 1) {
      discard(s, s.turn, turnOptions(s, s.turn).discardable[0])
    }
    if (s.phase === 'discard' && s.turn === 1) {
      expect(s.kuikae).toBeNull()
      expect(turnOptions(s, 1).discardable).toContain(tileFromName('3p'))
    }
  })

  it('CPUも食い替えの牌を選ばない', () => {
    const s = ponned()
    const a = cpuTurnAction(s, 1)
    if (a.kind === 'discard') expect(a.tile).not.toBe(tileFromName('3p'))
  })
})

describe('同巡の見逃し (韓麻にフリテンは無いが同巡のみロン不可)', () => {
  /**
   * seat2 (対面) に 3p 待ちのテンパイを持たせ、seat0 に 3p を切らせる。
   * seat0 の下家である seat1 はすぐツモ番が来てしまうので、見逃しの検証には使えない。
   * seat1/3 は 3p にも他の牌にも反応しないバラバラの手にしておく
   * (誰かに鳴きの候補があると、全員の応答が揃うまで解決処理が走らないため)。
   */
  const setup = () => {
    const s = createGame({ seed: 5 })
    s.players[0].hand = parseHand('123m456m789m123p3p') // 3p を2枚持ち、1枚切る
    s.players[2].hand = parseHand('234m678m99p123s12p') // 3p で和了
    for (const i of [1, 3]) s.players[i].hand = parseHand('147m258p369s1234z')
    return s
  }

  it('見逃すと同巡のうちはロンできなくなる', () => {
    const s = setup()
    discard(s, 0, tileFromName('3p'))
    expect(s.pendingCalls.find((c) => c.seat === 2)?.options).toContain('ron')

    respondCall(s, 2, 'pass') // 見逃す
    expect(s.players[2].missedRon).toBe(true)

    // 同巡のうちに seat1 が 3p を切っても、seat2 はロンできない
    expect(s.turn).toBe(1)
    s.players[1].hand[s.players[1].hand.length - 1] = tileFromName('3p')
    discard(s, 1, tileFromName('3p'))
    expect(s.pendingCalls.find((c) => c.seat === 2)?.options ?? []).not.toContain('ron')
  })

  it('自分のツモ番が来ると見逃しは解除される', () => {
    const s = setup()
    discard(s, 0, tileFromName('3p'))
    respondCall(s, 2, 'pass')
    expect(s.players[2].missedRon).toBe(true)

    // seat1 が打ち、seat2 のツモ番が来ると解除される
    expect(s.turn).toBe(1)
    discard(s, 1, s.players[1].hand[0])
    expect(s.turn).toBe(2)
    expect(s.players[2].missedRon).toBe(false)
  })

  it('ロンすれば見逃しにはならない', () => {
    const s = setup()
    discard(s, 0, tileFromName('3p'))
    respondCall(s, 2, 'ron')
    expect(s.result?.winner).toBe(2)
    expect(s.players[2].missedRon).toBe(false)
  })
})

describe('裏ドラ', () => {
  // 234m 678m 99p 123s 789s: 5(赤)を含まない4メンツ1雀頭
  const HAND = '234m678m99p123s789s'

  it('リーチして和了ると裏ドラ2枚がめくれ、点数に乗る', () => {
    const s = createGame({ seed: 1 })
    s.doraIndicators = [tileFromName('東'), tileFromName('東')] // ドラは南 → 手牌に無い
    s.uraIndicators = [tileFromName('8p'), tileFromName('8p')] // 裏ドラは9p → 手牌に2枚
    s.players[0].hand = parseHand(HAND)
    s.players[0].riichi = true
    expect(declareTsumo(s, 0)).toBe(true)

    const r = s.result!
    expect(r.uraIndicators).toHaveLength(2)
    // ツモ2 + リーチ2 + 裏ドラ4 (9p2枚 × 表示牌2枚) = 8点
    expect(r.score!.perPayer).toBe(8)
    expect(r.score!.parts).toContainEqual({ label: 'ドラ', count: 4, points: 4 })
  })

  it('リーチしていなければ裏ドラは乗らず、めくられもしない', () => {
    const s = createGame({ seed: 1 })
    s.doraIndicators = [tileFromName('東'), tileFromName('東')]
    s.uraIndicators = [tileFromName('8p'), tileFromName('8p')]
    s.players[0].hand = parseHand(HAND)
    expect(declareTsumo(s, 0)).toBe(true)

    const r = s.result!
    expect(r.uraIndicators).toHaveLength(0)
    expect(r.score!.perPayer).toBe(2) // ツモ2のみ
  })
})

describe('ポンの提示', () => {
  it('2枚持っている他家にはポンが提示される', () => {
    const s = createGame({ seed: 5 })
    s.players[0].hand = parseHand('123m456m789m123p3p') // 14枚、3pを切る
    s.players[1].hand = parseHand('33p456m789m123s45s') // 13枚、3pを2枚持ち
    expect(discard(s, 0, tileFromName('3p'))).toBe(true)
    const pc = s.pendingCalls.find((c) => c.seat === 1)
    expect(pc?.options).toContain('pon')
  })

  it('3枚持ちならポンとカンの両方が出る', () => {
    const s = createGame({ seed: 5 })
    s.players[0].hand = parseHand('123m456m789m123p3p')
    s.players[1].hand = parseHand('333p456m789m123s4s')
    discard(s, 0, tileFromName('3p'))
    const pc = s.pendingCalls.find((c) => c.seat === 1)
    expect(pc?.options).toContain('pon')
    expect(pc?.options).toContain('minkan')
  })

  it('リーチ中はポンできない', () => {
    const s = createGame({ seed: 5 })
    s.players[0].hand = parseHand('123m456m789m123p3p')
    s.players[1].hand = parseHand('33p456m789m123s45s')
    s.players[1].riichi = true
    discard(s, 0, tileFromName('3p'))
    const pc = s.pendingCalls.find((c) => c.seat === 1)
    expect(pc?.options ?? []).not.toContain('pon')
  })

  it('1枚しか持っていなければポンは出ない', () => {
    const s = createGame({ seed: 5 })
    s.players[0].hand = parseHand('123m456m789m123p3p')
    s.players[1].hand = parseHand('3p456m789m123s456s')
    discard(s, 0, tileFromName('3p'))
    const pc = s.pendingCalls.find((c) => c.seat === 1)
    expect(pc?.options ?? []).not.toContain('pon')
  })

  it('実戦の進行でも、2枚持ちの非リーチ者には必ずポンが提示される', () => {
    // CPU同士で回し、打牌のたびに「ポンが出るべき席に出ているか」を検査する。
    let checked = 0
    for (let seed = 1; seed <= 20; seed++) {
      const s = createGame({ seed })
      let guard = 0
      while (s.phase !== 'end') {
        if (++guard > 2000) throw new Error('局が終わらない')

        if (s.phase === 'call') {
          const d = s.lastDiscard!
          for (let i = 0; i < s.seatCount; i++) {
            if (i === d.seat) continue
            const p = s.players[i]
            const holds = toCounts(p.hand)[d.tile]
            const pc = s.pendingCalls.find((c) => c.seat === i)
            if (holds >= 2 && !p.riichi) {
              expect(pc, `seat${i} は ${d.tile} を${holds}枚持つのに応答枠が無い`).toBeDefined()
              expect(pc!.options, `seat${i} にポンが出ていない`).toContain('pon')
              checked++
            }
          }
          const c = s.pendingCalls.find((x) => x.response === null)!
          respondCall(s, c.seat, cpuCallResponse(s, c.seat, c.options))
          continue
        }

        const a = cpuTurnAction(s, s.turn)
        if (a.kind === 'tsumo') declareTsumo(s, s.turn)
        else if (a.kind === 'kan') declareSelfKan(s, s.turn, a.tile)
        else discard(s, s.turn, a.tile, a.riichi)
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})

describe('3人打ち', () => {
  it('3人でも136枚を使い、配牌は39枚', () => {
    const s = createGame({ seed: 1, seatCount: 3 })
    expect(s.wall).toHaveLength(136)
    expect(s.players).toHaveLength(3)
    // 136 - 39(配牌) - 8(王牌) = 89。親の第一ツモを引いて88。
    expect(wallRemaining(s)).toBe(88)
  })

  it('4人打ちよりツモ番が多い', () => {
    expect(wallRemaining(createGame({ seed: 1, seatCount: 3 }))).toBeGreaterThan(
      wallRemaining(createGame({ seed: 1, seatCount: 4 })),
    )
  })

  it('ツモの支払いは2人ぶんになる', () => {
    const s = createGame({ seed: 1, seatCount: 3 })
    // 4メンツ1雀頭を直接組んでツモらせる (ドラ・リーチなし)
    s.players[0].hand = parseHand('234m678m123p789p11s')
    s.drawnTile = s.players[0].hand[13]
    expect(declareTsumo(s, 0)).toBe(true)
    const r = s.result!
    expect(r.deltas).toHaveLength(3)
    expect(r.deltas.reduce((a, b) => a + b, 0)).toBe(0)
    // 支払いは2人 → 収入は perPayer × 2
    expect(r.score!.total).toBe(r.score!.perPayer * 2)
  })
})

/** CPUだけで1局を最後まで回す。 */
const playOut = (seed: number, seatCount = 4) => {
  const s = createGame({ seed, seatCount })
  let guard = 0
  while (s.phase !== 'end') {
    if (++guard > 2000) throw new Error('局が終わらない')

    if (s.phase === 'call') {
      for (const c of s.pendingCalls) {
        if (c.response === null) {
          respondCall(s, c.seat, cpuCallResponse(s, c.seat, c.options))
          break
        }
      }
      continue
    }

    const a = cpuTurnAction(s, s.turn)
    if (a.kind === 'tsumo') {
      declareTsumo(s, s.turn)
    } else if (a.kind === 'kan') {
      declareSelfKan(s, s.turn, a.tile)
    } else {
      discard(s, s.turn, a.tile, a.riichi)
    }
  }
  return s
}

describe('CPU同士で1局を完走できる (4人打ち)', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('seed %i', (seed) => {
    const s = playOut(seed, 4)
    expect(s.result).not.toBeNull()
    // 点数の増減は必ずゼロサム
    expect(s.result!.deltas.reduce((a, b) => a + b, 0)).toBe(0)
    // カンは4回まで
    expect(s.kanCount).toBeLessThanOrEqual(4)
    // 1人の支払いは20点まで
    for (const d of s.result!.deltas) expect(d).toBeGreaterThanOrEqual(-20)
  })
})

describe('CPU同士で1局を完走できる (3人打ち)', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('seed %i', (seed) => {
    const s = playOut(seed, 3)
    expect(s.result).not.toBeNull()
    expect(s.result!.deltas).toHaveLength(3)
    expect(s.result!.deltas.reduce((a, b) => a + b, 0)).toBe(0)
    for (const d of s.result!.deltas) expect(d).toBeGreaterThanOrEqual(-20)
  })
})

describe('リーチ', () => {
  it('鳴いている手ではリーチできない', () => {
    const s = createGame({ seed: 11 })
    s.players[0].melds.push({ kind: 'pon', tile: 0, from: 1 })
    expect(turnOptions(s, 0).riichiTiles).toHaveLength(0)
  })
})
